import { ReconciliationFailure } from "../reconciliation.js";
import { RevisionFailure } from "../revision.js";
import { WorkerPacketError } from "../worker-invocation.js";
import {
  ReviewEpochMismatchError,
  ReviewWorkspaceSafetyError,
} from "../review.js";
import { PublicationError } from "../publication.js";
import type { ExecutionPlan } from "../execution-plan.js";
import {
  TargetBoundaryError,
  TargetPreconditionError,
  WorkstreamCandidateLifecycleError,
} from "../workstream-candidate.js";
import {
  StateError,
  StaleRevisionError,
  type RunState,
  type RunStore,
} from "../store.js";
import {
  activeLeaseFor,
  activeWorkerLeaseCount,
  allSourceWorkstreamsComplete,
  getWorkstream,
  hasIntegrationLease,
  isStoppingSettlementEvent,
  reduceRunEvent,
  runCanSettleIncomplete,
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

  constructor(private readonly options: SchedulerActorOptions) {
    this.now = options.now ?? (() => new Date().toISOString());
  }

  snapshot(): RunState {
    return this.options.store.read();
  }

  async start(): Promise<void> {
    if (this.snapshot().phase === "stopping") {
      await this.finalizeFailure();
      return;
    }
    await this.drive();
  }

  async drive(): Promise<void> {
    if (this.drivePromise) {
      return this.drivePromise;
    }
    this.drivePromise = (async () => {
      while (!this.stopping) {
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
        const { persistedEvent } = await this.persist(
          await this.withAssignedRuntimeBases(next.event),
          undefined,
          next.expectedRevision,
        );
        if (next.expectedRevision !== undefined && !persistedEvent) {
          return;
        }
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
    const { effects } = await this.persist(event, sourceEffect);
    if (this.snapshot().phase === "stopping") {
      this.stopping = true;
      this.controller.abort();
      for (const controller of this.processControllers.values()) {
        controller.abort();
      }
    }
    await this.finalizeFailure();
    await this.drive();
    return effects;
  }

  private async persist(
    event: SchedulerEvent,
    sourceEffect?: SchedulerEffect,
    expectedRevision?: number,
  ): Promise<{
    effects: SchedulerEffect[];
    persistedEvent: SchedulerEvent | undefined;
  }> {
    const operation = this.queue.then(async () => {
      for (;;) {
        const current = this.options.store.read();
        if (
          expectedRevision !== undefined &&
          current.revision !== expectedRevision
        ) {
          return { effects: [], persistedEvent: undefined };
        }
        let eventToPersist = event;
        if (
          sourceEffect &&
          ["failed", "incomplete", "completed"].includes(current.phase)
        ) {
          return { effects: [], persistedEvent: undefined };
        }
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
        if (
          eventToPersist.kind === "run_failed" &&
          current.phase === "failed"
        ) {
          return { effects: [], persistedEvent: undefined };
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
      return {
        kind: "satisfaction_reassessment_requested",
        workstream: { kind: "source", id: staleDependency },
        targetSha: baseSha,
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
    | {
        kind: "event";
        event: SchedulerEvent;
        expectedRevision?: number;
      }
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
        state.publication.supersessions[intent.id] === undefined &&
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

    for (const recreation of Object.values(state.workspaceRecreations)) {
      if (
        recreation.status === "pending" &&
        this.processWorkstreams.size < state.run.workerConcurrency &&
        activeWorkerLeaseCount(state) < state.run.workerConcurrency &&
        !this.hasLiveProcessFor(recreation.workstream)
      ) {
        return {
          kind: "event",
          event: {
            kind: "workspace_recreation_requested",
            id: recreation.id,
            now: this.now(),
          },
        };
      }
    }

    for (const assignment of Object.values(state.reconciliationAssignments)) {
      if (
        assignment.status === "pending" &&
        getWorkstream(state, assignment.workstream)?.phase ===
          "reconciliation_required" &&
        !activeLeaseFor(state, assignment.workstream) &&
        !this.hasLiveProcessFor(assignment.workstream) &&
        !hasIntegrationLease(state) &&
        activeWorkerLeaseCount(state) === 0 &&
        this.processes.size === 0
      ) {
        return {
          kind: "event",
          event: {
            kind: "reconciliation_assignment_requested",
            workstream: assignment.workstream,
            now: this.now(),
          },
        };
      }
    }

    for (const assignment of Object.values(state.revisionAssignments)) {
      if (
        this.processWorkstreams.size < state.run.workerConcurrency &&
        activeWorkerLeaseCount(state) < state.run.workerConcurrency &&
        assignment.status === "open" &&
        getWorkstream(state, assignment.workstream)?.phase === "revising" &&
        !activeLeaseFor(state, assignment.workstream) &&
        !this.hasLiveProcessFor(assignment.workstream)
      ) {
        return {
          kind: "event",
          event: {
            kind: "revision_requested",
            workstream: assignment.workstream,
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
          state.publication.supersessions[entry.id] === undefined &&
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
      !hasIntegrationLease(state) &&
      state.projectionDebt.length === 0 &&
      this.processWorkstreams.size < state.run.workerConcurrency &&
      activeWorkerLeaseCount(state) < state.run.workerConcurrency &&
      selectReadyRuntimeWorkstreams(state).length > 0
    ) {
      return {
        kind: "event",
        event: {
          kind: "workstreams_selected",
          now: this.now(),
          baseShas: {},
        },
        expectedRevision: state.revision,
      };
    }

    if (
      state.wholePlanReview.status === "pending" &&
      state.projectionDebt.length === 0 &&
      allSourceWorkstreamsComplete(state) &&
      Object.values(state.workstreams.overall).every(
        (workstream) => workstream.phase === "completed",
      ) &&
      state.wholePlanReview.reviewRetry?.status !== "exhausted"
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
    if (runCanSettleIncomplete(state) && this.processes.size === 0) {
      return { kind: "event", event: { kind: "run_incomplete" } };
    }
    return undefined;
  }

  async stop(
    reason = "Stopped by user.",
    category: NonNullable<RunState["failure"]>["category"] = "stopped",
  ): Promise<void> {
    await this.fail(category, reason);
    while (this.processes.size > 0) {
      await Promise.allSettled(this.processes.values());
    }
    await this.options.awaitOwnedProcesses?.();
    await this.reconcileAbandonedProcesses();
    await this.finalizeFailure();
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
      .finally(async () => {
        this.processes.delete("planner");
        this.processControllers.delete("planner");
        await this.finalizeFailure();
      });
    this.processes.set("planner", process);
  }

  private startEffect(effect: SchedulerEffect): void {
    if (this.stopping || !this.options.executeEffect) {
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
    let finalSettlementAttempted = false;
    const process = Promise.resolve()
      .then(async () => {
        const managed =
          effect.kind === "run_implementation" ||
          effect.kind === "run_revision" ||
          effect.kind === "run_reconciliation_worker" ||
          effect.kind === "run_review" ||
          effect.kind === "run_whole_plan_review";
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
              if (isFinalSettlementForEffect(event, effect)) {
                finalSettlementAttempted = true;
              }
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
        if (
          error instanceof TargetPreconditionError ||
          error instanceof TargetBoundaryError
        ) {
          await this.fail("workspace_unsafe", error.message);
          return;
        }
        if (
          error instanceof SchedulerActorError ||
          error instanceof StateError
        ) {
          await this.fail("persistence_runtime_failure", error.message);
          return;
        }
        if (
          error instanceof PublicationError &&
          (error.outcome.kind === "safety_paused" ||
            error.outcome.kind === "target_moved")
        ) {
          await this.fail(
            error.outcome.kind === "target_moved"
              ? "target_moved"
              : "publication_uncertain",
            error.message,
          );
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
            ...(lifecycleError?.trustedCandidate
              ? { trustedCandidate: lifecycleError.trustedCandidate }
              : {}),
            ...(lifecycleError?.observation
              ? { observation: lifecycleError.observation }
              : {}),
            category:
              lifecycleError?.category ??
              (error instanceof WorkerPacketError
                ? "protocol_failure"
                : "provider_failure"),
          });
          return;
        }
        if (
          effect.kind === "run_reconciliation_worker" &&
          this.snapshot().processLeases[effect.leaseId]
        ) {
          const failure =
            error instanceof ReconciliationFailure ? error : undefined;
          await this.dispatch({
            kind: "reconciliation_worker_failed",
            workstream: effect.workstream,
            leaseId: effect.leaseId,
            assignmentId: effect.assignmentId,
            category:
              failure?.category ??
              (error instanceof WorkerPacketError
                ? "protocol_failure"
                : "provider_failure"),
            evidence: error instanceof Error ? error.message : String(error),
            ...(failure?.observation
              ? { observation: failure.observation }
              : {}),
          });
          return;
        }
        if (
          effect.kind === "run_revision" &&
          this.snapshot().processLeases[effect.leaseId]
        ) {
          const failure = error instanceof RevisionFailure ? error : undefined;
          await this.dispatch({
            kind: "revision_failed",
            workstream: effect.workstream,
            leaseId: effect.leaseId,
            assignmentId: effect.assignmentId,
            category:
              failure?.category ??
              (error instanceof WorkerPacketError
                ? "protocol_failure"
                : "provider_failure"),
            evidence: error instanceof Error ? error.message : String(error),
            ...(failure?.observation
              ? { observation: failure.observation }
              : {}),
          });
          return;
        }
        if (
          effect.kind === "run_whole_plan_review" &&
          this.snapshot().phase === "whole_plan_review"
        ) {
          await this.dispatch({
            kind: "whole_plan_review_failed",
            category:
              error instanceof WorkerPacketError
                ? "protocol_failure"
                : "provider_failure",
            evidence: error instanceof Error ? error.message : String(error),
          });
          return;
        }
        if (
          effect.kind === "run_projection" ||
          effect.kind === "complete_whole_plan_run"
        ) {
          await this.fail(
            "safety",
            error instanceof Error ? error.message : String(error),
          );
          return;
        }
        if (
          (effect.kind === "run_review" ||
            effect.kind === "run_reconciliation" ||
            effect.kind === "run_publication") &&
          this.snapshot().processLeases[effect.leaseId]
        ) {
          const reviewFailure =
            error instanceof ReviewWorkspaceSafetyError ? error : undefined;
          const epochMismatch =
            error instanceof ReviewEpochMismatchError ? error : undefined;
          await this.dispatch({
            kind: "effect_failed",
            category: reviewFailure
              ? "workspace_unsafe"
              : error instanceof WorkerPacketError
                ? "protocol_failure"
                : "provider_failure",
            effect:
              effect.kind === "run_review"
                ? "review"
                : effect.kind === "run_reconciliation"
                  ? "reconciliation"
                  : "publication",
            workstream: effect.workstream,
            leaseId: effect.leaseId,
            evidence: error instanceof Error ? error.message : String(error),
            ...(reviewFailure?.observation
              ? { observation: reviewFailure.observation }
              : {}),
            ...(epochMismatch ? { nonRetryable: true } : {}),
            ...(effect.kind === "run_publication" &&
            error instanceof PublicationError &&
            error.outcome.kind === "retry_from_base"
              ? { provenNoWrite: true }
              : {}),
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
        if (
          !finalSettlementAttempted &&
          leaseId &&
          lease &&
          lease.kind === effectLeaseKind(effect)
        ) {
          await this.persist({ kind: "process_abandoned", leaseId });
        }
        await this.finalizeFailure();
        await this.drive();
      });
    this.processes.set(key, process);
  }

  private async fail(
    category: NonNullable<RunState["failure"]>["category"],
    reason: string,
  ): Promise<void> {
    const phase = this.snapshot().phase;
    if (["failed", "incomplete", "completed"].includes(phase)) {
      return;
    }
    this.stopping = true;
    if (phase !== "stopping") {
      await this.persist({
        kind: "failure_requested",
        category,
        reason,
        now: this.now(),
      });
    }
    this.controller.abort();
    for (const controller of this.processControllers.values()) {
      controller.abort();
    }
  }

  private async finalizeFailure(): Promise<void> {
    if (
      this.snapshot().phase === "stopping" &&
      this.processes.size === 0 &&
      Object.keys(this.snapshot().processLeases).length === 0
    ) {
      await this.persist({ kind: "run_failed" });
    }
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
  if (effect.kind === "run_revision") {
    return "revision";
  }
  if (effect.kind === "recreate_workspace") {
    return "workspace_recreation";
  }
  if (
    effect.kind === "run_reconciliation" ||
    effect.kind === "run_reconciliation_worker"
  ) {
    return "reconciliation";
  }
  if (effect.kind === "run_publication") {
    return "publication";
  }
  return undefined;
}

function isFinalSettlementForEffect(
  event: SchedulerEvent,
  effect: SchedulerEffect,
): boolean {
  if (!("leaseId" in effect) || !("leaseId" in event)) {
    return false;
  }
  if (event.leaseId !== effect.leaseId) {
    return false;
  }
  if (effect.kind === "run_implementation") {
    return ["implementation_completed", "implementation_failed"].includes(
      event.kind,
    );
  }
  if (effect.kind === "run_review") {
    return event.kind === "review_completed" || event.kind === "effect_failed";
  }
  if (effect.kind === "run_revision") {
    return ["revision_completed", "revision_failed"].includes(event.kind);
  }
  if (effect.kind === "recreate_workspace") {
    return event.kind === "workspace_recreation_completed";
  }
  if (effect.kind === "run_reconciliation") {
    return (
      event.kind === "reconciliation_completed" ||
      event.kind === "effect_failed"
    );
  }
  if (effect.kind === "run_reconciliation_worker") {
    return (
      event.kind === "reconciliation_worker_completed" ||
      event.kind === "reconciliation_worker_failed"
    );
  }
  return (
    event.kind === "publication_completed" ||
    event.kind === "publication_target_moved" ||
    event.kind === "effect_failed"
  );
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
