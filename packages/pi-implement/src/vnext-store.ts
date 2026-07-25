import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  lstatSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { hostname } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import {
  acquireFileLease,
  ensureGitInfoExclude,
  type FileLease,
} from "@pi-extensions/lib";
import { z } from "zod";
import { writeAtomicJson, type AtomicJsonWriteHooks } from "./atomic-json.js";
import {
  readExecutionPlan,
  writeExecutionPlan,
  type ExecutionPlan,
} from "./execution-plan-vnext.js";
import { recoveryActionKinds, recoveryGateKinds } from "./recovery-vnext.js";
import { normalizeCheckboxMarker } from "./source-checkbox.js";

const nonEmpty = z.string().trim().min(1);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const id = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/);

const artifactSchema = z.object({ path: nonEmpty, hash }).strict();

const sourceIdentitySchema = z
  .object({
    entry: z.object({ path: nonEmpty, normalizedHash: hash }).strict(),
    corpus: z.array(artifactSchema).min(1),
    protectedArtifactHashes: z.record(nonEmpty, hash),
  })
  .strict();

const sourceWorkstreamSchema = z
  .object({
    kind: z.literal("source"),
    id,
    taskIds: z.array(id).min(1),
    dependsOn: z.array(id),
    phase: z.enum([
      "queued",
      "implementing",
      "candidate_ready",
      "reviewing",
      "recovering",
      "approved",
      "reconciling",
      "publishing",
      "completed",
    ]),
    candidateId: nonEmpty.optional(),
  })
  .strict();

const overallWorkstreamSchema = z
  .object({
    kind: z.literal("overall"),
    repairId: id,
    phase: z.enum([
      "queued",
      "implementing",
      "candidate_ready",
      "reviewing",
      "recovering",
      "approved",
      "reconciling",
      "publishing",
      "completed",
    ]),
    candidateId: nonEmpty.optional(),
  })
  .strict();

const processWorkstreamSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("source"), id }).strict(),
  z.object({ kind: z.literal("overall"), repairId: id }).strict(),
]);

const processLeaseSchema = z
  .object({
    id: nonEmpty,
    workstream: processWorkstreamSchema,
    kind: z.enum([
      "implementation",
      "review",
      "recovery",
      "reconciliation",
      "publication",
    ]),
    candidateId: nonEmpty.optional(),
    publicationIntentId: nonEmpty.optional(),
    recoveryEpisodeId: nonEmpty.optional(),
    attempt: z.number().int().positive(),
    acquiredAt: nonEmpty,
  })
  .strict();

const taskRuntimeSchema = z.discriminatedUnion("phase", [
  z.object({ workstreamId: id, phase: z.literal("pending") }).strict(),
  z
    .object({
      workstreamId: id,
      phase: z.literal("satisfaction_claimed"),
      evidence: nonEmpty,
    })
    .strict(),
  z
    .object({
      workstreamId: id,
      phase: z.literal("checkpointed"),
      checkpoint: nonEmpty,
    })
    .strict(),
  z
    .object({
      workstreamId: id,
      phase: z.literal("reviewed_satisfied"),
      evidence: nonEmpty,
    })
    .strict(),
  z
    .object({
      workstreamId: id,
      phase: z.literal("published"),
      checkpoint: nonEmpty.optional(),
      evidence: nonEmpty.optional(),
    })
    .strict()
    .refine(
      (task) => task.checkpoint !== undefined || task.evidence !== undefined,
    ),
]);

const verificationEvidenceSchema = z
  .object({ command: nonEmpty, result: nonEmpty, rationale: nonEmpty })
  .strict();

const candidateSchema = z
  .object({
    id: nonEmpty,
    workstream: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("source"), id }).strict(),
      z.object({ kind: z.literal("overall"), repairId: id }).strict(),
    ]),
    baseSha: nonEmpty,
    commitSha: nonEmpty,
    treeSha: nonEmpty,
    reconciliation: z
      .object({
        targetBaseSha: nonEmpty,
        preparedCommitSha: nonEmpty,
        treeSha: nonEmpty,
        worktreePath: nonEmpty,
        changedPaths: z.array(nonEmpty),
        replayPatchHash: nonEmpty.optional(),
      })
      .strict()
      .optional(),
    implementationEvidence: z
      .object({
        summary: nonEmpty,
        verification: z.array(verificationEvidenceSchema).min(1),
        uncertainty: nonEmpty.optional(),
        artifactPath: nonEmpty.optional(),
        changedPaths: z.array(nonEmpty).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const findingSchema = z
  .object({
    id: nonEmpty,
    candidateId: nonEmpty,
    workstream: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("source"), id }).strict(),
      z.object({ kind: z.literal("overall"), repairId: id }).strict(),
    ]),
    summary: nonEmpty,
    evidence: nonEmpty,
    requiredChange: nonEmpty,
    acceptanceCriteria: z.array(nonEmpty).min(1),
    origin: z.enum(["initial", "regression"]),
    introducedRound: z.number().int().nonnegative(),
    status: z.enum(["open", "resolved"]),
  })
  .strict();

const reviewStateSchema = z
  .object({
    candidateId: nonEmpty,
    previousCandidateId: nonEmpty.optional(),
    round: z.number().int().nonnegative(),
    outstandingIds: z.array(nonEmpty),
    latestCorrection: z
      .object({
        fromCandidateId: nonEmpty,
        changedPaths: z.array(nonEmpty),
        evidence: nonEmpty,
      })
      .strict()
      .optional(),
    evidence: z.array(nonEmpty).min(1),
    observations: z.array(
      z.object({ summary: nonEmpty, evidence: nonEmpty }).strict(),
    ),
  })
  .strict();

const commandEvidenceSchema = z
  .object({
    command: nonEmpty,
    cwd: nonEmpty,
    exitCode: z.number().int().optional(),
    signal: nonEmpty.optional(),
    timedOut: z.boolean(),
    output: z.string().max(12_000),
  })
  .strict();

const gateSchema = z
  .object({
    id: nonEmpty,
    kind: z.enum(recoveryGateKinds),
    workstream: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("source"), id }).strict(),
      z.object({ kind: z.literal("overall"), repairId: id }).strict(),
    ]),
    candidateId: nonEmpty.optional(),
    attempt: z.number().int().positive(),
    outcome: z.enum(["passed", "failed"]),
    evidence: nonEmpty,
    command: commandEvidenceSchema.optional(),
    targetEvidence: nonEmpty.optional(),
    outstandingFindingIds: z.array(nonEmpty),
  })
  .strict();

