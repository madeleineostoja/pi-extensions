import type { ExecutionPlan } from "./execution-plan-vnext.js";
import {
  StaleVNextRevisionError,
  type VNextRunState,
  type VNextRunStore,
} from "./vnext-store.js";

export type RuntimeWorkstream =
  VNextRunState["candidates"][string]["workstream"];
type ProcessLease = VNextRunState["processLeases"][string];

type ImplementationOutcome =
  | {
      kind: "candidate_ready";
      candidate: VNextRunState["candidates"][string];
      checkpoints?: Record<string, string>;
    }
  | { kind: "satisfaction_claimed"; evidence: Record<string, string> };

export type VNextSchedulerEvent =
  | { kind: "workstreams_selected"; now: string }
  | {
      kind: "implementation_completed";
      workstream: RuntimeWorkstream;
      leaseId: string;
      outcome: ImplementationOutcome;
    }
  | { kind: "review_requested"; workstream: RuntimeWorkstream; now: string }
  | {
      kind: "review_completed";
      workstream: RuntimeWorkstream;
      leaseId: string;
      outcome: "approved" | "needs_recovery";
    }
  | { kind: "recovery_requested"; workstream: RuntimeWorkstream; now: string }
  | {
      kind: "recovery_completed";
      workstream: RuntimeWorkstream;
      leaseId: string;
      candidate?: VNextRunState["candidates"][string];
    }
  | {
      kind: "publication_intent_recorded";
      intent: VNextRunState["publication"]["intents"][string];
    }
  | {
      kind: "publication_requested";
      workstream: RuntimeWorkstream;
      intentId: string;
      now: string;
    }
  | {
      kind: "publication_receipt_recorded";
      receipt: VNextRunState["publication"]["receipts"][string];
    }
  | {
      kind: "publication_completed";
      workstream: RuntimeWorkstream;
      leaseId: string;
      intentId: string;
    }
  | { kind: "whole_plan_review_requested" }
  | { kind: "overall_repair_queued"; repairId: string }
  | { kind: "whole_plan_review_completed" }
  | { kind: "process_abandoned"; leaseId: string }
  | { kind: "stop_requested"; reason?: string }
  | { kind: "run_paused"; reason?: string }
  | { kind: "resume_requested" }
  | { kind: "safety_blocked"; reason: string }
  | { kind: "run_completed" }
  | {
      kind: "projection_debt_recorded";
      debt: VNextRunState["projectionDebt"][number];
    }
  | { kind: "projection_debt_settled"; debtId: string }
  | {
      kind: "cleanup_debt_recorded";
      debt: VNextRunState["cleanupDebt"][number];
    }
  | { kind: "cleanup_debt_settled"; debtId: string };

export type VNextSchedulerEffect =
  | {
      kind: "run_implementation";
      workstream: RuntimeWorkstream;
      leaseId: string;
    }
  | { kind: "run_review"; workstream: RuntimeWorkstream; leaseId: string }
  | { kind: "run_recovery"; workstream: RuntimeWorkstream; leaseId: string }
  | {
      kind: "run_publication";
      workstream: RuntimeWorkstream;
      leaseId: string;
      candidateId: string;
      intentId: string;
    }
  | { kind: "run_whole_plan_review" }
  | { kind: "run_projection"; debtId: string }
  | { kind: "run_cleanup"; debtId: string };

export type VNextSchedulerTransition = {
  state: VNextRunState;
  effects: VNextSchedulerEffect[];
  accepted: boolean;
  error?: string;
};

export function selectReadyWorkstreams(state: VNextRunState): string[] {
  return selectReadyRuntimeWorkstreams(state)
    .filter(
      (workstream): workstream is { kind: "source"; id: string } =>
        workstream.kind === "source",
    )
    .map((workstream) => workstream.id);
}

