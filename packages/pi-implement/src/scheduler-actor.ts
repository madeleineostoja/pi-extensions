import {
  type CanonicalRunState,
  type RunStore,
  StaleRunStateRevisionError,
} from "./canonical-state.js";
import {
  transition,
  type SchedulerEffect,
  type SchedulerEvent,
} from "./scheduler.js";

export type WorkerOutcome = Extract<
  SchedulerEvent,
  { kind: "worker_finished" }
>["outcome"];

export type WorkerExecution = (args: {
  taskId: string;
  leaseId: string;
  signal: AbortSignal;
}) => Promise<WorkerOutcome>;

export type IntegrationExecution = (args: {
  owner: { kind: "task"; taskId: string } | { kind: "overall" };
  attemptId: string;
  candidateId: string;
  signal: AbortSignal;
  dispatch: (event: SchedulerEvent) => Promise<void>;
}) => Promise<void>;

export type CleanupExecution = (args: { debtId: string }) => Promise<void>;

type ActorCompletion =
  | {
      kind: "worker";
      taskId: string;
      leaseId: string;
      outcome: WorkerOutcome;
    }
  | {
      kind: "integration";
      owner: { kind: "task"; taskId: string } | { kind: "overall" };
      attemptId: string;
      phase: "completed" | "paused";
    };

export type SchedulerActorOptions = {
  store: RunStore;
  executeWorker: WorkerExecution;
  executeIntegration?: IntegrationExecution;
  executeCleanup?: CleanupExecution;
  onTransition?: (state: CanonicalRunState, event: SchedulerEvent) => void;
  awaitOwnedProcesses?: () => Promise<void>;
  now?: () => string;
};

export class SchedulerActor {
  private readonly abortController = new AbortController();
  private readonly workers = new Map<string, Promise<void>>();
  private readonly workerControllers = new Map<string, AbortController>();
  private readonly integrations = new Map<string, Promise<void>>();
  private readonly integrationControllers = new Map<string, AbortController>();
  private readonly completions: ActorCompletion[] = [];
  private completionWaiter?: () => void;
  private readonly now: () => string;
  private stopping = false;
  private dispatchQueue = Promise.resolve();

  constructor(private readonly options: SchedulerActorOptions) {
    this.now = options.now ?? (() => new Date().toISOString());
  }

  get signal(): AbortSignal {
    return this.abortController.signal;
  }

  snapshot(): CanonicalRunState {
    return this.options.store.read();
  }

  get activeTaskIds(): string[] {
    return [...this.workers.keys()]
      .map(
        (leaseId) =>
          this.snapshot().workerLeases.find((lease) => lease.id === leaseId)
            ?.taskId,
      )
      .filter((taskId): taskId is string => Boolean(taskId));
  }

  async nextCompletion(): Promise<ActorCompletion> {
    while (this.completions.length === 0) {
      if (this.abortController.signal.aborted) {
        throw new SchedulerActorError(
          "Scheduler stopped while awaiting completion.",
        );
      }
      await new Promise<void>((resolve) => {
        this.completionWaiter = resolve;
        this.abortController.signal.addEventListener("abort", () => resolve(), {
          once: true,
        });
      });
    }
    return this.completions.shift()!;
  }

  async start(): Promise<void> {
    if (this.snapshot().runtime.phase === "preflight") {
      await this.dispatch({ kind: "run_started" });
    }
    await this.reconcileRetainedLeases();
    await this.resumeRetainedIntegrations();
    await this.reconcileCleanupDebt();
    await this.schedule();
  }

  async settle(): Promise<void> {
    for (;;) {
      await this.awaitWorkers();
      if (this.stopping || this.snapshot().runtime.phase !== "running") {
        return;
      }
      const started = await this.schedule();
      if (!started && this.workers.size === 0) {
        return;
      }
    }
  }

  async stop(): Promise<void> {
    if (!this.stopping) {
      this.stopping = true;
      if (this.snapshot().runtime.phase === "running") {
        await this.dispatch({ kind: "run_stopping" });
      }
      this.abortController.abort();
      for (const controller of this.workerControllers.values()) {
        controller.abort();
      }
    }

    for (const controller of this.integrationControllers.values()) {
      controller.abort();
    }
    await this.awaitWorkers();
    await this.awaitIntegrations();
    await this.options.awaitOwnedProcesses?.();
  }