const recoveryActionSchema = z
  .object({
    kind: z.enum(recoveryActionKinds),
    outcome: z.enum([
      "completed",
      "interrupted",
      "provider_failure",
      "no_safe_action",
    ]),
    summary: nonEmpty,
    evidence: nonEmpty,
    at: nonEmpty,
  })
  .strict();

const recoverySchema = z
  .object({
    id: nonEmpty,
    gateId: nonEmpty,
    gateAttempts: z.array(nonEmpty).min(1),
    workstream: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("source"), id }).strict(),
      z.object({ kind: z.literal("overall"), repairId: id }).strict(),
    ]),
    candidateId: nonEmpty.optional(),
    workspace: z
      .object({
        id: nonEmpty,
        checkpoint: nonEmpty.optional(),
        changedPaths: z.array(nonEmpty),
        stateEvidence: nonEmpty,
      })
      .strict(),
    outstandingFindingIds: z.array(nonEmpty),
    status: z.enum(["open", "paused", "completed"]),
    cycle: z
      .object({
        signature: nonEmpty,
        identicalNoActionCycles: z.number().int().nonnegative(),
        independentlyEscalated: z.boolean(),
      })
      .strict(),
    providerFailures: z.number().int().nonnegative(),
    retryAfterMs: z.number().int().nonnegative().optional(),
    actions: z.array(recoveryActionSchema),
  })
  .strict();

const publicationIntentSchema = z
  .object({
    id: nonEmpty,
    workstream: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("source"), id }).strict(),
      z.object({ kind: z.literal("overall"), repairId: id }).strict(),
    ]),
    candidateId: nonEmpty,
    stagingWorktree: nonEmpty,
    hookEvidence: nonEmpty,
    targetBaseSha: nonEmpty,
    preparedCommitSha: nonEmpty,
    preparedTreeSha: nonEmpty,
    targetRef: nonEmpty,
    protectedArtifactSnapshots: z.record(nonEmpty, z.string()),
    protectedArtifactHashes: z.record(nonEmpty, hash),
  })
  .strict();

const publicationReceiptSchema = z
  .object({
    intentId: nonEmpty,
    candidateId: nonEmpty,
    targetBaseSha: nonEmpty,
    publishedCommitSha: nonEmpty,
    publishedTreeSha: nonEmpty,
    targetRef: nonEmpty,
    protectedArtifactHashes: z.record(nonEmpty, hash),
    publishedAt: nonEmpty,
  })
  .strict();

const projectionDebtSchema = z
  .object({
    id: nonEmpty,
    reason: nonEmpty,
    artifactPath: nonEmpty,
    canonicalPath: nonEmpty,
    expectedOldContent: z.string(),
    expectedOldHash: hash,
    expectedNewContent: z.string(),
    expectedNewHash: hash,
    taskIds: z.array(id).min(1),
  })
  .strict();

const cleanupDebtSchema = z
  .object({
    id: nonEmpty,
    reason: nonEmpty,
    artifactPath: nonEmpty,
    expectedCommitSha: nonEmpty.optional(),
    branchName: nonEmpty.optional(),
    worktreePath: nonEmpty.optional(),
  })
  .strict();

const pauseSchema = z
  .object({
    resumePhase: z.enum(["planning", "running", "whole_plan_review"]),
    reason: nonEmpty.optional(),
  })
  .strict();

const wholePlanReviewSchema = z
  .object({
    status: z.enum(["pending", "reviewing", "repairing", "approved"]),
    reviewedTargetSha: nonEmpty.optional(),
    reviewedTargetTreeSha: nonEmpty.optional(),
    evidence: nonEmpty.optional(),
  })
  .strict()
  .refine(
    (review) =>
      review.status !== "approved" ||
      (review.reviewedTargetSha !== undefined &&
        review.reviewedTargetTreeSha !== undefined &&
        review.evidence !== undefined),
    "An approved whole-plan review requires immutable target identity and evidence.",
  );

export const vnextRunStateSchema = z
  .object({
    version: z.literal(1),
    revision: z.number().int().nonnegative(),
    run: z
      .object({
        id: nonEmpty,
        checkout: z
          .object({
            root: nonEmpty,
            gitDir: nonEmpty,
            commonGitDir: nonEmpty,
            branchRef: nonEmpty,
            startHead: nonEmpty,
          })
          .strict(),
        source: sourceIdentitySchema,
        workerConcurrency: z.number().int().positive(),
      })
      .strict(),
    phase: z.enum([
      "planning",
      "running",
      "whole_plan_review",
      "stopping",
      "paused",
      "blocked_safety",
      "completed",
    ]),
    executionPlan: z.object({ path: nonEmpty, hash }).strict().optional(),
    workstreams: z
      .object({
        source: z.record(id, sourceWorkstreamSchema),
        overall: z.record(id, overallWorkstreamSchema),
      })
      .strict(),
    tasks: z.record(id, taskRuntimeSchema),
    processLeases: z.record(nonEmpty, processLeaseSchema),
    candidates: z.record(nonEmpty, candidateSchema),
    findings: z.record(nonEmpty, findingSchema),
    reviews: z.record(nonEmpty, reviewStateSchema),
    gates: z.array(gateSchema),
    recoveryEpisodes: z.record(nonEmpty, recoverySchema),
    publication: z
      .object({
        intents: z.record(nonEmpty, publicationIntentSchema),
        receipts: z.record(nonEmpty, publicationReceiptSchema),
      })
      .strict(),
    protectedArtifactHashes: z.record(nonEmpty, hash),
    projectionDebt: z.array(projectionDebtSchema),
    cleanupDebt: z.array(cleanupDebtSchema),
    pause: pauseSchema.optional(),
    terminalReason: nonEmpty.optional(),
    wholePlanReview: wholePlanReviewSchema,
    createdAt: nonEmpty,
    updatedAt: nonEmpty,
  })
  .strict();

export type VNextRunState = z.infer<typeof vnextRunStateSchema>;
export type CheckoutPaths = {
  root: string;
  lock: string;
  owner: string;
  runs: string;
  worktrees: string;
  trash: string;
};
export type CheckoutLeaseOwner = {
  runId: string;
  runPath: string;
  checkoutRoot: string;
  gitDir: string;
  pid: number;
  hostname: string;
  startedAt: string;
};
export type CheckoutLeaseCapability = {
  readonly paths: CheckoutPaths;
  readonly owner: CheckoutLeaseOwner;
  assertOwned(): void;
  release(): Promise<void>;
};
export type VNextStoreHooks = AtomicJsonWriteHooks;