export function selectReadyRuntimeWorkstreams(
  state: VNextRunState,
): RuntimeWorkstream[] {
  const capacity = state.run.workerConcurrency - activeLeaseCount(state);
  if (capacity <= 0) {
    return [];
  }
  if (state.phase === "running") {
    return Object.values(state.workstreams.source)
      .filter(
        (workstream) =>
          workstream.phase === "queued" &&
          workstream.dependsOn.every(
            (dependency) =>
              state.workstreams.source[dependency]?.phase === "completed",
          ),
      )
      .slice(0, capacity)
      .map((workstream) => ({ kind: "source" as const, id: workstream.id }));
  }
  if (
    state.phase === "whole_plan_review" &&
    allSourceWorkstreamsComplete(state)
  ) {
    return Object.values(state.workstreams.overall)
      .filter((workstream) => workstream.phase === "queued")
      .slice(0, capacity)
      .map((workstream) => ({
        kind: "overall" as const,
        repairId: workstream.repairId,
      }));
  }
  return [];
}

export function reduceVNextRunEvent(
  input: VNextRunState,
  event: VNextSchedulerEvent,
): VNextSchedulerTransition {
  const state = structuredClone(input);
  const reject = (error: string): VNextSchedulerTransition => ({
    state: input,
    effects: [],
    accepted: false,
    error,
  });
  const accept = (
    effects: VNextSchedulerEffect[] = [],
  ): VNextSchedulerTransition => ({ state, effects, accepted: true });

  if (state.phase === "blocked_safety" || state.phase === "completed") {
    return reject("terminal runs do not accept lifecycle events");
  }
  if (state.phase === "paused" && event.kind !== "resume_requested") {
    return reject("paused runs must resume before accepting lifecycle events");
  }
  if (
    state.phase === "stopping" &&
    event.kind !== "process_abandoned" &&
    event.kind !== "run_paused"
  ) {
    return reject("stopping runs only settle owned processes");
  }

  switch (event.kind) {
    case "workstreams_selected": {
      const ready = selectReadyRuntimeWorkstreams(state);
      const effects: VNextSchedulerEffect[] = [];
      for (const [index, workstream] of ready.entries()) {
        const lease = createLease(
          state,
          workstream,
          "implementation",
          event.now,
          index,
        );
        state.processLeases[lease.id] = lease;
        getWorkstream(state, workstream)!.phase = "implementing";
        effects.push({
          kind: "run_implementation",
          workstream,
          leaseId: lease.id,
        });
      }
      return accept(effects);
    }

    case "implementation_completed": {
      const lease = ownedLease(
        state,
        event.leaseId,
        event.workstream,
        "implementation",
      );
      const workstream = getWorkstream(state, event.workstream);
      if (
        !lease ||
        !workstream ||
        workstream.phase !== "implementing" ||
        !processIsAllowed(state, event.workstream)
      ) {
        return reject("implementation result does not own an active lease");
      }
      if (
        event.workstream.kind === "source" &&
        !sourceTaskOutcomeIsComplete(state, event.workstream, event.outcome)
      ) {
        return reject(
          "implementation outcome does not cover its source workstream",
        );
      }
      if (event.outcome.kind === "candidate_ready") {
        if (
          !sameWorkstream(event.outcome.candidate.workstream, event.workstream)
        ) {
          return reject("candidate belongs to a different workstream");
        }
        const existing = state.candidates[event.outcome.candidate.id];
        if (
          existing &&
          JSON.stringify(existing) !== JSON.stringify(event.outcome.candidate)
        ) {
          return reject("candidate identity is immutable");
        }
        state.candidates[event.outcome.candidate.id] = event.outcome.candidate;
        workstream.candidateId = event.outcome.candidate.id;
        if (event.workstream.kind === "source") {
          const sourceWorkstream =
            state.workstreams.source[event.workstream.id]!;
          for (const taskId of sourceWorkstream.taskIds) {
            state.tasks[taskId] = {
              workstreamId: taskIdOwner(state, taskId),
              phase: "checkpointed",
              checkpoint: event.outcome.checkpoints![taskId]!,
            };
          }
        }
        workstream.phase = "candidate_ready";
      } else {
        if (event.workstream.kind !== "source") {
          return reject("only source workstreams can claim satisfaction");
        }
        const sourceWorkstream = state.workstreams.source[event.workstream.id]!;
        for (const taskId of sourceWorkstream.taskIds) {
          state.tasks[taskId] = {
            workstreamId: taskIdOwner(state, taskId),
            phase: "satisfaction_claimed",
            evidence: event.outcome.evidence[taskId]!,
          };
        }
        workstream.phase = "candidate_ready";
      }
      delete state.processLeases[lease.id];
      return accept();
    }

    case "review_requested":
      return startProcess(state, event.workstream, "review", event.now, reject);

    case "review_completed": {
      const lease = ownedLease(
        state,
        event.leaseId,
        event.workstream,
        "review",
      );
      const workstream = getWorkstream(state, event.workstream);
      if (
        !lease ||
        !workstream ||
        workstream.phase !== "reviewing" ||
        lease.candidateId !== workstream.candidateId ||
        !processIsAllowed(state, event.workstream)
      ) {
        return reject("review result does not own an active lease");
      }
      delete state.processLeases[lease.id];
      if (event.outcome === "approved") {
        if (event.workstream.kind === "source") {
          const sourceWorkstream =
            state.workstreams.source[event.workstream.id]!;
          for (const taskId of sourceWorkstream.taskIds) {
            const task = state.tasks[taskId]!;
            if (task.phase === "satisfaction_claimed") {
              state.tasks[taskId] = {
                workstreamId: task.workstreamId,
                phase: "reviewed_satisfied",
                evidence: task.evidence,
              };
            }
          }
          if (
            sourceWorkstream.taskIds.every(
              (taskId) => state.tasks[taskId]?.phase === "reviewed_satisfied",
            )
          ) {
            workstream.phase = "completed";
            return accept();
          }
        }
        workstream.phase = "approved";
      } else {
        workstream.phase = "recovering";
      }
      return accept();
    }

    case "recovery_requested":
      return startProcess(
        state,
        event.workstream,
        "recovery",
        event.now,
        reject,
      );

    case "recovery_completed": {
      const lease = ownedLease(
        state,
        event.leaseId,
        event.workstream,
        "recovery",
      );
      const workstream = getWorkstream(state, event.workstream);
      if (
        !lease ||
        !workstream ||
        workstream.phase !== "recovering" ||
        !processIsAllowed(state, event.workstream)
      ) {
        return reject("recovery result does not own an active lease");
      }
      if (event.candidate) {
        if (!sameWorkstream(event.candidate.workstream, event.workstream)) {
          return reject("recovery candidate belongs to a different workstream");
        }
        const existing = state.candidates[event.candidate.id];
        if (
          existing &&
          JSON.stringify(existing) !== JSON.stringify(event.candidate)
        ) {
          return reject("candidate identity is immutable");
        }
        state.candidates[event.candidate.id] = event.candidate;
        workstream.candidateId = event.candidate.id;
        workstream.phase = "candidate_ready";
      }
      delete state.processLeases[lease.id];
      return accept();
    }

    case "publication_intent_recorded": {
      const candidate = state.candidates[event.intent.candidateId];
      if (!candidate) {
        return reject("publication intent references an unknown candidate");
      }
      const existing = state.publication.intents[event.intent.id];
      if (
        existing &&
        JSON.stringify(existing) !== JSON.stringify(event.intent)
      ) {
        return reject("publication intent is immutable");
      }
      state.publication.intents[event.intent.id] = event.intent;
      return accept();
    }

    case "publication_requested": {
      const intent = state.publication.intents[event.intentId];
      const workstream = getWorkstream(state, event.workstream);
      const candidate = intent && state.candidates[intent.candidateId];
      if (
        !intent ||
        !candidate ||
        !sameWorkstream(candidate.workstream, event.workstream) ||
        !workstream ||
        workstream.candidateId !== candidate.id ||
        workstream.phase !== "approved" ||
        !processIsAllowed(state, event.workstream) ||
        activeLeaseFor(state, event.workstream) ||
        activeLeaseCount(state) >= state.run.workerConcurrency ||
        Object.values(state.processLeases).some(
          (lease) => lease.kind === "publication",
        )
      ) {
        return reject("workstream is not ready for its publication intent");
      }
      const lease = createLease(
        state,
        event.workstream,
        "publication",
        event.now,
        0,
      );
      state.processLeases[lease.id] = {
        ...lease,
        candidateId: candidate.id,
        publicationIntentId: intent.id,
      };
      workstream.phase = "publishing";
      return accept([
        {
          kind: "run_publication",
          workstream: event.workstream,
          leaseId: lease.id,
          candidateId: candidate.id,
          intentId: intent.id,
        },
      ]);
    }

    case "publication_receipt_recorded": {
      const intent = state.publication.intents[event.receipt.intentId];
      if (
        !intent ||
        intent.preparedCommitSha !== event.receipt.publishedCommitSha
      ) {
        return reject("publication receipt does not match its intent");
      }
      const existing = state.publication.receipts[event.receipt.intentId];
      if (
        existing &&
        JSON.stringify(existing) !== JSON.stringify(event.receipt)
      ) {
        return reject("publication receipt is immutable");
      }
      state.publication.receipts[event.receipt.intentId] = event.receipt;
      return accept();
    }

    case "publication_completed": {
      const lease = ownedLease(
        state,
        event.leaseId,
        event.workstream,
        "publication",
      );
      const workstream = getWorkstream(state, event.workstream);
      const intent = state.publication.intents[event.intentId];
      if (
        !lease ||
        !workstream ||
        workstream.phase !== "publishing" ||
        !processIsAllowed(state, event.workstream) ||
        !intent ||
        lease.publicationIntentId !== event.intentId ||
        lease.candidateId !== intent.candidateId ||
        workstream.candidateId !== intent.candidateId ||
        !state.publication.receipts[event.intentId] ||
        !sameWorkstream(
          state.candidates[intent.candidateId]?.workstream ?? event.workstream,
          event.workstream,
        )
      ) {
        return reject("publication result does not own a receipted intent");
      }
      delete state.processLeases[lease.id];
      workstream.phase = "completed";
      if (event.workstream.kind === "overall") {
        state.wholePlanReview.status = "pending";
      }
      return accept();
    }

    case "whole_plan_review_requested":
      if (
        !["running", "whole_plan_review"].includes(state.phase) ||
        state.wholePlanReview.status !== "pending" ||
        !allSourceWorkstreamsComplete(state)
      ) {
        return reject("whole-plan review is not ready to run");
      }
      state.phase = "whole_plan_review";
      state.wholePlanReview.status = "reviewing";
      return accept([{ kind: "run_whole_plan_review" }]);

    case "overall_repair_queued":
      if (
        state.phase !== "whole_plan_review" ||
        state.wholePlanReview.status !== "reviewing" ||
        !allSourceWorkstreamsComplete(state) ||
        !safeId(event.repairId) ||
        state.workstreams.overall[event.repairId]
      ) {
        return reject("overall repair is not valid in the current run phase");
      }
      state.workstreams.overall[event.repairId] = {
        kind: "overall",
        repairId: event.repairId,
        phase: "queued",
      };
      state.wholePlanReview.status = "repairing";
      return accept();

    case "whole_plan_review_completed":
      if (
        state.phase !== "whole_plan_review" ||
        state.wholePlanReview.status !== "reviewing" ||
        Object.values(state.workstreams.overall).some(
          (workstream) => workstream.phase !== "completed",
        )
      ) {
        return reject("whole-plan review cannot complete while repairs exist");
      }
      state.wholePlanReview.status = "approved";
      return accept();

    case "process_abandoned": {
      const lease = state.processLeases[event.leaseId];
      if (!lease) {
        return reject("process lease does not exist");
      }
      const workstream = getWorkstream(state, lease.workstream);
      if (!workstream) {
        return reject("process lease references an unknown workstream");
      }
      delete state.processLeases[lease.id];
      workstream.phase = abandonedPhase(lease.kind);
      return accept();
    }

    case "stop_requested":
      if (
        state.phase !== "planning" &&
        state.phase !== "running" &&
        state.phase !== "whole_plan_review"
      ) {
        return reject("only an active run can stop");
      }
      state.pause = {
        resumePhase: state.phase,
        ...(event.reason ? { reason: event.reason } : {}),
      };
      state.phase = "stopping";
      return accept();

    case "run_paused":
      if (
        state.phase !== "stopping" ||
        Object.keys(state.processLeases).length > 0
      ) {
        return reject("run cannot pause before owned processes settle");
      }
      state.phase = "paused";
      return accept();

    case "resume_requested":
      if (state.phase !== "paused") {
        return reject("only a paused run can resume");
      }
      state.phase = state.pause!.resumePhase;
      delete state.pause;
      return accept();

    case "safety_blocked":
      if (Object.keys(state.processLeases).length > 0) {
        return reject("safety block requires owned processes to settle first");
      }
      state.phase = "blocked_safety";
      state.terminalReason = event.reason;
      return accept();

    case "run_completed":
      if (
        state.phase !== "whole_plan_review" ||
        !allSourceWorkstreamsComplete(state) ||
        Object.values(state.workstreams.overall).some(
          (workstream) => workstream.phase !== "completed",
        ) ||
        state.projectionDebt.length > 0 ||
        state.cleanupDebt.length > 0 ||
        Object.keys(state.processLeases).length > 0 ||
        state.wholePlanReview.status !== "approved"
      ) {
        return reject("run still has incomplete workstreams or cleanup debt");
      }
      state.phase = "completed";
      return accept();

    case "projection_debt_recorded":
      if (!state.projectionDebt.some((debt) => debt.id === event.debt.id)) {
        state.projectionDebt.push(event.debt);
        return accept([{ kind: "run_projection", debtId: event.debt.id }]);
      }
      return accept();

    case "projection_debt_settled":
      if (!state.projectionDebt.some((debt) => debt.id === event.debtId)) {
        return reject("projection debt does not exist");
      }
      state.projectionDebt = state.projectionDebt.filter(
        (debt) => debt.id !== event.debtId,
      );
      return accept();

    case "cleanup_debt_recorded":
      if (!state.cleanupDebt.some((debt) => debt.id === event.debt.id)) {
        state.cleanupDebt.push(event.debt);
        return accept([{ kind: "run_cleanup", debtId: event.debt.id }]);
      }
      return accept();

    case "cleanup_debt_settled":
      if (!state.cleanupDebt.some((debt) => debt.id === event.debtId)) {
        return reject("cleanup debt does not exist");
      }
      state.cleanupDebt = state.cleanupDebt.filter(
        (debt) => debt.id !== event.debtId,
      );
      return accept();
  }
}

