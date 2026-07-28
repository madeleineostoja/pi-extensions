import { RecoverySafetyError } from "./recovery-service.js";
import { WorkerPacketError } from "./worker-invocation.js";
import { MissingHookEvidenceError } from "./publication.js";
import type { ExecutionPlan } from "./execution-plan.js";
import {
  TargetBoundaryError,
  TargetPreconditionError,
  WorkstreamCandidateLifecycleError,
} from "./workstream-candidate.js";
import {
  StateError,
  StaleRevisionError,
  type RunState,
  type RunStore,
} from "./store.js";
import {
  activeLeaseFor,
  activeWorkerLeaseCount,
  allSourceWorkstreamsComplete,
  getWorkstream,
  hasIntegrationLease,
  isStoppingSettlementEvent,
  reduceRunEvent,
  runtimeWorkstreams,
  sameWorkstream,
  selectReadyRuntimeWorkstreams,
  type RuntimeWorkstream,
  type SchedulerEffect,
  type SchedulerEvent,
} from "./scheduler.js";

type ProcessLease = RunState["processLeases"][string];

export type EffectExecution = (args: {
  effect: SchedulerEffect;
  signal: AbortSignal;
  dispatch: (event: SchedulerEvent) => Promise<void>;
}) => Promise<void>;

export type PlannerExecution = (args: {
  signal: AbortSignal;
}) => Promise<ExecutionPlan>;

export type SchedulerActorOptions = {
  store: RunStore;
  executeEffect?: EffectExecution;
  executePlanner?: PlannerExecution;
  onTransition?: (
    state: RunState,
    event: SchedulerEvent | { kind: "planner_bound" },
  ) => void;
  awaitOwnedProcesses?: () => Promise<void>;
  targetHead?: () => Promise<string>;
  targetDiff?: (from: string, to: string) => Promise<string>;
  captureTargetBoundary?: () => Promise<string>;
  now?: () => string;
};

export class SchedulerActor {
  private readonly controller = new AbortController();
  private readonly processes = new Map<string, Promise<void>>();
  private readonly processControllers = new Map<string, AbortController>();
  private readonly processWorkstreams = new Map<string, RuntimeWorkstream>();
  private readonly now: () => string;
  private queue = Promise.resolve();
  private drivePromise: Promise<void> | undefined;
  private stopping = false;
  private safetyReason: string | undefined;
  private pauseReason: string | undefined;

  constructor(private readonly options: SchedulerActorOptions) {
    this.now = options.now ?? (() => new Date().toISOString());
  }

  snapshot(): RunState {
    return this.options.store.read();
  }

  async start(): Promise<void> {
    await this.reconcileAbandonedProcesses();
    if (this.snapshot().wholePlanReview.recovery?.status === "running") {
      await this.persist({ kind: "whole_plan_recovery_abandoned" });
    }
    if (
      this.snapshot().phase === "stopping" &&
      Object.keys(this.snapshot().processLeases).length === 0
    ) {
      await this.persist({ kind: "run_paused" });
    }
    await this.drive();
  }

  async drive(): Promise<void> {
    if (this.drivePromise) {
      return this.drivePromise;
    }
    this.drivePromise = (async () => {
      while (!this.stopping && !this.pauseReason) {
        const next = this.nextDriveStep();
        if (!next) {
          return;
        }
        if (next.kind === "planner") {
          this.startPlanner();
          return;
        }
        if (next.kind === "effect") {
          this.startEffect(next.effect);
          return;
        }
        await this.persist(await this.withAssignedRuntimeBases(next.event));
      }
    })().finally(() => {
      this.drivePromise = undefined;
    });
    return this.drivePromise;
  }

  async quiesce(): Promise<void> {
    await this.queue;
    await this.drive();
    await this.queue;
  }

  async schedule(): Promise<boolean> {
    const before = Object.keys(this.snapshot().processLeases).length;
    await this.drive();
    return Object.keys(this.snapshot().processLeases).length > before;
  }