export class VNextStateError extends Error {
  constructor(
    message: string,
    readonly path: string,
    readonly issues: string[] = [],
  ) {
    super(message);
  }
}

export class StaleVNextRevisionError extends VNextStateError {
  constructor(path: string, expected: number, actual: number) {
    super(
      `Run state at ${path} changed from revision ${expected} to ${actual}.`,
      path,
    );
  }
}

const updates = new Map<string, Promise<void>>();

export function checkoutPaths(checkoutRoot: string): CheckoutPaths {
  const root = join(resolve(checkoutRoot), ".pi", "implement");
  return {
    root,
    lock: join(root, "checkout.lock"),
    owner: join(root, "checkout.owner.json"),
    runs: join(root, "runs"),
    worktrees: join(root, "worktrees"),
    trash: join(root, "trash"),
  };
}

export async function acquireCheckoutLease(args: {
  checkoutRoot: string;
  runId: string;
  runPath?: string;
  gitDir?: string;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<CheckoutLeaseCapability> {
  assertSafeRunId(args.runId);
  const checkout = resolveGitCheckout(args.checkoutRoot);
  await ensureGitInfoExclude(checkout.root, "/.pi/implement/");
  const paths = checkoutPaths(checkout.root);
  mkdirSync(paths.root, { recursive: true });
  assertPathComponentsAreNotSymlinks(checkout.root, paths.root);
  assertContainedRealpath(
    paths.root,
    checkout.root,
    "Checkout state root is symlinked outside its checkout.",
  );
  const runPath = args.runPath ?? join(paths.runs, args.runId);
  if (resolve(runPath) !== join(paths.runs, args.runId)) {
    throw new VNextStateError(
      "Checkout lease run path escapes its checkout-local runs directory.",
      runPath,
    );
  }
  const lease = await acquireFileLease(paths.lock, {
    timeoutMs: args.timeoutMs,
    signal: args.signal,
  });
  const owner: CheckoutLeaseOwner = {
    runId: args.runId,
    runPath,
    checkoutRoot: checkout.root,
    gitDir: checkout.gitDir,
    pid: process.pid,
    hostname: hostname(),
    startedAt: new Date().toISOString(),
  };
  try {
    writeAtomicJson(paths.owner, owner);
  } catch (error) {
    await lease.release();
    throw error;
  }
  return capability(paths, owner, lease);
}

function capability(
  paths: CheckoutPaths,
  owner: CheckoutLeaseOwner,
  lease: FileLease,
): CheckoutLeaseCapability {
  let released = false;
  let releasePromise: Promise<void> | undefined;
  return {
    paths,
    owner,
    assertOwned() {
      if (released) {
        throw new VNextStateError(
          "Checkout lease capability has been released.",
          paths.lock,
        );
      }
    },
    release() {
      if (releasePromise) {
        return releasePromise;
      }
      released = true;
      releasePromise = (async () => {
        try {
          rmSync(paths.owner, { force: true });
        } finally {
          await lease.release();
        }
      })();
      return releasePromise;
    },
  };
}

export function createPlanningRun(args: {
  lease: CheckoutLeaseCapability;
  runId: string;
  checkout: VNextRunState["run"]["checkout"];
  source: VNextRunState["run"]["source"];
  workerConcurrency: number;
  now?: string;
  hooks?: VNextStoreHooks;
}): VNextRunStore {
  assertLeaseRun(args.lease, args.runId);
  if (
    resolve(args.checkout.root) !== args.lease.owner.checkoutRoot ||
    resolve(args.checkout.gitDir) !== args.lease.owner.gitDir
  ) {
    throw new VNextStateError(
      "Planning state checkout identity does not match its lease-owned checkout.",
      args.lease.paths.root,
    );
  }
  const now = args.now ?? new Date().toISOString();
  const path = runStatePath(args.lease.paths, args.runId);
  const state: VNextRunState = {
    version: 1,
    revision: 0,
    run: {
      id: args.runId,
      checkout: args.checkout,
      source: args.source,
      workerConcurrency: args.workerConcurrency,
    },
    phase: "planning",
    workstreams: { source: {}, overall: {} },
    tasks: {},
    processLeases: {},
    candidates: {},
    findings: {},
    reviews: {},
    gates: [],
    recoveryEpisodes: {},
    publication: { intents: {}, receipts: {} },
    protectedArtifactHashes: args.source.protectedArtifactHashes,
    projectionDebt: [],
    cleanupDebt: [],
    wholePlanReview: { status: "pending" },
    createdAt: now,
    updatedAt: now,
  };
  return VNextRunStore.create(args.lease, path, state, args.hooks);
}

export class VNextRunStore {
  private constructor(
    readonly lease: CheckoutLeaseCapability,
    readonly path: string,
    private snapshot: VNextRunState,
    private readonly hooks: VNextStoreHooks,
  ) {}

  static create(
    lease: CheckoutLeaseCapability,
    path: string,
    initial: VNextRunState,
    hooks: VNextStoreHooks = {},
  ): VNextRunStore {
    assertLeaseRun(lease, initial.run.id);
    assertRunStatePath(lease, path, initial.run.id);
    ensureRunDirectory(lease, initial.run.id);
    if (existsSync(path)) {
      throw new VNextStateError(
        "Canonical VNext run state already exists.",
        path,
      );
    }
    const state = validateVNextRunState(initial, path);
    writeAtomicJson(path, state, hooks);
    return new VNextRunStore(lease, path, state, hooks);
  }

  static open(
    lease: CheckoutLeaseCapability,
    path: string,
    hooks: VNextStoreHooks = {},
  ): VNextRunStore {
    lease.assertOwned();
    const state = loadVNextRunState(path);
    assertLeaseRun(lease, state.run.id);
    assertRunStatePath(lease, path, state.run.id);
    return new VNextRunStore(lease, path, state, hooks);
  }

  read(): VNextRunState {
    return structuredClone(this.snapshot);
  }

  refresh(): VNextRunState {
    this.snapshot = loadVNextRunState(this.path);
    return this.read();
  }

  async update(
    expectedRevision: number,
    update: (current: VNextRunState) => VNextRunState,
  ): Promise<VNextRunState> {
    this.lease.assertOwned();
    const queued = updates.get(this.path) ?? Promise.resolve();
    const operation = queued
      .catch(() => undefined)
      .then(() => {
        this.lease.assertOwned();
        const current = loadVNextRunState(this.path);
        if (current.revision !== expectedRevision) {
          this.snapshot = current;
          throw new StaleVNextRevisionError(
            this.path,
            expectedRevision,
            current.revision,
          );
        }
        const next = validateVNextRunState(
          {
            ...update(structuredClone(current)),
            version: 1,
            revision: current.revision + 1,
            updatedAt: new Date().toISOString(),
          },
          this.path,
          current,
        );
        if (
          JSON.stringify(next.protectedArtifactHashes) !==
          JSON.stringify(current.protectedArtifactHashes)
        ) {
          throw new VNextStateError(
            "Protected artifact hashes may advance only through a projection transition.",
            this.path,
          );
        }
        writeAtomicJson(this.path, next, this.hooks);
        this.snapshot = next;
      });
    updates.set(this.path, operation);
    await operation;
    return this.read();
  }

  async bindExecutionPlan(plan: ExecutionPlan): Promise<VNextRunState> {
    this.lease.assertOwned();
    const current = this.read();
    if (current.phase !== "planning" || current.executionPlan) {
      throw new VNextStateError(
        "Only an unbound planning run can bind an execution plan.",
        this.path,
      );
    }
    validatePlanForRun(plan, current, this.path);
    const runDir = join(this.lease.paths.runs, current.run.id);
    const persisted = readExecutionPlan(runDir);
    if (persisted && persisted.executionPlanHash !== plan.executionPlanHash) {
      throw new VNextStateError(
        "The retained execution plan does not match this planning run.",
        this.path,
      );
    }
    if (!persisted) {
      writeExecutionPlan(runDir, plan);
    }
    return this.update(current.revision, (state) => ({
      ...state,
      phase: "running",
      executionPlan: {
        path: executionPlanPath(this.lease.paths, state.run.id),
        hash: plan.executionPlanHash,
      },
      workstreams: {
        source: Object.fromEntries(
          plan.workstreams.map((workstream) => [
            workstream.id,
            {
              kind: "source" as const,
              id: workstream.id,
              taskIds: workstream.taskIds,
              dependsOn: workstream.dependsOn,
              phase: "queued" as const,
            },
          ]),
        ),
        overall: {},
      },
      tasks: Object.fromEntries(
        plan.tasks.map((task) => [
          task.id,
          {
            workstreamId: plan.workstreams.find((stream) =>
              stream.taskIds.includes(task.id),
            )!.id,
            phase: "pending" as const,
          },
        ]),
      ),
    }));
  }

  async recordProjection(
    expectedRevision: number,
    taskIds: string[],
    protectedArtifactHashes: Record<string, string>,
  ): Promise<VNextRunState> {
    this.lease.assertOwned();
    const current = loadVNextRunState(this.path);
    if (current.revision !== expectedRevision) {
      throw new StaleVNextRevisionError(
        this.path,
        expectedRevision,
        current.revision,
      );
    }
    for (const taskId of taskIds) {
      if (
        !current.tasks[taskId] ||
        !["checkpointed", "reviewed_satisfied", "published"].includes(
          current.tasks[taskId].phase,
        )
      ) {
        throw new VNextStateError(
          "Only checkpointed, reviewed-satisfied, or already-published tasks may be projected.",
          this.path,
        );
      }
    }
    const next = validateVNextRunState(
      {
        ...current,
        revision: current.revision + 1,
        updatedAt: new Date().toISOString(),
        tasks: Object.fromEntries(
          Object.entries(current.tasks).map(([taskId, task]) => [
            taskId,
            taskIds.includes(taskId)
              ? { ...task, phase: "published" as const }
              : task,
          ]),
        ),
        protectedArtifactHashes,
      },
      this.path,
      current,
    );
    if (
      !sameKeys(
        Object.keys(protectedArtifactHashes),
        new Set(Object.keys(current.protectedArtifactHashes)),
      )
    ) {
      throw new VNextStateError(
        "Projection cannot add or remove protected artifacts.",
        this.path,
      );
    }
    if (!sourceIdentityMatches(next) || !protectedArtifactsMatch(next)) {
      throw new VNextStateError(
        "Projection does not match the canonical source or protected artifacts.",
        this.path,
      );
    }
    writeAtomicJson(this.path, next, this.hooks);
    this.snapshot = next;
    return this.read();
  }
}

export function runStatePath(paths: CheckoutPaths, runId: string): string {
  assertSafeRunId(runId);
  return join(paths.runs, runId, "run-state.json");
}

export function executionPlanPath(paths: CheckoutPaths, runId: string): string {
  assertSafeRunId(runId);
  return join(paths.runs, runId, "execution-plan.json");
}

export function loadVNextRunState(path: string): VNextRunState {
  if (!existsSync(path)) {
    throw new VNextStateError(
      "VNext run state is missing; historical state is unsupported.",
      path,
    );
  }
  try {
    return validateVNextRunState(JSON.parse(readFileSync(path, "utf-8")), path);
  } catch (error) {
    if (error instanceof VNextStateError) {
      throw error;
    }
    throw new VNextStateError("VNext run state is malformed JSON.", path, [
      String(error),
    ]);
  }
}

export function validateVNextRunState(
  value: unknown,
  path: string,
  previous?: VNextRunState,
): VNextRunState {
  const parsed = vnextRunStateSchema.safeParse(value);
  if (!parsed.success) {
    const version = versionOf(value);
    const message =
      version === undefined || version !== 1
        ? "VNext run state uses an unsupported historical schema."
        : "VNext run state is invalid.";
    throw new VNextStateError(
      message,
      path,
      parsed.error.issues.map(
        (issue) => `${issue.path.join(".")}: ${issue.message}`,
      ),
    );
  }
  const state = parsed.data;
  const issues = invariantIssues(state, path, previous);
  if (issues.length > 0) {
    throw new VNextStateError(
      "VNext run state violates lifecycle invariants.",
      path,
      issues,
    );
  }
  return structuredClone(state);
}

export function sourceIdentityForPlanning(args: {
  planPath: string;
  planContent: string;
  corpusFiles: Array<{ path: string; hash: string }>;
  uncheckedLineNumbers: number[];
}): VNextRunState["run"]["source"] {
  const planPath = resolve(args.planPath);
  const allArtifacts = args.corpusFiles
    .map((artifact) => ({ path: resolve(artifact.path), hash: artifact.hash }))
    .sort((left, right) => left.path.localeCompare(right.path));
  const entry = allArtifacts.find((artifact) => artifact.path === planPath);
  if (!entry) {
    throw new VNextStateError(
      "Planning corpus does not include its entry plan.",
      planPath,
    );
  }
  const artifacts = [
    entry,
    ...allArtifacts.filter((artifact) => artifact.path !== planPath),
  ];
  const parts = args.planContent.split(/(\r\n|\n)/);
  for (const lineNumber of args.uncheckedLineNumbers) {
    const index = (lineNumber - 1) * 2;
    if (index < 0 || index >= parts.length) {
      throw new VNextStateError(
        "Planning task anchor is outside its entry plan.",
        planPath,
      );
    }
    parts[index] = normalizeCheckboxMarker(parts[index]!);
  }
  return {
    entry: { path: planPath, normalizedHash: sha256(parts.join("")) },
    corpus: artifacts,
    protectedArtifactHashes: Object.fromEntries(
      artifacts.map((artifact) => [artifact.path, artifact.hash]),
    ),
  };
}

export function sourceIdentityForExecutionPlan(
  plan: ExecutionPlan,
): VNextRunState["run"]["source"] {
  const artifacts = [
    { path: plan.source.planPath, hash: plan.source.planHash },
    ...plan.source.corpusFiles.filter(
      (file) => resolve(file.path) !== resolve(plan.source.planPath),
    ),
  ].map((artifact) => ({ path: resolve(artifact.path), hash: artifact.hash }));
  const content = readFileSync(plan.source.planPath, "utf-8");
  if (sha256(content) !== plan.source.planHash) {
    throw new VNextStateError(
      "Source plan changed after execution planning.",
      plan.source.planPath,
    );
  }
  for (const artifact of artifacts) {
    if (sha256(readFileSync(artifact.path, "utf-8")) !== artifact.hash) {
      throw new VNextStateError(
        "Execution-plan corpus changed after planning.",
        artifact.path,
      );
    }
  }
  return {
    entry: {
      path: resolve(plan.source.planPath),
      normalizedHash: sha256(
        normalizeExecutionPlanCheckboxes(content, plan.tasks),
      ),
    },
    corpus: artifacts,
    protectedArtifactHashes: Object.fromEntries(
      artifacts.map((artifact) => [artifact.path, artifact.hash]),
    ),
  };
}

export function sourceIdentityMatches(state: VNextRunState): boolean {
  try {
    const entry = state.run.source.entry;
    const content = readFileSync(entry.path, "utf-8");
    const plan = state.executionPlan
      ? readExecutionPlan(join(state.executionPlan.path, ".."))
      : undefined;
    const published = (plan?.tasks ?? []).filter(
      (task) => state.tasks[task.id]?.phase === "published",
    );
    if (
      sha256(normalizeExecutionPlanCheckboxes(content, published)) !==
      entry.normalizedHash
    ) {
      return false;
    }
    return state.run.source.corpus
      .filter((artifact) => resolve(artifact.path) !== resolve(entry.path))
      .every(
        (artifact) =>
          sha256(readFileSync(artifact.path, "utf-8")) === artifact.hash,
      );
  } catch {
    return false;
  }
}

export function protectedArtifactsMatch(state: VNextRunState): boolean {
  try {
    return Object.entries(state.protectedArtifactHashes).every(
      ([path, expected]) => sha256(readFileSync(path, "utf-8")) === expected,
    );
  } catch {
    return false;
  }
}

function validatePlanForRun(
  plan: ExecutionPlan,
  state: VNextRunState,
  path: string,
): void {
  if (
    plan.source.checkoutId !== state.run.checkout.gitDir ||
    plan.source.baseSha !== state.run.checkout.startHead ||
    plan.workerConcurrency !== state.run.workerConcurrency
  ) {
    throw new VNextStateError(
      "Execution plan identity does not match this planning run.",
      path,
    );
  }
  const source = sourceIdentityForExecutionPlan(plan);
  if (JSON.stringify(source) !== JSON.stringify(state.run.source)) {
    throw new VNextStateError(
      "Execution plan source identity does not match this planning run.",
      path,
    );
  }
}

function invariantIssues(
  state: VNextRunState,
  path: string,
  previous?: VNextRunState,
): string[] {
  const issues: string[] = [];
  const bound = state.executionPlan !== undefined;
  if (state.phase === "planning" && bound) {
    issues.push("planning cannot bind an execution plan");
  }
  if (
    !bound &&
    !["planning", "stopping", "paused", "blocked_safety"].includes(state.phase)
  ) {
    issues.push(
      "only planning-derived pause, stop, and safety states may be unbound",
    );
  }
  if (
    !bound &&
    (Object.keys(state.workstreams.source).length > 0 ||
      Object.keys(state.tasks).length > 0)
  ) {
    issues.push(
      "an unbound planning run cannot have runtime workstreams or tasks",
    );
  }
  let plan: ExecutionPlan | undefined;
  if (bound) {
    if (state.executionPlan!.path !== join(path, "..", "execution-plan.json")) {
      issues.push("execution plan path is not checkout-local to the run state");
    }
    plan = readExecutionPlan(join(state.executionPlan!.path, ".."));
    if (!plan || plan.executionPlanHash !== state.executionPlan!.hash) {
      issues.push(
        "execution plan is missing, invalid, or has a mismatched hash",
      );
    } else {
      if (
        plan.source.checkoutId !== state.run.checkout.gitDir ||
        plan.source.baseSha !== state.run.checkout.startHead ||
        plan.workerConcurrency !== state.run.workerConcurrency
      ) {
        issues.push(
          "execution plan identity does not match the immutable run identity",
        );
      }
      const plannedStreams = new Set(
        plan.workstreams.map((workstream) => workstream.id),
      );
      if (!sameKeys(Object.keys(state.workstreams.source), plannedStreams)) {
        issues.push(
          "source workstream records must exactly match the execution plan",
        );
      }
      const plannedTasks = new Set(plan.tasks.map((task) => task.id));
      if (!sameKeys(Object.keys(state.tasks), plannedTasks)) {
        issues.push(
          "task runtime records must exactly match the execution plan",
        );
      }
      for (const workstream of Object.values(state.workstreams.source)) {
        const expected = plan.workstreams.find(
          (candidate) => candidate.id === workstream.id,
        );
        if (
          !expected ||
          JSON.stringify({
            taskIds: workstream.taskIds,
            dependsOn: workstream.dependsOn,
          }) !==
            JSON.stringify({
              taskIds: expected.taskIds,
              dependsOn: expected.dependsOn,
            })
        ) {
          issues.push(
            `source workstream ${workstream.id} does not match the execution plan`,
          );
        }
      }
      for (const task of plan.tasks) {
        const expectedStream = plan.workstreams.find((stream) =>
          stream.taskIds.includes(task.id),
        );
        if (state.tasks[task.id]?.workstreamId !== expectedStream?.id) {
          issues.push(`task ${task.id} has an invalid workstream owner`);
        }
      }
    }
  }
  for (const [key, workstream] of Object.entries(state.workstreams.source)) {
    if (key !== workstream.id) {
      issues.push(`source workstream key ${key} does not match its ID`);
    }
  }
  for (const [key, workstream] of Object.entries(state.workstreams.overall)) {
    if (key !== workstream.repairId) {
      issues.push(`overall workstream key ${key} does not match its repair ID`);
    }
  }
  if (Object.keys(state.processLeases).length > state.run.workerConcurrency) {
    issues.push("active process leases exceed configured worker concurrency");
  }
  if (
    Object.values(state.processLeases).filter(
      (lease) => lease.kind === "publication",
    ).length > 1
  ) {
    issues.push("publication is serialized to one active process lease");
  }
  if (
    (state.phase === "stopping" || state.phase === "paused") !==
    (state.pause !== undefined)
  ) {
    issues.push("only stopping and paused runs retain resumable pause state");
  }
  if (state.phase === "blocked_safety" && !state.terminalReason) {
    issues.push("a safety-blocked run requires a terminal reason");
  }
  if (
    state.phase === "completed" &&
    state.wholePlanReview.status !== "approved"
  ) {
    issues.push("a completed run requires an approved whole-plan review");
  }
  const activeWorkstreams = new Set<string>();
  for (const [key, lease] of Object.entries(state.processLeases)) {
    if (key !== lease.id) {
      issues.push(`process lease key ${key} does not match its ID`);
    }
    if (!workstreamExists(state, lease.workstream)) {
      issues.push(`process lease ${key} references an unknown workstream`);
      continue;
    }
    const workstreamKey = workstreamIdentity(lease.workstream);
    if (activeWorkstreams.has(workstreamKey)) {
      issues.push(
        `workstream ${workstreamKey} has more than one active process lease`,
      );
    }
    activeWorkstreams.add(workstreamKey);
    if (
      lease.workstream.kind === "overall" &&
      (state.phase !== "whole_plan_review" ||
        Object.values(state.workstreams.source).some(
          (workstream) => workstream.phase !== "completed",
        ))
    ) {
      issues.push(
        `overall process lease ${key} is not ready for whole-plan repair`,
      );
    }
    if (lease.candidateId !== workstreamCandidateId(state, lease.workstream)) {
      issues.push(`process lease ${key} does not match its current candidate`);
    }
    const phase = workstreamPhase(state, lease.workstream);
    const expectedPhase =
      lease.kind === "implementation"
        ? "implementing"
        : lease.kind === "review"
          ? "reviewing"
          : lease.kind === "recovery"
            ? "recovering"
            : lease.kind === "reconciliation"
              ? "reconciling"
              : "publishing";
    if (phase !== expectedPhase) {
      issues.push(`process lease ${key} does not match its workstream phase`);
    }
    if (
      lease.kind === "publication" &&
      (!lease.publicationIntentId ||
        state.publication.intents[lease.publicationIntentId]?.candidateId !==
          lease.candidateId)
    ) {
      issues.push(
        `publication lease ${key} does not match an immutable intent`,
      );
    }
    if (
      lease.kind === "recovery" &&
      (!lease.recoveryEpisodeId ||
        state.recoveryEpisodes[lease.recoveryEpisodeId]?.status !== "open")
    ) {
      issues.push(`recovery lease ${key} does not match an open episode`);
    }
    if (lease.kind !== "recovery" && lease.recoveryEpisodeId !== undefined) {
      issues.push(`non-recovery lease ${key} references a recovery episode`);
    }
  }
  if (
    state.phase === "planning" &&
    Object.keys(state.processLeases).length > 0
  ) {
    issues.push("an unbound planning run cannot have process leases");
  }
  for (const [key, candidate] of Object.entries(state.candidates)) {
    if (key !== candidate.id) {
      issues.push(`candidate key ${key} does not match its ID`);
    }
    if (!workstreamExists(state, candidate.workstream)) {
      issues.push(`candidate ${key} references an unknown workstream`);
    }
  }
  for (const [key, finding] of Object.entries(state.findings)) {
    if (key !== finding.id) {
      issues.push(`finding key ${key} does not match its ID`);
    }
    const candidate = state.candidates[finding.candidateId];
    if (
      !candidate ||
      !workstreamExists(state, finding.workstream) ||
      JSON.stringify(candidate.workstream) !==
        JSON.stringify(finding.workstream)
    ) {
      issues.push(`finding ${key} references unknown candidate or workstream`);
    }
  }
  for (const [key, review] of Object.entries(state.reviews)) {
    const candidate = state.candidates[review.candidateId];
    if (!candidate || key !== workstreamIdentity(candidate.workstream)) {
      issues.push(
        `review ${key} references an unknown candidate or workstream`,
      );
      continue;
    }
    if (
      workstreamCandidateId(state, candidate.workstream) !== review.candidateId
    ) {
      issues.push(`review ${key} does not match its workstream candidate`);
    }
    const outstanding = new Set(review.outstandingIds);
    if (outstanding.size !== review.outstandingIds.length) {
      issues.push(`review ${key} repeats an outstanding finding ID`);
    }
    const streamFindings = Object.values(state.findings).filter(
      (finding) =>
        JSON.stringify(finding.workstream) ===
        JSON.stringify(candidate.workstream),
    );
    for (const finding of streamFindings) {
      if ((finding.status === "open") !== outstanding.has(finding.id)) {
        issues.push(
          `review ${key} has inconsistent outstanding finding ${finding.id}`,
        );
      }
    }
    if (
      review.previousCandidateId &&
      (!state.candidates[review.previousCandidateId] ||
        !review.latestCorrection ||
        review.latestCorrection.fromCandidateId !== review.previousCandidateId)
    ) {
      issues.push(`review ${key} has an invalid correction anchor`);
    }
  }
  for (const workstream of [
    ...Object.values(state.workstreams.source),
    ...Object.values(state.workstreams.overall),
  ]) {
    if (workstream.phase === "approved" || workstream.phase === "completed") {
      const candidateId = workstream.candidateId;
      const candidate = candidateId ? state.candidates[candidateId] : undefined;
      const review = candidate
        ? state.reviews[workstreamIdentity(candidate.workstream)]
        : undefined;
      if (
        !review ||
        review.candidateId !== candidateId ||
        review.outstandingIds.length > 0
      ) {
        issues.push(
          "approved or completed workstreams require a converged current review",
        );
      }
    }
  }
  const gates = new Set<string>();
  for (const gate of state.gates) {
    if (gates.has(gate.id)) {
      issues.push(`duplicate gate ${gate.id}`);
    }
    gates.add(gate.id);
    const candidate = gate.candidateId
      ? state.candidates[gate.candidateId]
      : undefined;
    if (
      !workstreamExists(state, gate.workstream) ||
      (gate.candidateId &&
        (!candidate ||
          JSON.stringify(candidate.workstream) !==
            JSON.stringify(gate.workstream)))
    ) {
      issues.push(`gate ${gate.id} references unknown workstream or candidate`);
    }
  }
  for (const gate of state.gates.filter((gate) => gate.outcome === "failed")) {
    if (
      !Object.values(state.recoveryEpisodes).some(
        (episode) => episode.gateId === gate.id,
      )
    ) {
      issues.push(`failed gate ${gate.id} has no durable recovery episode`);
    }
  }
  for (const [key, recovery] of Object.entries(state.recoveryEpisodes)) {
    const gate = state.gates.find(
      (candidate) => candidate.id === recovery.gateId,
    );
    if (
      key !== recovery.id ||
      !gate ||
      gate.outcome !== "failed" ||
      !recovery.gateAttempts.includes(recovery.gateId) ||
      recovery.gateAttempts.some(
        (attemptId) =>
          !state.gates.some((candidate) => candidate.id === attemptId),
      ) ||
      !sameWorkstreamIdentity(gate.workstream, recovery.workstream) ||
      gate.candidateId !== recovery.candidateId ||
      JSON.stringify(gate.outstandingFindingIds) !==
        JSON.stringify(recovery.outstandingFindingIds)
    ) {
      issues.push(`recovery episode ${key} does not match its failed gate`);
    }
    if (
      recovery.outstandingFindingIds.some(
        (findingId) =>
          !state.findings[findingId] ||
          !sameWorkstreamIdentity(
            state.findings[findingId]!.workstream,
            recovery.workstream,
          ),
      )
    ) {
      issues.push(`recovery episode ${key} references an unknown finding`);
    }
    if (recovery.status === "completed" && recovery.actions.length === 0) {
      issues.push(`completed recovery episode ${key} has no action evidence`);
    }
  }
  for (const [key, intent] of Object.entries(state.publication.intents)) {
    const candidate = state.candidates[intent.candidateId];
    if (
      key !== intent.id ||
      !candidate ||
      !sameWorkstreamIdentity(candidate.workstream, intent.workstream) ||
      workstreamCandidateId(state, intent.workstream) !== intent.candidateId ||
      intent.targetRef !== state.run.checkout.branchRef ||
      (candidate.reconciliation
        ? intent.targetBaseSha !== candidate.reconciliation.targetBaseSha ||
          intent.preparedCommitSha !==
            candidate.reconciliation.preparedCommitSha ||
          intent.preparedTreeSha !== candidate.reconciliation.treeSha ||
          intent.stagingWorktree !== candidate.reconciliation.worktreePath
        : intent.targetBaseSha !== candidate.baseSha ||
          intent.preparedCommitSha !== candidate.commitSha ||
          intent.preparedTreeSha !== candidate.treeSha)
    ) {
      issues.push(
        `publication intent ${key} does not match its approved candidate`,
      );
    }
  }
  for (const [key, receipt] of Object.entries(state.publication.receipts)) {
    const intent = state.publication.intents[receipt.intentId];
    if (
      key !== receipt.intentId ||
      !intent ||
      intent.candidateId !== receipt.candidateId ||
      intent.targetBaseSha !== receipt.targetBaseSha ||
      intent.preparedCommitSha !== receipt.publishedCommitSha ||
      intent.preparedTreeSha !== receipt.publishedTreeSha ||
      intent.targetRef !== receipt.targetRef ||
      JSON.stringify(intent.protectedArtifactHashes) !==
        JSON.stringify(receipt.protectedArtifactHashes)
    ) {
      issues.push(
        `publication receipt ${key} has no matching immutable intent`,
      );
    }
  }
  if (previous) {
    if (JSON.stringify(previous.run) !== JSON.stringify(state.run)) {
      issues.push("immutable run identity was overwritten");
    }
    if (
      previous.executionPlan &&
      JSON.stringify(previous.executionPlan) !==
        JSON.stringify(state.executionPlan)
    ) {
      issues.push("bound execution plan identity was overwritten");
    }
    for (const [id, candidate] of Object.entries(previous.candidates)) {
      if (JSON.stringify(state.candidates[id]) !== JSON.stringify(candidate)) {
        issues.push(`candidate ${id} was overwritten or removed`);
      }
    }
    for (const [id, finding] of Object.entries(previous.findings)) {
      if (
        finding.status === "resolved" &&
        state.findings[id]?.status !== "resolved"
      ) {
        issues.push(`resolved finding ${id} was reopened`);
      }
    }
    for (const [id, intent] of Object.entries(previous.publication.intents)) {
      if (
        JSON.stringify(state.publication.intents[id]) !== JSON.stringify(intent)
      ) {
        issues.push(`publication intent ${id} was overwritten or removed`);
      }
    }
    for (const [id, receipt] of Object.entries(previous.publication.receipts)) {
      if (
        JSON.stringify(state.publication.receipts[id]) !==
        JSON.stringify(receipt)
      ) {
        issues.push(`publication receipt ${id} was overwritten or removed`);
      }
    }
  }
  if (previous) {
    for (const gate of previous.gates) {
      const retained = state.gates.find(
        (candidate) => candidate.id === gate.id,
      );
      if (!retained || JSON.stringify(retained) !== JSON.stringify(gate)) {
        issues.push(`gate ${gate.id} is not immutable`);
      }
    }
    for (const [id, episode] of Object.entries(previous.recoveryEpisodes)) {
      const retained = state.recoveryEpisodes[id];
      if (!retained || !sameRecoveryEpisodeHistory(episode, retained)) {
        issues.push(`recovery episode ${id} rewrites retained history`);
      }
    }
  }
  return issues;
}

function sameRecoveryEpisodeHistory(
  previous: VNextRunState["recoveryEpisodes"][string],
  next: VNextRunState["recoveryEpisodes"][string],
): boolean {
  const actionsAppended = next.actions.length > previous.actions.length;
  const resumed = previous.status === "paused" && next.status === "open";
  const mutableStateChanged =
    previous.status !== next.status ||
    JSON.stringify(previous.cycle) !== JSON.stringify(next.cycle) ||
    previous.providerFailures !== next.providerFailures ||
    previous.retryAfterMs !== next.retryAfterMs;
  return (
    previous.id === next.id &&
    previous.gateId === next.gateId &&
    (previous.status !== "completed" || next.status === "completed") &&
    (!mutableStateChanged || actionsAppended || resumed) &&
    JSON.stringify(previous.workstream) === JSON.stringify(next.workstream) &&
    previous.candidateId === next.candidateId &&
    JSON.stringify(previous.workspace) === JSON.stringify(next.workspace) &&
    JSON.stringify(previous.outstandingFindingIds) ===
      JSON.stringify(next.outstandingFindingIds) &&
    next.gateAttempts.length >= previous.gateAttempts.length &&
    previous.gateAttempts.every(
      (attempt, index) => attempt === next.gateAttempts[index],
    ) &&
    next.actions.length >= previous.actions.length &&
    previous.actions.every(
      (action, index) =>
        JSON.stringify(action) === JSON.stringify(next.actions[index]),
    )
  );
}

function workstreamExists(
  state: VNextRunState,
  workstream: z.infer<typeof candidateSchema>["workstream"],
): boolean {
  return workstream.kind === "source"
    ? state.workstreams.source[workstream.id] !== undefined
    : state.workstreams.overall[workstream.repairId] !== undefined;
}

function workstreamIdentity(
  workstream: z.infer<typeof candidateSchema>["workstream"],
): string {
  return workstream.kind === "source"
    ? `source:${workstream.id}`
    : `overall:${workstream.repairId}`;
}

function sameWorkstreamIdentity(
  left: z.infer<typeof candidateSchema>["workstream"],
  right: z.infer<typeof candidateSchema>["workstream"],
): boolean {
  return workstreamIdentity(left) === workstreamIdentity(right);
}

function workstreamPhase(
  state: VNextRunState,
  workstream: z.infer<typeof candidateSchema>["workstream"],
): string | undefined {
  return workstream.kind === "source"
    ? state.workstreams.source[workstream.id]?.phase
    : state.workstreams.overall[workstream.repairId]?.phase;
}

function workstreamCandidateId(
  state: VNextRunState,
  workstream: z.infer<typeof candidateSchema>["workstream"],
): string | undefined {
  return workstream.kind === "source"
    ? state.workstreams.source[workstream.id]?.candidateId
    : state.workstreams.overall[workstream.repairId]?.candidateId;
}

function resolveGitCheckout(cwd: string): { root: string; gitDir: string } {
  try {
    const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf-8",
    }).trim();
    const gitDir = execFileSync(
      "git",
      ["rev-parse", "--path-format=absolute", "--git-dir"],
      { cwd: root, encoding: "utf-8" },
    ).trim();
    return { root: realpathSync(root), gitDir: realpathSync(gitDir) };
  } catch (error) {
    throw new VNextStateError(
      "Pi-implement requires a Git worktree containing the invocation directory.",
      cwd,
      [error instanceof Error ? error.message : String(error)],
    );
  }
}

