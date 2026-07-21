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

export type SchedulerActorOptions = {
  store: RunStore;
  executeWorker: WorkerExecution;
  onTransition?: (state: CanonicalRunState, event: SchedulerEvent) => void;
  awaitOwnedProcesses?: () => Promise<void>;
  now?: () => string;
};

export class SchedulerActor {
  private readonly abortController = new AbortController();
  private readonly workers = new Map<string, Promise<void>>();
  private readonly workerControllers = new Map<string, AbortController>();
  private readonly completions: Array<{
    taskId: string;
    leaseId: string;
    outcome: WorkerOutcome;
  }> = [];
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

  async nextCompletion(): Promise<{
    taskId: string;
    leaseId: string;
    outcome: WorkerOutcome;
  }> {
    while (this.completions.length === 0) {
      await new Promise<void>((resolve) => {
        this.completionWaiter = resolve;
      });
    }
    return this.completions.shift()!;
  }

  async start(): Promise<void> {
    if (this.snapshot().runtime.phase === "preflight") {
      await this.dispatch({ kind: "run_started" });
    }
    await this.reconcileRetainedLeases();
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

    await this.awaitWorkers();
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
    this.completions.push({ ...effect, outcome });
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
