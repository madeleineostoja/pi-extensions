import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { z } from "zod";

const nonEmpty = z.string().min(1);
const ownerSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("task"), taskId: nonEmpty }).strict(),
  z.object({ kind: z.literal("overall") }).strict(),
]);

const reviewReceiptSchema = z
  .object({
    id: nonEmpty,
    candidateId: nonEmpty,
    candidateCommitSha: nonEmpty,
    candidateTreeSha: nonEmpty,
    verdict: z.enum(["approved", "changes_requested"]),
    convergence: z
      .object({
        round: z.number().int().nonnegative(),
        outstandingFindingIds: z.array(nonEmpty),
        bestOutstandingCount: z.number().int().nonnegative(),
        evidenceRefs: z.array(nonEmpty),
      })
      .strict(),
    assessedAt: nonEmpty,
  })
  .strict();

export const candidateRefSchema = z
  .object({
    id: nonEmpty,
    sourceBaseSha: nonEmpty,
    baseSha: nonEmpty,
    commitSha: nonEmpty,
    treeSha: nonEmpty,
    branchName: nonEmpty,
    worktreePath: nonEmpty,
    reviewReceipt: reviewReceiptSchema,
  })
  .strict();

const taskDefinitionSchema = z
  .object({
    id: nonEmpty,
    planIndex: z.number().int().nonnegative(),
    title: nonEmpty,
    taskHash: nonEmpty,
    dependsOn: z.array(nonEmpty),
  })
  .strict();

const taskRuntimeSchema = z.discriminatedUnion("phase", [
  z.object({ phase: z.literal("queued") }).strict(),
  z.object({ phase: z.literal("executing"), workerLeaseId: nonEmpty }).strict(),
  z
    .object({ phase: z.literal("candidate_ready"), candidateId: nonEmpty })
    .strict(),
  z
    .object({
      phase: z.literal("integrating"),
      candidateId: nonEmpty,
      integrationAttemptId: nonEmpty,
    })
    .strict(),
  z
    .object({ phase: z.literal("waiting_rework"), candidateId: nonEmpty })
    .strict(),
  z
    .object({
      phase: z.literal("completed"),
      result: z.enum(["landed", "satisfied"]),
    })
    .strict(),
  z.object({ phase: z.literal("failed"), reason: nonEmpty }).strict(),
  z.object({ phase: z.literal("blocked"), reason: nonEmpty }).strict(),
]);

const workerLeaseSchema = z
  .object({
    id: nonEmpty,
    taskId: nonEmpty,
    attempt: z.number().int().positive(),
    acquiredAt: nonEmpty,
  })
  .strict();

const reviewFindingSchema = z
  .object({
    id: nonEmpty,
    summary: nonEmpty,
    evidence: nonEmpty,
    requiredChange: nonEmpty,
    acceptanceCriteria: z.array(nonEmpty),
    introducedRound: z.number().int().nonnegative(),
    origin: z.enum(["initial", "regression"]),
  })
  .strict();

const reviewConvergenceSchema = z
  .object({
    candidateId: nonEmpty,
    epoch: z.number().int().positive(),
    round: z.number().int().nonnegative(),
    findings: z.array(reviewFindingSchema),
    outstandingFindingIds: z.array(nonEmpty),
    bestOutstandingCount: z.number().int().nonnegative(),
    consecutiveStalledRounds: z.number().int().nonnegative(),
    evidenceRefs: z.array(nonEmpty),
  })
  .strict();

const integrationAttemptBaseSchema = {
  id: nonEmpty,
  owner: ownerSchema,
  candidateId: nonEmpty,
  targetBaseSha: nonEmpty,
  pipelineHash: nonEmpty,
  startedAt: nonEmpty,
};

const integrationAttemptSchema = z.discriminatedUnion("phase", [
  z
    .object({ ...integrationAttemptBaseSchema, phase: z.literal("preparing") })
    .strict(),
  z
    .object({
      ...integrationAttemptBaseSchema,
      phase: z.literal("prepared"),
      preparedCommitSha: nonEmpty,
    })
    .strict(),
  z
    .object({
      ...integrationAttemptBaseSchema,
      phase: z.literal("publishing"),
      preparedCommitSha: nonEmpty,
    })
    .strict(),
  z
    .object({ ...integrationAttemptBaseSchema, phase: z.literal("paused") })
    .strict(),
  z
    .object({
      ...integrationAttemptBaseSchema,
      phase: z.literal("completed"),
      preparedCommitSha: nonEmpty,
    })
    .strict(),
]);