function assertContainedRealpath(
  path: string,
  root: string,
  message: string,
): void {
  const actual = realpathSync(path);
  const relativePath = relative(realpathSync(root), actual);
  if (
    relativePath === ".." ||
    relativePath.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
  ) {
    throw new VNextStateError(message, path);
  }
}

function assertPathComponentsAreNotSymlinks(root: string, path: string): void {
  const relativePath = relative(root, path);
  if (
    relativePath === "" ||
    relativePath === ".." ||
    relativePath.startsWith("../")
  ) {
    throw new VNextStateError(
      "Checkout state path escapes the target checkout.",
      path,
    );
  }
  let current = root;
  for (const component of relativePath.split("/")) {
    current = join(current, component);
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) {
      throw new VNextStateError(
        "Checkout state path cannot contain symlinks.",
        current,
      );
    }
  }
}

function ensureRunDirectory(
  lease: CheckoutLeaseCapability,
  runId: string,
): void {
  const directory = dirname(runStatePath(lease.paths, runId));
  mkdirSync(directory, { recursive: true });
  assertPathComponentsAreNotSymlinks(lease.paths.root, directory);
  assertContainedRealpath(
    directory,
    lease.paths.root,
    "Run directory is symlinked outside the lease-owned checkout.",
  );
}

function assertSafeRunId(runId: string): void {
  if (!id.safeParse(runId).success) {
    throw new VNextStateError(
      "Run IDs must be safe checkout-local path segments.",
      runId,
    );
  }
}