  async dispatch(
    event: SchedulerEvent,
    sourceEffect?: SchedulerEffect,
  ): Promise<SchedulerEffect[]> {
    const { effects, persistedEvent } = await this.persist(event, sourceEffect);
    if (
      persistedEvent?.kind === "recovery_completed" &&
      persistedEvent.action.kind === "no_safe_action"
    ) {
      this.pauseReason = persistedEvent.action.evidence;
      for (const controller of this.processControllers.values()) {
        controller.abort();
      }
    }
    await this.drive();
    return effects;
  }

  private async persist(
    event: SchedulerEvent,
    sourceEffect?: SchedulerEffect,
  ): Promise<{
    effects: SchedulerEffect[];
    persistedEvent: SchedulerEvent | undefined;
  }> {
    const operation = this.queue.then(async () => {
      for (;;) {
        const current = this.options.store.read();
        let eventToPersist = event;
        if (
          sourceEffect &&
          current.phase === "stopping" &&
          !isStoppingSettlementEvent(event)
        ) {
          const sourceLeaseId =
            "leaseId" in sourceEffect ? sourceEffect.leaseId : undefined;
          const sourceLease = sourceLeaseId
            ? current.processLeases[sourceLeaseId]
            : undefined;
          if (
            !sourceLeaseId ||
            !sourceLease ||
            sourceLease.kind !== effectLeaseKind(sourceEffect)
          ) {
            return { effects: [], persistedEvent: undefined };
          }
          eventToPersist = {
            kind: "process_abandoned",
            leaseId: sourceLeaseId,
          };
        }
        const transition = reduceRunEvent(current, eventToPersist);
        if (!transition.accepted) {
          throw new SchedulerActorError(
            transition.error ?? `Reducer rejected ${eventToPersist.kind}.`,
          );
        }
        try {
          const state = await this.options.store.update(
            current.revision,
            () => transition.state,
          );
          try {
            this.options.onTransition?.(state, eventToPersist);
          } catch {
            // Projection callbacks are not state authority.
          }
          for (const effect of transition.effects) {
            this.startEffect(effect);
          }
          return {
            effects: transition.effects,
            persistedEvent: eventToPersist,
          };
        } catch (error) {
          if (error instanceof StaleRevisionError) {
            continue;
          }
          throw error;
        }
      }
    });
    this.queue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  private async withAssignedRuntimeBases(
    event: SchedulerEvent,
  ): Promise<SchedulerEvent> {
    if (event.kind !== "workstreams_selected") {
      return event;
    }
    const state = this.snapshot();
    const unassigned = selectReadyRuntimeWorkstreams(state).filter(
      (workstream): workstream is { kind: "source"; id: string } =>
        workstream.kind === "source" &&
        state.workstreams.source[workstream.id]?.baseSha === undefined,
    );
    if (unassigned.length === 0) {
      return event;
    }
    const baseSha = this.options.targetHead
      ? await this.options.targetHead()
      : state.run.checkout.startHead;
    const staleDependency = unassigned
      .flatMap(
        (workstream) => state.workstreams.source[workstream.id]!.dependsOn,
      )
      .find((dependencyId) => {
        const dependency = state.workstreams.source[dependencyId];
        const candidate = dependency?.candidateId
          ? state.candidates[dependency.candidateId]
          : undefined;
        return (
          dependency?.phase === "completed" &&
          candidate?.commitSha === candidate?.baseSha &&
          (() => {
            const receipts = Object.values(state.satisfaction.receipts).filter(
              (receipt) => receipt.candidateId === candidate?.id,
            );
            return (
              receipts.length > 0 &&
              !receipts.some((receipt) => receipt.assessedTargetSha === baseSha)
            );
          })()
        );
      });
    if (staleDependency) {
      const dependency = state.workstreams.source[staleDependency]!;
      const candidate = state.candidates[dependency.candidateId!]!;
      return {
        kind: "satisfaction_reassessment_requested",
        workstream: { kind: "source", id: staleDependency },
        targetSha: baseSha,
        interveningDiff: this.options.targetDiff
          ? await this.options.targetDiff(candidate.baseSha, baseSha)
          : "",
      };
    }
    return {
      ...event,
      baseShas: Object.fromEntries(
        unassigned.map((workstream) => [workstream.id, baseSha]),
      ),
    };
  }

  private hasLiveProcessFor(workstream: RuntimeWorkstream): boolean {
    return [...this.processWorkstreams.values()].some((active) =>
      sameWorkstream(active, workstream),
    );
  }

  private nextDriveStep():
    | { kind: "planner" }
    | { kind: "effect"; effect: SchedulerEffect }
    | { kind: "event"; event: SchedulerEvent }
    | undefined {
    const state = this.snapshot();
    if (state.phase === "planning") {
      return this.processes.has("planner") ? undefined : { kind: "planner" };
    }
    if (
      !this.options.executeEffect ||
      !["running", "whole_plan_review"].includes(state.phase)
    ) {
      return undefined;
    }

    for (const intent of Object.values(state.publication.intents)) {
      const workstream = getWorkstream(state, intent.workstream);
      if (
        state.publication.receipts[intent.id] &&
        workstream?.phase === "approved" &&
        workstream.candidateId === intent.candidateId
      ) {
        return {
          kind: "event",
          event: {
            kind: "publication_requested",
            workstream: intent.workstream,
            intentId: intent.id,
            now: this.now(),
          },
        };
      }
    }

    for (const episode of Object.values(state.recoveryEpisodes)) {
      if (
        this.processWorkstreams.size < state.run.workerConcurrency &&
        activeWorkerLeaseCount(state) < state.run.workerConcurrency &&
        episode.status === "open" &&
        getWorkstream(state, episode.workstream)?.phase === "recovering" &&
        !Object.values(state.processLeases).some(
          (lease) => lease.recoveryEpisodeId === episode.id,
        ) &&
        !this.hasLiveProcessFor(episode.workstream)
      ) {
        return {
          kind: "event",
          event: {
            kind: "recovery_requested",
            workstream: episode.workstream,
            now: this.now(),
          },
        };
      }
    }

    if (activeWorkerLeaseCount(state) === 0 && this.processes.size === 0) {
      for (const debt of state.projectionDebt) {
        const effect = { kind: "run_projection" as const, debtId: debt.id };
        if (!this.processes.has(effectKey(effect))) {
          return { kind: "effect", effect };
        }
      }
    }

    if (
      !hasIntegrationLease(state) &&
      (state.projectionDebt.length === 0 || this.processes.size === 0) &&
      this.processWorkstreams.size < state.run.workerConcurrency &&
      activeWorkerLeaseCount(state) < state.run.workerConcurrency
    ) {
      const review = runtimeWorkstreams(state).find(
        (workstream) =>
          getWorkstream(state, workstream)?.phase === "candidate_ready" &&
          !activeLeaseFor(state, workstream) &&
          !this.hasLiveProcessFor(workstream),
      );
      if (review) {
        return {
          kind: "event",
          event: {
            kind: "review_requested",
            workstream: review,
            now: this.now(),
          },
        };
      }

      if (selectReadyRuntimeWorkstreams(state).length > 0) {
        return {
          kind: "event",
          event: {
            kind: "workstreams_selected",
            now: this.now(),
            baseShas: {},
          },
        };
      }
    }

    const approved = runtimeWorkstreams(state).find((workstream) => {
      const runtime = getWorkstream(state, workstream);
      if (
        runtime?.phase !== "approved" ||
        runtime.candidateId === undefined ||
        activeLeaseFor(state, workstream) ||
        this.hasLiveProcessFor(workstream)
      ) {
        return false;
      }
      return true;
    });
    if (
      approved &&
      activeWorkerLeaseCount(state) === 0 &&
      this.processes.size === 0
    ) {
      const candidateId = getWorkstream(state, approved)!.candidateId!;
      const intent = Object.values(state.publication.intents).find(
        (entry) =>
          sameWorkstream(entry.workstream, approved) &&
          entry.candidateId === candidateId,
      );
      return {
        kind: "event",
        event: intent
          ? {
              kind: "publication_requested",
              workstream: approved,
              intentId: intent.id,
              now: this.now(),
            }
          : {
              kind: "reconciliation_requested",
              workstream: approved,
              now: this.now(),
            },
      };
    }

    if (
      state.phase === "whole_plan_review" &&
      state.wholePlanReview.recovery?.status === "open"
    ) {
      return {
        kind: "event",
        event: { kind: "whole_plan_recovery_requested" },
      };
    }
    if (
      state.wholePlanReview.status === "pending" &&
      state.projectionDebt.length === 0 &&
      allSourceWorkstreamsComplete(state) &&
      state.wholePlanReview.recovery?.status !== "open" &&
      state.wholePlanReview.recovery?.status !== "running"
    ) {
      return { kind: "event", event: { kind: "whole_plan_review_requested" } };
    }
    if (
      state.phase === "whole_plan_review" &&
      state.wholePlanReview.status === "reviewing" &&
      !this.processes.has("run_whole_plan_review")
    ) {
      return { kind: "effect", effect: { kind: "run_whole_plan_review" } };
    }
    if (
      state.phase === "whole_plan_review" &&
      state.wholePlanReview.status === "approved" &&
      !this.processes.has("complete_whole_plan_run")
    ) {
      return { kind: "effect", effect: { kind: "complete_whole_plan_run" } };
    }
    return undefined;
  }

  async resume(): Promise<void> {
    if (this.options.captureTargetBoundary) {
      await this.options.captureTargetBoundary();
    }
    await this.persist({ kind: "resume_requested" });
    await this.drive();
  }

  async stop(reason?: string): Promise<void> {
    if (!this.stopping) {
      this.stopping = true;
      if (
        ["planning", "running", "whole_plan_review"].includes(
          this.snapshot().phase,
        )
      ) {
        await this.dispatch({ kind: "stop_requested", reason });
      }
      this.controller.abort();
      for (const controller of this.processControllers.values()) {
        controller.abort();
      }
    }
    while (this.processes.size > 0) {
      await Promise.allSettled(this.processes.values());
    }
    await this.options.awaitOwnedProcesses?.();
    await this.reconcileAbandonedProcesses();
    if (this.snapshot().phase === "stopping") {
      await this.dispatch({ kind: "run_paused", reason });
    }
  }

  async settle(): Promise<void> {
    for (;;) {
      if (this.processes.size > 0) {
        await Promise.allSettled(this.processes.values());
      }
      if (this.processes.size === 0 && !(await this.schedule())) {
        return;
      }
    }
  }

  private startPlanner(): void {
    if (!this.options.executePlanner || this.processes.has("planner")) {
      return;
    }
    const controller = linkedAbortController(this.controller.signal);
    this.processControllers.set("planner", controller);
    const process = this.options
      .executePlanner({ signal: controller.signal })
      .then(async (plan) => {
        if (controller.signal.aborted) {
          return;
        }
        const state = await this.options.store.bindExecutionPlan(plan);
        try {
          this.options.onTransition?.(state, { kind: "planner_bound" });
        } catch {
          // Projection callbacks are not state authority.
        }
        await this.schedule();
      })
      .catch(async (error) => {
        if (
          !controller.signal.aborted &&
          this.snapshot().phase === "planning"
        ) {
          await this.dispatch({
            kind: "planner_failed",
            reason: error instanceof Error ? error.message : String(error),
          });
        }
      })
      .finally(() => {
        this.processes.delete("planner");
        this.processControllers.delete("planner");
      });
    this.processes.set("planner", process);
  }

  private startEffect(effect: SchedulerEffect): void {
    if (this.stopping || this.pauseReason || !this.options.executeEffect) {
      return;
    }
    const key = effectKey(effect);
    if (this.processes.has(key)) {
      return;
    }
    const controller = linkedAbortController(this.controller.signal);
    this.processControllers.set(key, controller);
    if ("workstream" in effect) {
      this.processWorkstreams.set(key, effect.workstream);
    }
    const process = Promise.resolve()
      .then(async () => {
        const managed =
          effect.kind === "run_implementation" ||
          effect.kind === "run_review" ||
          effect.kind === "run_recovery" ||
          effect.kind === "run_whole_plan_review" ||
          effect.kind === "run_whole_plan_recovery";
        const boundary =
          managed && this.options.captureTargetBoundary
            ? await this.options.captureTargetBoundary()
            : undefined;
        if (
          effect.kind === "run_implementation" &&
          effect.workstream.kind === "source" &&
          boundary !== undefined
        ) {
          const boundaryHead = JSON.parse(boundary).head;
          const baseSha =
            this.snapshot().workstreams.source[effect.workstream.id]?.baseSha;
          if (typeof boundaryHead !== "string" || boundaryHead !== baseSha) {
            throw new TargetBoundaryError(
              "Target moved before the assigned workstream base could start.",
            );
          }
        }
        let executionError: unknown;
        try {
          await this.options.executeEffect!({
            effect,
            signal: controller.signal,
            dispatch: async (event) => {
              await this.dispatch(event, effect);
            },
          });
        } catch (error) {
          executionError = error;
        }
        if (boundary !== undefined) {
          let currentBoundary: string;
          try {
            currentBoundary = await this.options.captureTargetBoundary!();
          } catch (error) {
            if (error instanceof TargetPreconditionError) {
              throw new TargetBoundaryError(
                `A managed agent changed the target checkout boundary. ${error.message}`,
              );
            }
            throw error;
          }
          if (boundary !== currentBoundary) {
            throw new TargetBoundaryError(
              "A managed agent changed the target checkout boundary.",
            );
          }
        }
        if (executionError) {
          throw executionError;
        }
      })
      .catch(async (error) => {
        if (error instanceof TargetPreconditionError) {
          this.pauseReason = error.message;
          for (const controller of this.processControllers.values()) {
            controller.abort();
          }
          return;
        }
        if (error instanceof TargetBoundaryError) {
          this.safetyReason = error.message;
          this.stopping = true;
          this.controller.abort();
          for (const controller of this.processControllers.values()) {
            controller.abort();
          }
          return;
        }
        if (
          error instanceof SchedulerActorError ||
          error instanceof StateError ||
          error instanceof WorkerPacketError
        ) {
          this.pauseReason = error.message;
          for (const controller of this.processControllers.values()) {
            controller.abort();
          }
          return;
        }
        if (
          effect.kind === "run_implementation" &&
          this.snapshot().processLeases[effect.leaseId]
        ) {
          const lifecycleError =
            error instanceof WorkstreamCandidateLifecycleError
              ? error
              : undefined;
          await this.dispatch({
            kind: "implementation_failed",
            workstream: effect.workstream,
            leaseId: effect.leaseId,
            evidence: error instanceof Error ? error.message : String(error),
            ...(lifecycleError?.trustedCheckpoint
              ? { trustedCheckpoint: lifecycleError.trustedCheckpoint }
              : {}),
            ...(lifecycleError?.trustedCandidate
              ? { trustedCandidate: lifecycleError.trustedCandidate }
              : {}),
            ...(lifecycleError?.recoveryWorkspace
              ? { workspace: lifecycleError.recoveryWorkspace }
              : {}),
            ...(!lifecycleError ? { executionFailure: true } : {}),
          });
          return;
        }
        if (
          effect.kind === "run_recovery" &&
          error instanceof RecoverySafetyError &&
          this.snapshot().processLeases[effect.leaseId]
        ) {
          await this.dispatch({
            kind: "recovery_completed",
            workstream: effect.workstream,
            leaseId: effect.leaseId,
            action: {
              kind: "no_safe_action",
              outcome: "no_safe_action",
              summary:
                "Recovery output could not satisfy the durable safety boundary.",
              evidence: error.message,
              at: this.now(),
            },
          });
          return;
        }
        if (
          effect.kind === "run_recovery" &&
          this.snapshot().processLeases[effect.leaseId]
        ) {
          await this.dispatch({
            kind: "recovery_execution_failed",
            workstream: effect.workstream,
            leaseId: effect.leaseId,
            error: error instanceof Error ? error.message : String(error),
            now: this.now(),
          });
          return;
        }
        if (
          effect.kind === "run_whole_plan_recovery" &&
          this.snapshot().phase === "whole_plan_review"
        ) {
          await this.dispatch({
            kind: "whole_plan_recovery_failed",
            evidence: error instanceof Error ? error.message : String(error),
          });
          return;
        }
        if (
          effect.kind === "run_whole_plan_review" &&
          this.snapshot().phase === "whole_plan_review"
        ) {
          await this.dispatch({
            kind: "whole_plan_review_failed",
            evidence: error instanceof Error ? error.message : String(error),
          });
          return;
        }
        if (
          effect.kind === "run_projection" ||
          effect.kind === "complete_whole_plan_run"
        ) {
          await this.dispatch({
            kind: "safety_paused",
            reason: error instanceof Error ? error.message : String(error),
          });
          return;
        }
        if (
          (effect.kind === "run_review" ||
            effect.kind === "run_reconciliation" ||
            effect.kind === "run_publication") &&
          this.snapshot().processLeases[effect.leaseId]
        ) {
          await this.dispatch({
            kind: "effect_failed",
            ...(error instanceof MissingHookEvidenceError
              ? { gateKind: "hook" }
              : { executionFailure: true }),
            effect:
              effect.kind === "run_review"
                ? "review"
                : effect.kind === "run_reconciliation"
                  ? "reconciliation"
                  : "publication",
            workstream: effect.workstream,
            leaseId: effect.leaseId,
            evidence: error instanceof Error ? error.message : String(error),
          });
        }
      })
      .finally(async () => {
        this.processes.delete(key);
        this.processControllers.delete(key);
        this.processWorkstreams.delete(key);
        const leaseId = "leaseId" in effect ? effect.leaseId : undefined;
        const lease = leaseId
          ? this.snapshot().processLeases[leaseId]
          : undefined;
        if (leaseId && lease && lease.kind === effectLeaseKind(effect)) {
          await this.persist({ kind: "process_abandoned", leaseId });
        }
        if (
          effect.kind === "run_whole_plan_recovery" &&
          this.snapshot().wholePlanReview.recovery?.status === "running"
        ) {
          await this.persist({ kind: "whole_plan_recovery_abandoned" });
        }
        if (this.safetyReason && this.processes.size === 0) {
          await this.persist({
            kind: "safety_blocked",
            reason: this.safetyReason,
          });
          return;
        }
        if (this.pauseReason && this.processes.size === 0) {
          const reason = this.pauseReason;
          this.pauseReason = undefined;
          await this.persist(
            this.snapshot().phase === "stopping"
              ? { kind: "run_paused", reason }
              : { kind: "safety_paused", reason },
          );
          return;
        }
        await this.drive();
      });
    this.processes.set(key, process);
  }

  private async reconcileAbandonedProcesses(): Promise<void> {
    for (const lease of Object.values(this.snapshot().processLeases)) {
      await this.persist({ kind: "process_abandoned", leaseId: lease.id });
    }
  }
}

export class SchedulerActorError extends Error {}

function effectKey(effect: SchedulerEffect): string {
  if ("leaseId" in effect) {
    return `${effect.kind}:${effect.leaseId}`;
  }
  if ("debtId" in effect) {
    return `${effect.kind}:${effect.debtId}`;
  }
  return effect.kind;
}

function effectLeaseKind(
  effect: SchedulerEffect,
): ProcessLease["kind"] | undefined {
  if (effect.kind === "run_implementation") {
    return "implementation";
  }
  if (effect.kind === "run_review") {
    return "review";
  }
  if (effect.kind === "run_recovery") {
    return "recovery";
  }
  if (effect.kind === "run_reconciliation") {
    return "reconciliation";
  }
  if (effect.kind === "run_publication") {
    return "publication";
  }
  return undefined;
}

function linkedAbortController(parent: AbortSignal): AbortController {
  const controller = new AbortController();
  if (parent.aborted) {
    controller.abort();
  } else {
    parent.addEventListener("abort", () => controller.abort(), { once: true });
  }
  return controller;
}