export type VNextEffectExecution = (args: {
  effect: VNextSchedulerEffect;
  signal: AbortSignal;
  dispatch: (event: VNextSchedulerEvent) => Promise<void>;
}) => Promise<void>;

export type VNextPlannerExecution = (args: {
  signal: AbortSignal;
}) => Promise<ExecutionPlan>;

export type VNextSchedulerActorOptions = {
  store: VNextRunStore;
  executeEffect?: VNextEffectExecution;
  executePlanner?: VNextPlannerExecution;
  onTransition?: (
    state: VNextRunState,
    event: VNextSchedulerEvent | { kind: "planner_bound" },
  ) => void;
  awaitOwnedProcesses?: () => Promise<void>;
  now?: () => string;
};

export class VNextSchedulerActor {
  private readonly controller = new AbortController();
  private readonly processes = new Map<string, Promise<void>>();
  private readonly processControllers = new Map<string, AbortController>();
  private readonly now: () => string;
  private queue = Promise.resolve();
  private stopping = false;

  constructor(private readonly options: VNextSchedulerActorOptions) {
    this.now = options.now ?? (() => new Date().toISOString());
  }

  snapshot(): VNextRunState {
    return this.options.store.read();
  }

  async start(): Promise<void> {
    await this.reconcileAbandonedProcesses();
    if (this.snapshot().phase === "planning") {
      this.startPlanner();
      return;
    }
    if (["running", "whole_plan_review"].includes(this.snapshot().phase)) {
      if (
        this.snapshot().phase === "whole_plan_review" &&
        this.snapshot().wholePlanReview.status === "reviewing"
      ) {
        this.startEffect({ kind: "run_whole_plan_review" });
      }
      for (const debt of this.snapshot().projectionDebt) {
        this.startEffect({ kind: "run_projection", debtId: debt.id });
      }
      for (const debt of this.snapshot().cleanupDebt) {
        this.startEffect({ kind: "run_cleanup", debtId: debt.id });
      }
      await this.schedule();
    }
  }