const landingReceiptSchema = z
  .object({
    attemptId: nonEmpty,
    owner: ownerSchema,
    candidateCommitSha: nonEmpty,
    targetCheckoutId: nonEmpty,
    targetRef: nonEmpty,
    targetBaseSha: nonEmpty,
    integrationCommitSha: nonEmpty,
    treeSha: nonEmpty,
    pipelineHash: nonEmpty,
    publishedAt: nonEmpty,
  })
  .strict();

const projectionDebtSchema = z
  .object({ id: nonEmpty, kind: nonEmpty, reason: nonEmpty })
  .strict();

export const canonicalRunStateSchema = z
  .object({
    schemaVersion: z.literal(3),
    revision: z.number().int().nonnegative(),
    run: z
      .object({
        id: nonEmpty,
        target: z
          .object({
            checkoutRoot: nonEmpty,
            gitDir: nonEmpty,
            commonGitDir: nonEmpty,
            branchRef: nonEmpty,
            startHead: nonEmpty,
          })
          .strict(),
        plan: z
          .object({
            path: nonEmpty,
            hash: nonEmpty,
            indexConvention: z.literal("zero-based"),
          })
          .strict(),
        configuredWorkerConcurrency: z.number().int().positive(),
        effectiveWorkerConcurrency: z.number().int().positive(),
      })
      .strict(),
    graph: z.object({ tasks: z.array(taskDefinitionSchema) }).strict(),
    runtime: z
      .object({
        phase: z.enum([
          "preflight",
          "running",
          "stopping",
          "completed",
          "blocked",
        ]),
        terminalReason: nonEmpty.optional(),
        tasks: z.record(z.string(), taskRuntimeSchema),
      })
      .strict(),
    candidates: z.record(z.string(), candidateRefSchema),
    reviewConvergence: z.record(z.string(), reviewConvergenceSchema),
    workerLeases: z.array(workerLeaseSchema),
    integrationAttempts: z.array(integrationAttemptSchema),
    landingReceipts: z.array(landingReceiptSchema),
    projectionDebt: z.array(projectionDebtSchema),
    cleanupDebt: z.array(projectionDebtSchema),
    createdAt: nonEmpty,
    updatedAt: nonEmpty,
  })
  .strict();

export type CandidateRef = z.infer<typeof candidateRefSchema>;
export type CanonicalRunState = z.infer<typeof canonicalRunStateSchema>;
export type CanonicalTaskDefinition = z.infer<typeof taskDefinitionSchema>;
export type LegacyRunProjection = {
  mode: "serial" | "parallel";
  currentPhase: CanonicalRunState["runtime"]["phase"];
  maxConcurrency: number;
  taskStatuses: Record<string, string>;
};

export class RunStateError extends Error {
  constructor(
    message: string,
    readonly path: string,
    readonly issues: string[] = [],
  ) {
    super(message);
    this.name = "RunStateError";
  }
}

export class StaleRunStateRevisionError extends RunStateError {
  constructor(path: string, expected: number, actual: number) {
    super(
      `Run state at ${path} changed from revision ${expected} to ${actual}; reload before updating.`,
      path,
    );
    this.name = "StaleRunStateRevisionError";
  }
}

export type RunStoreHooks = {
  beforeRename?: (temporaryPath: string, destinationPath: string) => void;
};

const pathUpdates = new Map<string, Promise<void>>();

export class RunStore {
  private constructor(
    readonly path: string,
    private snapshot: CanonicalRunState,
    private readonly hooks: RunStoreHooks,
  ) {}

  static create(
    path: string,
    initial: CanonicalRunState,
    hooks: RunStoreHooks = {},
  ): RunStore {
    const state = validateCanonicalRunState(initial, path);
    if (existsSync(path)) {
      throw new RunStateError(
        `Canonical run state already exists at ${path}.`,
        path,
      );
    }
    writeCanonicalAtomically(path, state, hooks);
    return new RunStore(path, state, hooks);
  }

  static open(
    path: string,
    expected?: Pick<CanonicalRunState["run"], "id" | "target" | "plan">,
    hooks: RunStoreHooks = {},
  ): RunStore {
    const state = loadCanonicalRunState(path);
    if (
      expected &&
      (state.run.id !== expected.id ||
        JSON.stringify(state.run.target) !== JSON.stringify(expected.target) ||
        JSON.stringify(state.run.plan) !== JSON.stringify(expected.plan))
    ) {
      throw new RunStateError(
        `Canonical run state at ${path} does not match this run's target checkout or plan identity.`,
        path,
      );
    }
    return new RunStore(path, state, hooks);
  }

  read(): CanonicalRunState {
    return structuredClone(this.snapshot);
  }