function assertLeaseRun(lease: CheckoutLeaseCapability, runId: string): void {
  lease.assertOwned();
  assertSafeRunId(runId);
  if (
    lease.owner.runId !== runId ||
    lease.owner.runPath !== join(lease.paths.runs, runId)
  ) {
    throw new VNextStateError(
      "Checkout lease capability is not authorized for this run.",
      lease.paths.root,
    );
  }
}

function assertRunStatePath(
  lease: CheckoutLeaseCapability,
  path: string,
  runId: string,
): void {
  if (resolve(path) !== runStatePath(lease.paths, runId)) {
    throw new VNextStateError(
      "Run state path is not checkout-local to the lease-owned run.",
      path,
    );
  }
}

function normalizeExecutionPlanCheckboxes(
  content: string,
  tasks: Array<{
    sourceAnchor: { path: string; lineNumber: number; lineText: string };
  }>,
): string {
  const parts = content.split(/(\r\n|\n)/);
  for (const task of tasks) {
    const index = (task.sourceAnchor.lineNumber - 1) * 2;
    const line = parts[index];
    if (
      line === undefined ||
      normalizeCheckboxMarker(line) !==
        normalizeCheckboxMarker(task.sourceAnchor.lineText)
    ) {
      throw new VNextStateError(
        "Source plan no longer matches an execution-plan task anchor.",
        task.sourceAnchor.path,
      );
    }
    parts[index] = normalizeCheckboxMarker(line);
  }
  return parts.join("");
}

function sameKeys(actual: string[], expected: Set<string>): boolean {
  return (
    actual.length === expected.size && actual.every((key) => expected.has(key))
  );
}

function versionOf(value: unknown): number | undefined {
  return typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as { version?: unknown }).version === "number"
    ? (value as { version: number }).version
    : undefined;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function makeVNextRunId(): string {
  return `r${Date.now().toString(36)}-${randomBytes(8).toString("hex")}`;
}