  async schedule(): Promise<boolean> {
    if (
      this.stopping ||
      !["running", "whole_plan_review"].includes(this.snapshot().phase)
    ) {
      return false;
    }
    const effects = await this.dispatch({
      kind: "workstreams_selected",
      now: this.now(),
    });
    return effects.some((effect) => effect.kind === "run_implementation");
  }

  async dispatch(event: VNextSchedulerEvent): Promise<VNextSchedulerEffect[]> {
    const operation = this.queue.then(async () => {
      for (;;) {
        const current = this.options.store.read();
        const transition = reduceVNextRunEvent(current, event);
        if (!transition.accepted) {
          throw new VNextSchedulerActorError(
            transition.error ?? `Reducer rejected ${event.kind}.`,
          );
        }
        try {
          const state = await this.options.store.update(
            current.revision,
            () => transition.state,
          );
          try {
            this.options.onTransition?.(state, event);
          } catch {
            // Projection callbacks are not state authority.
          }
          for (const effect of transition.effects) {
            this.startEffect(effect);
          }
          return transition.effects;
        } catch (error) {
          if (error instanceof StaleVNextRevisionError) {
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
    const effects = await operation;
    if (
      !this.stopping &&
      [
        "implementation_completed",
        "review_completed",
        "recovery_completed",
        "publication_completed",
        "process_abandoned",
      ].includes(event.kind)
    ) {
      await this.schedule();
    }
    return effects;
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

  async blockSafety(reason: string): Promise<void> {
    this.stopping = true;
    this.controller.abort();
    for (const controller of this.processControllers.values()) {
      controller.abort();
    }
    while (this.processes.size > 0) {
      await Promise.allSettled(this.processes.values());
    }
    await this.options.awaitOwnedProcesses?.();
    await this.dispatch({ kind: "safety_blocked", reason });
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
      .finally(() => {
        this.processes.delete("planner");
        this.processControllers.delete("planner");
      });
    this.processes.set("planner", process);
  }

  private startEffect(effect: VNextSchedulerEffect): void {
    if (!this.options.executeEffect) {
      return;
    }
    const key = effectKey(effect);
    if (this.processes.has(key)) {
      return;
    }
    const controller = linkedAbortController(this.controller.signal);
    this.processControllers.set(key, controller);
    const process = this.options
      .executeEffect({
        effect,
        signal: controller.signal,
        dispatch: async (event) => {
          await this.dispatch(event);
        },
      })
      .catch(() => undefined)
      .finally(async () => {
        this.processes.delete(key);
        this.processControllers.delete(key);
        const leaseId = "leaseId" in effect ? effect.leaseId : undefined;
        if (leaseId && this.snapshot().processLeases[leaseId]) {
          await this.dispatch({ kind: "process_abandoned", leaseId });
        }
      });
    this.processes.set(key, process);
  }

  private async reconcileAbandonedProcesses(): Promise<void> {
    for (const lease of Object.values(this.snapshot().processLeases)) {
      await this.dispatch({ kind: "process_abandoned", leaseId: lease.id });
    }
  }
}

export class VNextSchedulerActorError extends Error {}

function startProcess(
  state: VNextRunState,
  workstream: RuntimeWorkstream,
  kind: ProcessLease["kind"],
  now: string,
  reject: (error: string) => VNextSchedulerTransition,
): VNextSchedulerTransition {
  const current = getWorkstream(state, workstream);
  const allowed =
    (kind === "review" && current?.phase === "candidate_ready") ||
    (kind === "recovery" && current?.phase === "recovering");
  if (
    !allowed ||
    !processIsAllowed(state, workstream) ||
    activeLeaseFor(state, workstream) ||
    activeLeaseCount(state) >= state.run.workerConcurrency
  ) {
    return reject("workstream is not ready for this process");
  }
  const lease = createLease(state, workstream, kind, now, 0);
  state.processLeases[lease.id] = lease;
  current!.phase =
    kind === "review"
      ? "reviewing"
      : kind === "recovery"
        ? "recovering"
        : "publishing";
  const effect =
    kind === "review"
      ? { kind: "run_review" as const, workstream, leaseId: lease.id }
      : { kind: "run_recovery" as const, workstream, leaseId: lease.id };
  return { state, effects: [effect], accepted: true };
}

function createLease(
  state: VNextRunState,
  workstream: RuntimeWorkstream,
  kind: ProcessLease["kind"],
  acquiredAt: string,
  index: number,
): ProcessLease {
  const attempt =
    Object.values(state.processLeases).filter(
      (lease) =>
        sameWorkstream(lease.workstream, workstream) && lease.kind === kind,
    ).length + 1;
  return {
    id: `${kind}:${state.run.id}:${state.revision + 1}:${index}`,
    workstream,
    kind,
    ...(getWorkstream(state, workstream)?.candidateId
      ? { candidateId: getWorkstream(state, workstream)!.candidateId }
      : {}),
    attempt,
    acquiredAt,
  };
}

function ownedLease(
  state: VNextRunState,
  leaseId: string,
  workstream: RuntimeWorkstream,
  kind: ProcessLease["kind"],
): ProcessLease | undefined {
  const lease = state.processLeases[leaseId];
  return lease?.kind === kind && sameWorkstream(lease.workstream, workstream)
    ? lease
    : undefined;
}

function processIsAllowed(
  state: VNextRunState,
  workstream: RuntimeWorkstream,
): boolean {
  return workstream.kind === "source"
    ? state.phase === "running"
    : state.phase === "whole_plan_review";
}

function activeLeaseFor(
  state: VNextRunState,
  workstream: RuntimeWorkstream,
): boolean {
  return Object.values(state.processLeases).some((lease) =>
    sameWorkstream(lease.workstream, workstream),
  );
}

function activeLeaseCount(state: VNextRunState): number {
  return Object.keys(state.processLeases).length;
}

function getWorkstream(
  state: VNextRunState,
  workstream: RuntimeWorkstream,
):
  | VNextRunState["workstreams"]["source"][string]
  | VNextRunState["workstreams"]["overall"][string]
  | undefined {
  return workstream.kind === "source"
    ? state.workstreams.source[workstream.id]
    : state.workstreams.overall[workstream.repairId];
}

function sourceTaskOutcomeIsComplete(
  state: VNextRunState,
  workstream: RuntimeWorkstream,
  outcome: ImplementationOutcome,
): boolean {
  if (workstream.kind !== "source") {
    return false;
  }
  const taskIds = state.workstreams.source[workstream.id]?.taskIds ?? [];
  const values =
    outcome.kind === "candidate_ready" ? outcome.checkpoints : outcome.evidence;
  if (!values) {
    return false;
  }
  return (
    taskIds.every(
      (taskId) =>
        typeof values[taskId] === "string" && values[taskId].trim() !== "",
    ) && Object.keys(values).every((taskId) => taskIds.includes(taskId))
  );
}

function taskIdOwner(state: VNextRunState, taskId: string): string {
  return state.tasks[taskId]!.workstreamId;
}

function allSourceWorkstreamsComplete(state: VNextRunState): boolean {
  return Object.values(state.workstreams.source).every(
    (workstream) => workstream.phase === "completed",
  );
}

function abandonedPhase(
  kind: ProcessLease["kind"],
): "queued" | "candidate_ready" | "recovering" | "approved" {
  if (kind === "implementation") {
    return "queued";
  }
  if (kind === "review") {
    return "candidate_ready";
  }
  if (kind === "recovery") {
    return "recovering";
  }
  return "approved";
}

function sameWorkstream(
  left: RuntimeWorkstream,
  right: RuntimeWorkstream,
): boolean {
  return (
    left.kind === right.kind &&
    (left.kind === "source"
      ? left.id === (right as { id: string }).id
      : left.repairId === (right as { repairId: string }).repairId)
  );
}

function effectKey(effect: VNextSchedulerEffect): string {
  if ("leaseId" in effect) {
    return effect.leaseId;
  }
  if ("debtId" in effect) {
    return `${effect.kind}:${effect.debtId}`;
  }
  return effect.kind;
}

function safeId(value: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(value);
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