  async update(
    expectedRevision: number,
    update: (current: CanonicalRunState) => CanonicalRunState,
  ): Promise<CanonicalRunState> {
    const queued = pathUpdates.get(this.path) ?? Promise.resolve();
    const operation = queued
      .catch(() => undefined)
      .then(() => {
        const current = loadCanonicalRunState(this.path);
        if (expectedRevision !== current.revision) {
          throw new StaleRunStateRevisionError(
            this.path,
            expectedRevision,
            current.revision,
          );
        }
        const proposed = update(structuredClone(current));
        const next = validateCanonicalRunState(
          {
            ...proposed,
            schemaVersion: 3,
            revision: current.revision + 1,
            updatedAt: new Date().toISOString(),
          },
          this.path,
          current,
        );
        writeCanonicalAtomically(this.path, next, this.hooks);
        this.snapshot = next;
      });
    pathUpdates.set(this.path, operation);
    await operation;
    return this.read();
  }
}

export function loadCanonicalRunState(path: string): CanonicalRunState {
  if (!existsSync(path)) {
    throw new RunStateError(
      `Canonical run state is missing at ${path}. This retained run uses legacy state; start over or clean it up explicitly.`,
      path,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"));
  } catch (error) {
    throw new RunStateError(
      `Canonical run state at ${path} is malformed JSON and has been blocked.`,
      path,
      [error instanceof Error ? error.message : String(error)],
    );
  }
  return validateCanonicalRunState(parsed, path);
}

export function validateCanonicalRunState(
  value: unknown,
  path: string,
  previous?: CanonicalRunState,
): CanonicalRunState {
  const parsed = canonicalRunStateSchema.safeParse(value);
  if (!parsed.success) {
    const issues = parsed.error.issues.map(
      (issue) => `${issue.path.join(".") || "state"}: ${issue.message}`,
    );
    const version = versionFrom(value);
    const legacy = version === undefined || version < 3;
    throw new RunStateError(
      legacy
        ? `Run state at ${path} uses unsupported legacy schema${version === undefined ? "" : ` v${version}`}; start over or clean it up explicitly.`
        : `Canonical run state at ${path} is invalid and has been blocked.`,
      path,
      issues,
    );
  }
  const state = parsed.data;
  const issues = invariantIssues(state, previous);
  if (issues.length > 0) {
    throw new RunStateError(
      `Canonical run state at ${path} violates lifecycle invariants and has been blocked: ${issues.join("; ")}.`,
      path,
      issues,
    );
  }
  return structuredClone(state);
}

export function legacyRunProjection(
  state: CanonicalRunState,
): LegacyRunProjection {
  return {
    mode:
      state.run.effectiveWorkerConcurrency === 1 ||
      isPlanOrderChain(state.graph.tasks)
        ? "serial"
        : "parallel",
    currentPhase: state.runtime.phase,
    maxConcurrency: state.run.effectiveWorkerConcurrency,
    taskStatuses: Object.fromEntries(
      Object.entries(state.runtime.tasks).map(([taskId, task]) => [
        taskId,
        task.phase,
      ]),
    ),
  };
}

export function canCleanupCanonicalRun(state: CanonicalRunState): boolean {
  return state.projectionDebt.length === 0 && state.cleanupDebt.length === 0;
}

function invariantIssues(
  state: CanonicalRunState,
  previous?: CanonicalRunState,
): string[] {
  const issues: string[] = [];
  const tasks = new Map<string, CanonicalTaskDefinition>();
  const planIndexes = new Set<number>();
  for (const task of state.graph.tasks) {
    if (tasks.has(task.id)) {
      issues.push(`graph has duplicate task id ${task.id}`);
    }
    if (planIndexes.has(task.planIndex)) {
      issues.push(`graph has duplicate plan index ${task.planIndex}`);
    }
    tasks.set(task.id, task);
    planIndexes.add(task.planIndex);
  }
  for (const task of state.graph.tasks) {
    for (const dependency of task.dependsOn) {
      if (!tasks.has(dependency)) {
        issues.push(`task ${task.id} depends on unknown task ${dependency}`);
      }
      if (dependency === task.id) {
        issues.push(`task ${task.id} depends on itself`);
      }
    }
  }
  if (hasCycle(state.graph.tasks)) {
    issues.push("graph contains a dependency cycle");
  }
  const runtimeIds = Object.keys(state.runtime.tasks);
  if (
    runtimeIds.length !== tasks.size ||
    runtimeIds.some((id) => !tasks.has(id))
  ) {
    issues.push(
      "runtime task records must exactly match immutable graph task IDs",
    );
  }
  if (
    state.run.effectiveWorkerConcurrency > state.run.configuredWorkerConcurrency
  ) {
    issues.push(
      "effective worker concurrency exceeds configured worker concurrency",
    );
  }
  if (state.workerLeases.length > state.run.effectiveWorkerConcurrency) {
    issues.push("worker leases exceed effective worker concurrency");
  }
  const leasedTasks = new Set<string>();
  for (const lease of state.workerLeases) {
    if (!tasks.has(lease.taskId)) {
      issues.push(
        `worker lease ${lease.id} references unknown task ${lease.taskId}`,
      );
    }
    if (leasedTasks.has(lease.taskId)) {
      issues.push(`task ${lease.taskId} has multiple worker leases`);
    }
    leasedTasks.add(lease.taskId);
    const runtime = state.runtime.tasks[lease.taskId];
    if (runtime?.phase !== "executing" || runtime.workerLeaseId !== lease.id) {
      issues.push(
        `worker lease ${lease.id} does not match executing task ${lease.taskId}`,
      );
    }
  }
  const candidateIds = new Set<string>();
  const candidateCommits = new Set<string>();
  for (const [key, candidate] of Object.entries(state.candidates)) {
    if (key !== candidate.id) {
      issues.push(
        `candidate key ${key} does not match candidate id ${candidate.id}`,
      );
    }
    if (candidateIds.has(candidate.id)) {
      issues.push(`duplicate candidate id ${candidate.id}`);
    }
    if (candidateCommits.has(candidate.commitSha)) {
      issues.push(
        `candidate commit ${candidate.commitSha} is not immutable/unique`,
      );
    }
    candidateIds.add(candidate.id);
    candidateCommits.add(candidate.commitSha);
    if (
      candidate.reviewReceipt.candidateId !== candidate.id ||
      candidate.reviewReceipt.candidateCommitSha !== candidate.commitSha ||
      candidate.reviewReceipt.candidateTreeSha !== candidate.treeSha
    ) {
      issues.push(
        `review receipt for candidate ${candidate.id} is not bound to its exact identity`,
      );
    }
  }
  for (const [key, convergence] of Object.entries(state.reviewConvergence)) {
    if (!state.candidates[convergence.candidateId]) {
      issues.push(
        `review convergence ${key} references unknown candidate ${convergence.candidateId}`,
      );
    }
    const findingIds = new Set(
      convergence.findings.map((finding) => finding.id),
    );
    if (convergence.outstandingFindingIds.some((id) => !findingIds.has(id))) {
      issues.push(
        `review convergence ${key} has an unknown outstanding finding`,
      );
    }
  }
  for (const [taskId, runtime] of Object.entries(state.runtime.tasks)) {
    if (
      runtime.phase === "executing" &&
      !state.workerLeases.some(
        (lease) =>
          lease.id === runtime.workerLeaseId && lease.taskId === taskId,
      )
    ) {
      issues.push(`executing task ${taskId} has no matching worker lease`);
    }
    if (
      (runtime.phase === "candidate_ready" ||
        runtime.phase === "waiting_rework" ||
        runtime.phase === "integrating") &&
      !state.candidates[runtime.candidateId]
    ) {
      issues.push(
        `task ${taskId} references unknown candidate ${runtime.candidateId}`,
      );
    }
    if (
      runtime.phase === "integrating" &&
      !state.integrationAttempts.some(
        (attempt) =>
          attempt.id === runtime.integrationAttemptId &&
          attempt.owner.kind === "task" &&
          attempt.owner.taskId === taskId &&
          attempt.candidateId === runtime.candidateId,
      )
    ) {
      issues.push(
        `integrating task ${taskId} has no matching integration attempt`,
      );
    }
  }
  const activeAttempts = state.integrationAttempts.filter(
    (attempt) =>
      attempt.phase === "preparing" ||
      attempt.phase === "prepared" ||
      attempt.phase === "publishing",
  );
  if (activeAttempts.length > 1) {
    issues.push("more than one integration attempt is active");
  }
  const attemptIds = new Set<string>();
  const receiptAttemptIds = new Set<string>();
  for (const attempt of state.integrationAttempts) {
    if (attemptIds.has(attempt.id)) {
      issues.push(`duplicate integration attempt ${attempt.id}`);
    }
    attemptIds.add(attempt.id);
    if (!state.candidates[attempt.candidateId]) {
      issues.push(
        `integration attempt ${attempt.id} references an unknown candidate`,
      );
    }
    if (attempt.owner.kind === "task") {
      const runtime = state.runtime.tasks[attempt.owner.taskId];
      if (!runtime) {
        issues.push(
          `integration attempt ${attempt.id} has an unknown task owner`,
        );
      }
      if (
        attempt.phase !== "paused" &&
        attempt.phase !== "completed" &&
        leasedTasks.has(attempt.owner.taskId)
      ) {
        issues.push(
          `task ${attempt.owner.taskId} owns worker and integration leases`,
        );
      }
    }
  }
  for (const receipt of state.landingReceipts) {
    if (receiptAttemptIds.has(receipt.attemptId)) {
      issues.push(
        `duplicate landing receipt for integration attempt ${receipt.attemptId}`,
      );
    }
    receiptAttemptIds.add(receipt.attemptId);
    const attempt = state.integrationAttempts.find(
      (entry) => entry.id === receipt.attemptId,
    );
    if (!attempt || attempt.phase !== "completed") {
      issues.push(
        `landing receipt ${receipt.attemptId} has no completed integration attempt`,
      );
      continue;
    }
    const candidate = state.candidates[attempt.candidateId];
    if (
      !candidate ||
      JSON.stringify(attempt.owner) !== JSON.stringify(receipt.owner) ||
      candidate.commitSha !== receipt.candidateCommitSha ||
      candidate.treeSha !== receipt.treeSha ||
      attempt.targetBaseSha !== receipt.targetBaseSha ||
      attempt.pipelineHash !== receipt.pipelineHash ||
      attempt.preparedCommitSha !== receipt.integrationCommitSha
    ) {
      issues.push(
        `landing receipt ${receipt.attemptId} does not match its integration attempt and candidate`,
      );
    }
  }
  for (const task of state.graph.tasks) {
    const runtime = state.runtime.tasks[task.id];
    if (
      runtime?.phase === "completed" &&
      runtime.result === "landed" &&
      !state.landingReceipts.some(
        (receipt) =>
          receipt.owner.kind === "task" && receipt.owner.taskId === task.id,
      )
    ) {
      issues.push(
        `completed task ${task.id} is landed without a landing receipt`,
      );
    }
  }
  if (previous) {
    const {
      effectiveWorkerConcurrency: _previousEffectiveWorkerConcurrency,
      ...previousRun
    } = previous.run;
    const {
      effectiveWorkerConcurrency: _effectiveWorkerConcurrency,
      ...nextRun
    } = state.run;
    if (JSON.stringify(previousRun) !== JSON.stringify(nextRun)) {
      issues.push(
        "immutable run identity, graph input, or configured concurrency was overwritten",
      );
    }
    if (
      previous.graph.tasks.length > 0 &&
      JSON.stringify(previous.graph) !== JSON.stringify(state.graph)
    ) {
      issues.push("immutable graph definition was overwritten");
    }
    for (const [id, candidate] of Object.entries(previous.candidates)) {
      if (JSON.stringify(candidate) !== JSON.stringify(state.candidates[id])) {
        issues.push(`immutable candidate ${id} was overwritten or cleared`);
      }
    }
  }
  return issues;
}

function isPlanOrderChain(tasks: CanonicalTaskDefinition[]): boolean {
  const ordered = [...tasks].sort(
    (left, right) => left.planIndex - right.planIndex,
  );
  return ordered.every((task, index) =>
    index === 0
      ? task.dependsOn.length === 0
      : task.dependsOn.length === 1 &&
        task.dependsOn[0] === ordered[index - 1]?.id,
  );
}

function hasCycle(tasks: CanonicalTaskDefinition[]): boolean {
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): boolean => {
    if (visiting.has(id)) {
      return true;
    }
    if (visited.has(id)) {
      return false;
    }
    visiting.add(id);
    const cycle = taskById.get(id)?.dependsOn.some(visit) ?? false;
    visiting.delete(id);
    visited.add(id);
    return cycle;
  };
  return tasks.some((task) => visit(task.id));
}

function writeCanonicalAtomically(
  path: string,
  state: CanonicalRunState,
  hooks: RunStoreHooks,
): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp.${randomBytes(12).toString("hex")}`;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporaryPath, "wx", 0o600);
    writeFileSync(descriptor, JSON.stringify(state, null, 2), "utf-8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    hooks.beforeRename?.(temporaryPath, path);
    renameSync(temporaryPath, path);
  } catch (error) {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
    if (existsSync(temporaryPath)) {
      unlinkSync(temporaryPath);
    }
    throw error;
  }
}

function versionFrom(value: unknown): number | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  return typeof record.schemaVersion === "number"
    ? record.schemaVersion
    : undefined;
}