  async schedule(): Promise<boolean> {
    if (this.stopping || this.snapshot().runtime.phase !== "running") {
      return false;
    }
    const effects = await this.dispatch({
      kind: "workers_selected",
      now: this.now(),
    });
    const workerEffects = effects.filter(
      (effect): effect is Extract<SchedulerEffect, { kind: "start_worker" }> =>
        effect.kind === "start_worker",
    );
    for (const effect of workerEffects) {
      this.startWorker(effect);
    }
    return workerEffects.length > 0;
  }

  async requestIntegration(args: {
    taskId: string;
    attemptId: string;
    pipelineHash: string;
  }): Promise<boolean> {
    const effects = await this.dispatch({
      kind: "integration_requested",
      ...args,
      now: this.now(),
    });
    for (const effect of effects) {
      if (effect.kind === "start_integration") {
        this.startIntegration(effect);
      }
    }
    return effects.some((effect) => effect.kind === "start_integration");
  }

  async requestOverallIntegration(args: {
    attemptId: string;
    pipelineHash: string;
  }): Promise<boolean> {
    const effects = await this.dispatch({
      kind: "overall_integration_requested",
      ...args,
      now: this.now(),
    });
    for (const effect of effects) {
      if (effect.kind === "start_integration") {
        this.startIntegration(effect);
      }
    }
    return effects.some((effect) => effect.kind === "start_integration");
  }

  async recordOverallCandidate(
    candidate: CanonicalRunState["candidates"][string],
  ): Promise<void> {
    await this.dispatch({ kind: "overall_candidate_ready", candidate });
  }

  async completeOverallReview(): Promise<void> {
    await this.dispatch({ kind: "overall_review_completed" });
  }

  async completeRun(): Promise<void> {
    await this.dispatch({ kind: "run_completed" });
  }

  async recordCleanupDebt(
    debt: CanonicalRunState["cleanupDebt"][number],
  ): Promise<void> {
    await this.dispatch({ kind: "cleanup_debt_recorded", debt });
  }

  async recordProjectionDebt(
    debt: CanonicalRunState["projectionDebt"][number],
  ): Promise<void> {
    await this.dispatch({ kind: "projection_debt_recorded", debt });
  }

  async completeProjection(debtId: string): Promise<void> {
    await this.dispatch({ kind: "projection_completed", debtId });
  }

  async completeCleanup(debtId: string): Promise<void> {
    await this.dispatch({ kind: "cleanup_completed", debtId });
  }

  private startIntegration(
    effect: Extract<SchedulerEffect, { kind: "start_integration" }>,
  ): void {
    if (!this.options.executeIntegration) {
      throw new SchedulerActorError("Scheduler has no integration executor.");
    }
    const controller = linkedAbortController(this.abortController.signal);
    this.integrationControllers.set(effect.attemptId, controller);
    const integration = this.options
      .executeIntegration({
        ...effect,
        signal: controller.signal,
        dispatch: async (event) => {
          await this.dispatch(event);
        },
      })
      .catch(async (error: unknown) => {
        if (controller.signal.aborted) {
          await this.dispatch({
            kind: "integration_paused",
            attemptId: effect.attemptId,
          });
          return;
        }
        await this.dispatch({
          kind: "integration_paused",
          attemptId: effect.attemptId,
        });
        throw error;
      })
      .finally(() => {
        const attempt = this.snapshot().integrationAttempts.find(
          (entry) => entry.id === effect.attemptId,
        );
        if (attempt?.phase === "completed" || attempt?.phase === "paused") {
          this.completions.push({
            kind: "integration",
            owner: effect.owner,
            attemptId: effect.attemptId,
            phase: attempt.phase,
          });
          this.completionWaiter?.();
          this.completionWaiter = undefined;
        }
        this.integrations.delete(effect.attemptId);
        this.integrationControllers.delete(effect.attemptId);
      });
    this.integrations.set(effect.attemptId, integration);
  }

  private startWorker(
    effect: Extract<SchedulerEffect, { kind: "start_worker" }>,
  ): void {
    const controller = linkedAbortController(this.abortController.signal);
    this.workerControllers.set(effect.leaseId, controller);
    const worker = this.executeWorker(effect, controller.signal)
      .then((outcome) => this.finishWorker(effect, outcome))
      .catch((error: unknown) =>
        this.finishWorker(
          effect,
          controller.signal.aborted
            ? { kind: "cancelled" }
            : {
                kind: "failed",
                failureKind: "wait",
                reason: error instanceof Error ? error.message : String(error),
              },
        ),
      )
      .finally(() => {
        this.workers.delete(effect.leaseId);
        this.workerControllers.delete(effect.leaseId);
      });
    this.workers.set(effect.leaseId, worker);
  }

  private async executeWorker(
    effect: Extract<SchedulerEffect, { kind: "start_worker" }>,
    signal: AbortSignal,
  ): Promise<WorkerOutcome> {
    if (signal.aborted) {
      return { kind: "cancelled" };
    }
    return this.options.executeWorker({
      taskId: effect.taskId,
      leaseId: effect.leaseId,
      signal,
    });
  }

  private async finishWorker(
    effect: Extract<SchedulerEffect, { kind: "start_worker" }>,
    outcome: WorkerOutcome,
  ): Promise<void> {
    await this.dispatch({
      kind: "worker_finished",
      taskId: effect.taskId,
      leaseId: effect.leaseId,
      outcome,
    });
    this.completions.push({
      kind: "worker",
      taskId: effect.taskId,
      leaseId: effect.leaseId,
      outcome,
    });
    this.completionWaiter?.();
    this.completionWaiter = undefined;
    if (outcome.kind === "failed" && outcome.failureKind === "safety") {
      this.stopping = true;
      if (this.snapshot().runtime.phase === "running") {
        await this.dispatch({ kind: "run_stopping" });
      }
      this.abortController.abort();
      for (const controller of this.workerControllers.values()) {
        controller.abort();
      }
    }
  }

  private async dispatch(event: SchedulerEvent): Promise<SchedulerEffect[]> {
    const operation = this.dispatchQueue.then(async () => {
      for (;;) {
        const current = this.options.store.read();
        const result = transition(current, event);
        if (!result.accepted) {
          throw new SchedulerActorError(
            result.error ?? `Scheduler rejected ${event.kind}.`,
          );
        }
        try {
          const state = await this.options.store.update(
            current.revision,
            () => result.state,
          );
          try {
            this.options.onTransition?.(state, event);
          } catch {
            // Projections are not lifecycle authority and cannot suppress effects.
          }
          return result.effects;
        } catch (error) {
          if (error instanceof StaleRunStateRevisionError) {
            continue;
          }
          throw error;
        }
      }
    });
    this.dispatchQueue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  private async reconcileRetainedLeases(): Promise<void> {
    for (const lease of this.snapshot().workerLeases) {
      await this.dispatch({
        kind: "worker_finished",
        taskId: lease.taskId,
        leaseId: lease.id,
        outcome: { kind: "cancelled" },
      });
    }
    for (const attempt of this.snapshot().integrationAttempts) {
      if (["preparing", "prepared", "publishing"].includes(attempt.phase)) {
        await this.dispatch({
          kind: "integration_paused",
          attemptId: attempt.id,
        });
      }
    }
  }

  private async resumeRetainedIntegrations(): Promise<void> {
    for (const attempt of this.snapshot().integrationAttempts) {
      if (attempt.phase !== "paused") {
        continue;
      }
      const effects = await this.dispatch({
        kind: "integration_resumed",
        attemptId: attempt.id,
      });
      for (const effect of effects) {
        if (effect.kind === "start_integration") {
          this.startIntegration(effect);
        }
      }
    }
  }

  private async reconcileCleanupDebt(): Promise<void> {
    if (!this.options.executeCleanup) {
      return;
    }
    for (const debt of this.snapshot().cleanupDebt) {
      try {
        await this.options.executeCleanup({ debtId: debt.id });
        await this.dispatch({ kind: "cleanup_completed", debtId: debt.id });
      } catch {
        // Retain cleanup debt until ownership can be proved on a later resume.
      }
    }
  }

  private async awaitIntegrations(): Promise<void> {
    const outcomes = await Promise.allSettled(this.integrations.values());
    const failed = outcomes.find(
      (outcome): outcome is PromiseRejectedResult =>
        outcome.status === "rejected",
    );
    if (failed) {
      throw failed.reason;
    }
  }

  private async awaitWorkers(): Promise<void> {
    const outcomes = await Promise.allSettled(this.workers.values());
    const failed = outcomes.find(
      (outcome): outcome is PromiseRejectedResult =>
        outcome.status === "rejected",
    );
    if (failed) {
      throw failed.reason;
    }
  }
}

export class SchedulerActorError extends Error {}

function linkedAbortController(parent: AbortSignal): AbortController {
  const controller = new AbortController();
  if (parent.aborted) {
    controller.abort();
    return controller;
  }
  parent.addEventListener("abort", () => controller.abort(), { once: true });
  return controller;
}
