import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
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
import { acquireFileLease, type FileLease } from "#lib/file-lease";
import { ensureGitInfoExclude } from "#lib/git";
import { z } from "zod";
import { writeAtomicJson, type AtomicJsonWriteHooks } from "./atomic-json.js";
import {
  publicationIntentId,
  publicationPreparationId,
  stagingIdentity,
} from "./candidate-replay.js";
import {
  readExecutionPlan,
  writeExecutionPlan,
  type ExecutionPlan,
} from "./execution-plan.js";
import { failureAssignmentKinds, failureCategories } from "./failure-policy.js";
import { loadRequirementsContext } from "./requirements-context.js";
import {
  canonicalPath,
  normalizeCheckboxMarker,
  protectedArtifactsMatch as artifactHashesMatch,
  sha256,
} from "./source-integrity.js";

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
      "revising",
      "recreating_workspace",
      "reconciliation_required",
      "approved",
      "reconciling",
      "publishing",
      "completed",
      "failed",
      "dependency_skipped",
    ]),
    baseSha: nonEmpty.optional(),
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
      "revising",
      "recreating_workspace",
      "reconciliation_required",
      "approved",
      "reconciling",
      "publishing",
      "completed",
      "failed",
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
      "revision",
      "workspace_recreation",
      "reconciliation",
      "publication",
    ]),
    candidateId: nonEmpty.optional(),
    publicationIntentId: nonEmpty.optional(),
    revisionAssignmentId: nonEmpty.optional(),
    reconciliationAssignmentId: nonEmpty.optional(),
    workspaceRecreationId: nonEmpty.optional(),
    attempt: z.number().int().positive(),
    acquiredAt: nonEmpty,
  })
  .strict();

const operationSettlementSchema = z
  .object({
    operationId: nonEmpty,
    workstream: processWorkstreamSchema,
    kind: processLeaseSchema.shape.kind,
    candidateId: nonEmpty.optional(),
    publicationIntentId: nonEmpty.optional(),
    revisionAssignmentId: nonEmpty.optional(),
    reconciliationAssignmentId: nonEmpty.optional(),
    workspaceRecreationId: nonEmpty.optional(),
    attempt: z.number().int().positive(),
    acquiredAt: nonEmpty,
    outcome: nonEmpty,
    eventFingerprint: nonEmpty,
    settledAt: nonEmpty,
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

const candidateSchema = z
  .object({
    id: nonEmpty,
    workstream: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("source"), id }).strict(),
      z.object({ kind: z.literal("overall"), repairId: id }).strict(),
    ]),
    baseSha: nonEmpty,
    integrationBaseSha: nonEmpty.optional(),
    commitSha: nonEmpty,
    treeSha: nonEmpty,
    evidenceStatus: z.enum(["reported", "unavailable"]).optional(),
    observationArtifact: nonEmpty.optional(),
    changedPaths: z.array(nonEmpty).optional(),
    implementationEvidence: z
      .object({
        summary: nonEmpty,
        verification: z.array(nonEmpty).min(1),
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
    scope: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("source"), id }).strict(),
      z
        .object({
          kind: z.literal("whole_plan"),
          initialTargetSha: nonEmpty,
          initialTargetTreeSha: nonEmpty,
        })
        .strict(),
    ]),
    summary: nonEmpty,
    evidence: nonEmpty,
    requiredChange: nonEmpty,
    acceptanceCriteria: z.array(nonEmpty).min(1),
    origin: z.enum(["initial", "regression"]),
    introducedRound: z.number().int().nonnegative(),
    disposition: z.enum(["blocking", "advisory"]),
    status: z.enum(["open", "resolved"]),
  })
  .strict();

const reviewStateSchema = z
  .object({
    candidateId: nonEmpty,
    comparisonBase: nonEmpty,
    previousCandidateId: nonEmpty.optional(),
    round: z.number().int().nonnegative(),
    pendingCorrectionIds: z.array(nonEmpty),
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
    publicationCommitSubject: nonEmpty.optional(),
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

const failureWorkstreamSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("source"), id }).strict(),
  z.object({ kind: z.literal("overall"), repairId: id }).strict(),
]);

const workspaceObservationSchema = z
  .object({
    branch: z.string(),
    head: nonEmpty,
    tree: nonEmpty.optional(),
    clean: z.boolean(),
    activeOperation: nonEmpty.optional(),
    status: z.array(
      z.object({ status: nonEmpty, path: nonEmpty }).passthrough(),
    ),
  })
  .strict();

const failureRecordSchema = z
  .object({
    id: nonEmpty,
    category: z.enum(failureCategories),
    assignment: z.enum(failureAssignmentKinds),
    workstream: failureWorkstreamSchema,
    candidateId: nonEmpty.optional(),
    gate: nonEmpty.optional(),
    evidence: nonEmpty,
    command: commandEvidenceSchema.optional(),
    targetEvidence: nonEmpty.optional(),
    observation: workspaceObservationSchema.optional(),
    at: nonEmpty,
  })
  .strict();

const revisionAssignmentSchema = z
  .object({
    id: nonEmpty,
    workstream: failureWorkstreamSchema,
    candidateId: nonEmpty,
    comparisonBase: nonEmpty,
    findingEpoch: z.number().int().nonnegative(),
    pendingCorrectionIds: z.array(nonEmpty),
    evidence: z.array(nonEmpty),
    status: z.enum(["open", "completed", "blocked"]),
    executionFailures: z.number().int().nonnegative(),
    noProgress: z
      .object({ signature: nonEmpty, attempts: z.number().int().nonnegative() })
      .strict(),
  })
  .strict();

const operationalRetrySchema = z
  .object({
    id: nonEmpty,
    workstream: failureWorkstreamSchema,
    lane: z.enum([
      "implementation",
      "review",
      "revision",
      "reconciliation",
      "publication",
      "whole_plan_review",
    ]),
    candidateId: nonEmpty.optional(),
    attempts: z.number().int().nonnegative(),
    evidence: z.array(nonEmpty),
    status: z.enum(["open", "exhausted", "completed"]),
  })
  .strict();

const workspaceRecreationSchema = z
  .object({
    id: nonEmpty,
    workstream: failureWorkstreamSchema,
    candidateId: nonEmpty.optional(),
    checkpoint: nonEmpty,
    resumePhase: z.enum([
      "queued",
      "candidate_ready",
      "revising",
      "reconciliation_required",
      "approved",
    ]),
    status: z.enum([
      "pending",
      "running",
      "restored",
      "still_quarantined",
      "unsafe",
    ]),
    before: workspaceObservationSchema.optional(),
    after: workspaceObservationSchema.optional(),
    evidence: z.array(nonEmpty),
  })
  .strict();

const reconciliationContextSchema = z
  .object({
    key: nonEmpty,
    workstream: failureWorkstreamSchema,
    candidateTreeSha: nonEmpty,
    targetSha: nonEmpty,
    disposition: z.enum(["overlap", "conflict", "changed_patch"]),
    relevantPaths: z.array(nonEmpty),
  })
  .strict();

const reconciliationAssignmentSchema = z
  .object({
    id: nonEmpty,
    workstream: failureWorkstreamSchema,
    candidateId: nonEmpty,
    candidateCommitSha: nonEmpty,
    candidateTreeSha: nonEmpty,
    targetSha: nonEmpty,
    targetTreeSha: nonEmpty,
    disposition: z.enum(["overlap", "conflict", "changed_patch"]),
    context: reconciliationContextSchema,
    paths: z
      .object({
        candidate: z.array(nonEmpty),
        target: z.array(nonEmpty),
        replay: z.array(nonEmpty),
      })
      .strict(),
    operationId: nonEmpty,
    staging: z
      .object({
        id: nonEmpty,
        branchName: nonEmpty,
        targetRef: nonEmpty,
        replayPatchHash: hash.optional(),
        hookCommand: commandEvidenceSchema.optional(),
      })
      .strict(),
    evidence: nonEmpty,
    hookEvidence: nonEmpty.optional(),
    semanticAttempt: z.enum(["initial", "escalated"]),
    priorAttemptEvidence: z.array(nonEmpty),
    attemptEvidence: z.array(nonEmpty),
    status: z.enum(["pending", "completed", "blocked"]),
    executionFailures: z.number().int().nonnegative(),
  })
  .strict();

const satisfactionReceiptSchema = z
  .object({
    id: nonEmpty,
    candidateId: nonEmpty,
    workstream: z.object({ kind: z.literal("source"), id }).strict(),
    assessedTargetSha: nonEmpty,
    evidence: nonEmpty,
    assessedAt: nonEmpty,
  })
  .strict();

const satisfactionAssessmentSchema = z
  .object({
    id: nonEmpty,
    candidateId: nonEmpty,
    workstream: z.object({ kind: z.literal("source"), id }).strict(),
    historicalBaseSha: nonEmpty,
    targetSha: nonEmpty,
    operationId: nonEmpty.optional(),
    evidence: nonEmpty,
    status: z.enum(["pending", "approved", "rejected"]),
  })
  .strict();

const publicationPreparationSchema = z
  .object({
    id: nonEmpty,
    operationId: nonEmpty,
    candidateId: nonEmpty,
    candidateCommitSha: nonEmpty,
    candidateTreeSha: nonEmpty,
    targetBaseSha: nonEmpty,
    targetRef: nonEmpty,
    preparedCommitSha: nonEmpty,
    preparedTreeSha: nonEmpty,
    stagingWorktree: nonEmpty,
    stagingBranch: nonEmpty,
    replayPatchHash: hash,
    changedPaths: z.array(nonEmpty),
    disposition: z.enum([
      "same_base",
      "reconciled_same_base",
      "clean_non_overlap",
    ]),
    hookEvidence: nonEmpty,
    hookCommand: commandEvidenceSchema,
  })
  .strict();

const publicationIntentSchema = z
  .object({
    id: nonEmpty,
    operationId: nonEmpty,
    workstream: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("source"), id }).strict(),
      z.object({ kind: z.literal("overall"), repairId: id }).strict(),
    ]),
    candidateId: nonEmpty,
    preparationId: nonEmpty,
    targetBaseSha: nonEmpty,
    preparedCommitSha: nonEmpty,
    preparedTreeSha: nonEmpty,
    targetRef: nonEmpty,
    protectedArtifactSnapshots: z.record(nonEmpty, z.string()),
    protectedArtifactHashes: z.record(nonEmpty, hash),
  })
  .strict();

const publicationSupersessionSchema = z
  .object({
    intentId: nonEmpty,
    publicationOperationId: nonEmpty,
    preparationOperationId: nonEmpty,
    workstream: failureWorkstreamSchema,
    candidateId: nonEmpty,
    preparationId: nonEmpty,
    targetRef: nonEmpty,
    expectedTargetSha: nonEmpty,
    actualTargetSha: nonEmpty,
    supersededAt: nonEmpty,
  })
  .strict();

const publicationAbandonmentSchema = z
  .object({
    intentId: nonEmpty,
    publicationOperationId: nonEmpty,
    preparationOperationId: nonEmpty,
    workstream: failureWorkstreamSchema,
    candidateId: nonEmpty,
    preparationId: nonEmpty,
    targetRef: nonEmpty,
    targetBaseSha: nonEmpty,
    evidence: nonEmpty,
    abandonedAt: nonEmpty,
  })
  .strict();

const publicationReceiptSchema = z
  .object({
    operationId: nonEmpty,
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

const failureSchema = z
  .object({
    category: z.enum([
      "stopped",
      "interrupted",
      "semantic_blocked",
      "no_progress",
      "workspace_unsafe",
      "protocol_failure",
      "provider_failure",
      "target_moved",
      "publication_uncertain",
      "persistence_runtime_failure",
      "safety",
      "runtime",
    ]),
    reason: nonEmpty,
    originPhase: z.enum(["planning", "running", "whole_plan_review"]),
    at: nonEmpty,
  })
  .strict();

const wholePlanReviewSchema = z
  .object({
    status: z.enum(["pending", "reviewing", "repairing", "approved"]),
    reviewedTargetSha: nonEmpty.optional(),
    reviewedTargetTreeSha: nonEmpty.optional(),
    evidence: nonEmpty.optional(),
    reviewRetry: z
      .object({
        attempts: z.number().int().nonnegative(),
        evidence: z.array(nonEmpty).min(1),
        status: z.enum(["open", "exhausted", "completed"]),
      })
      .strict()
      .optional(),
    epoch: z
      .object({
        initialTargetSha: nonEmpty,
        initialTargetTreeSha: nonEmpty,
        findingIds: z.array(nonEmpty).min(1),
        pendingCorrectionIds: z.array(nonEmpty),
        latestRepair: z
          .object({
            candidateId: nonEmpty,
            targetBaseSha: nonEmpty,
            publishedCommitSha: nonEmpty,
            publishedTreeSha: nonEmpty,
            changedPaths: z.array(nonEmpty),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
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

export const RunStateSchema = z
  .object({
    version: z.literal(8),
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
      "failed",
      "incomplete",
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
    operationSettlements: z.record(nonEmpty, operationSettlementSchema),
    candidates: z.record(nonEmpty, candidateSchema),
    findings: z.record(nonEmpty, findingSchema),
    reviews: z.record(nonEmpty, reviewStateSchema),
    failures: z.record(nonEmpty, failureRecordSchema),
    revisionAssignments: z.record(nonEmpty, revisionAssignmentSchema),
    operationalRetries: z.record(nonEmpty, operationalRetrySchema),
    workspaceRecreations: z.record(nonEmpty, workspaceRecreationSchema),
    reconciliationAssignments: z.record(
      nonEmpty,
      reconciliationAssignmentSchema,
    ),
    satisfaction: z
      .object({
        receipts: z.record(nonEmpty, satisfactionReceiptSchema),
        assessments: z.record(nonEmpty, satisfactionAssessmentSchema),
      })
      .strict(),
    publication: z
      .object({
        preparations: z.record(nonEmpty, publicationPreparationSchema),
        intents: z.record(nonEmpty, publicationIntentSchema),
        receipts: z.record(nonEmpty, publicationReceiptSchema),
        supersessions: z.record(nonEmpty, publicationSupersessionSchema),
        abandonments: z.record(nonEmpty, publicationAbandonmentSchema),
      })
      .strict(),
    protectedArtifactHashes: z.record(nonEmpty, hash),
    projectionDebt: z.array(projectionDebtSchema),
    failure: failureSchema.optional(),
    wholePlanReview: wholePlanReviewSchema,
    createdAt: nonEmpty,
    updatedAt: nonEmpty,
  })
  .strict();

export type RunState = z.infer<typeof RunStateSchema>;
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
export type StoreHooks = AtomicJsonWriteHooks;

export class StateError extends Error {
  constructor(
    message: string,
    readonly path: string,
    readonly issues: string[] = [],
  ) {
    super(message);
  }
}

export class StaleRevisionError extends StateError {
  constructor(path: string, expected: number, actual: number) {
    super(
      `Run state at ${path} changed from revision ${expected} to ${actual}.`,
      path,
    );
  }
}

const updates = new Map<string, Promise<void>>();

export function checkoutPaths(checkoutRoot: string): CheckoutPaths {
  const root = join(resolve(checkoutRoot), ".pi", "pipkin", "implement");
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
  await ensureGitInfoExclude(checkout.root, "/.pi/pipkin/implement/");
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
    throw new StateError(
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
        throw new StateError(
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
  checkout: RunState["run"]["checkout"];
  source: RunState["run"]["source"];
  workerConcurrency: number;
  now?: string;
  hooks?: StoreHooks;
}): RunStore {
  assertLeaseRun(args.lease, args.runId);
  if (
    resolve(args.checkout.root) !== args.lease.owner.checkoutRoot ||
    resolve(args.checkout.gitDir) !== args.lease.owner.gitDir
  ) {
    throw new StateError(
      "Planning state checkout identity does not match its lease-owned checkout.",
      args.lease.paths.root,
    );
  }
  const now = args.now ?? new Date().toISOString();
  const path = runStatePath(args.lease.paths, args.runId);
  const state: RunState = {
    version: 8,
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
    operationSettlements: {},
    candidates: {},
    findings: {},
    reviews: {},
    failures: {},
    revisionAssignments: {},
    operationalRetries: {},
    workspaceRecreations: {},
    reconciliationAssignments: {},
    satisfaction: { receipts: {}, assessments: {} },
    publication: {
      preparations: {},
      intents: {},
      receipts: {},
      supersessions: {},
      abandonments: {},
    },
    protectedArtifactHashes: args.source.protectedArtifactHashes,
    projectionDebt: [],
    wholePlanReview: { status: "pending" },
    createdAt: now,
    updatedAt: now,
  };
  return RunStore.create(args.lease, path, state, args.hooks);
}

export class RunStore {
  private constructor(
    readonly lease: CheckoutLeaseCapability,
    readonly path: string,
    private snapshot: RunState,
    private readonly hooks: StoreHooks,
  ) {}

  static create(
    lease: CheckoutLeaseCapability,
    path: string,
    initial: RunState,
    hooks: StoreHooks = {},
  ): RunStore {
    assertLeaseRun(lease, initial.run.id);
    assertRunStatePath(lease, path, initial.run.id);
    ensureRunDirectory(lease, initial.run.id);
    if (existsSync(path)) {
      throw new StateError("Canonical run state already exists.", path);
    }
    const state = validateRunState(initial, path);
    writeAtomicJson(path, state, hooks);
    return new RunStore(lease, path, state, hooks);
  }

  static open(
    lease: CheckoutLeaseCapability,
    path: string,
    hooks: StoreHooks = {},
  ): RunStore {
    lease.assertOwned();
    const state = loadRunState(path);
    assertLeaseRun(lease, state.run.id);
    assertRunStatePath(lease, path, state.run.id);
    return new RunStore(lease, path, state, hooks);
  }

  read(): RunState {
    return structuredClone(this.snapshot);
  }

  refresh(): RunState {
    this.snapshot = loadRunState(this.path);
    return this.read();
  }

  async update(
    expectedRevision: number,
    update: (current: RunState) => RunState,
  ): Promise<RunState> {
    this.lease.assertOwned();
    const queued = updates.get(this.path) ?? Promise.resolve();
    const operation = queued
      .catch(() => undefined)
      .then(() => {
        this.lease.assertOwned();
        const current = loadRunState(this.path);
        if (current.revision !== expectedRevision) {
          this.snapshot = current;
          throw new StaleRevisionError(
            this.path,
            expectedRevision,
            current.revision,
          );
        }
        const next = validateRunState(
          {
            ...update(structuredClone(current)),
            version: 8,
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
          throw new StateError(
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

  async bindExecutionPlan(plan: ExecutionPlan): Promise<RunState> {
    this.lease.assertOwned();
    const current = this.read();
    if (current.phase !== "planning" || current.executionPlan) {
      throw new StateError(
        "Only an unbound planning run can bind an execution plan.",
        this.path,
      );
    }
    validatePlanForRun(plan, current, this.path);
    const runDir = join(this.lease.paths.runs, current.run.id);
    const persisted = readExecutionPlan(runDir);
    if (persisted && persisted.executionPlanHash !== plan.executionPlanHash) {
      throw new StateError(
        "The retained execution plan does not match this planning run.",
        this.path,
      );
    }
    if (!persisted) {
      writeExecutionPlan(runDir, plan);
    }
    try {
      loadRequirementsContext(runDir, plan);
    } catch (error) {
      throw new StateError(
        `The retained source corpus is invalid: ${error instanceof Error ? error.message : String(error)}`,
        this.path,
      );
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
  ): Promise<RunState> {
    this.lease.assertOwned();
    const current = loadRunState(this.path);
    if (current.revision !== expectedRevision) {
      throw new StaleRevisionError(
        this.path,
        expectedRevision,
        current.revision,
      );
    }
    for (const taskId of taskIds) {
      const task = current.tasks[taskId];
      const workstream = task
        ? current.workstreams.source[task.workstreamId]
        : undefined;
      if (
        !task ||
        !["checkpointed", "reviewed_satisfied", "published"].includes(
          task.phase,
        ) ||
        workstream?.phase === "failed" ||
        workstream?.phase === "dependency_skipped"
      ) {
        throw new StateError(
          "Only checkpointed, reviewed-satisfied, or already-published tasks may be projected.",
          this.path,
        );
      }
    }
    const normalizedHashes = Object.fromEntries(
      Object.entries(protectedArtifactHashes).map(([path, hash]) => [
        canonicalPath(path),
        hash,
      ]),
    );
    const next = validateRunState(
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
        protectedArtifactHashes: normalizedHashes,
      },
      this.path,
      current,
    );
    if (
      !sameKeys(
        Object.keys(normalizedHashes),
        new Set(Object.keys(current.protectedArtifactHashes)),
      )
    ) {
      throw new StateError(
        "Projection cannot add or remove protected artifacts.",
        this.path,
      );
    }
    if (!sourceIdentityMatches(next) || !protectedArtifactsMatch(next)) {
      throw new StateError(
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

export function loadRunState(path: string): RunState {
  if (!existsSync(path)) {
    throw new StateError("Run state is missing.", path);
  }
  try {
    return validateRunState(JSON.parse(readFileSync(path, "utf-8")), path);
  } catch (error) {
    if (error instanceof StateError) {
      throw error;
    }
    throw new StateError(" run state is malformed JSON.", path, [
      String(error),
    ]);
  }
}

export function validateRunState(
  value: unknown,
  path: string,
  previous?: RunState,
): RunState {
  const parsed = RunStateSchema.safeParse(value);
  if (!parsed.success) {
    const version = versionOf(value);
    const message =
      version !== undefined && version < 8
        ? `Run state uses legacy schema version ${version}; settle and clean it with the previous runtime before deploying this version.`
        : version === undefined || version !== 8
          ? "Run state has an unsupported schema."
          : "Run state is invalid.";
    throw new StateError(
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
    throw new StateError(
      " run state violates lifecycle invariants.",
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
}): RunState["run"]["source"] {
  const planPath = canonicalPath(args.planPath);
  const allArtifacts = args.corpusFiles
    .map((artifact) => ({
      path: canonicalPath(artifact.path),
      hash: artifact.hash,
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
  const entry = allArtifacts.find((artifact) => artifact.path === planPath);
  if (!entry) {
    throw new StateError(
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
      throw new StateError(
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
): RunState["run"]["source"] {
  const artifacts = [
    { path: plan.source.planPath, hash: plan.source.planHash },
    ...plan.source.corpusFiles.filter(
      (file) =>
        canonicalPath(file.path) !== canonicalPath(plan.source.planPath),
    ),
  ].map((artifact) => ({
    path: canonicalPath(artifact.path),
    hash: artifact.hash,
  }));
  const content = readFileSync(plan.source.planPath, "utf-8");
  if (sha256(content) !== plan.source.planHash) {
    throw new StateError(
      "Source plan changed after execution planning.",
      plan.source.planPath,
    );
  }
  for (const artifact of artifacts) {
    if (sha256(readFileSync(artifact.path, "utf-8")) !== artifact.hash) {
      throw new StateError(
        "Execution-plan corpus changed after planning.",
        artifact.path,
      );
    }
  }
  return {
    entry: {
      path: canonicalPath(plan.source.planPath),
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

export function sourceIdentityMatches(state: RunState): boolean {
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
      .filter(
        (artifact) =>
          canonicalPath(artifact.path) !== canonicalPath(entry.path),
      )
      .every(
        (artifact) =>
          sha256(readFileSync(artifact.path, "utf-8")) === artifact.hash,
      );
  } catch {
    return false;
  }
}

export function protectedArtifactsMatch(state: RunState): boolean {
  return artifactHashesMatch(state.protectedArtifactHashes);
}

function validatePlanForRun(
  plan: ExecutionPlan,
  state: RunState,
  path: string,
): void {
  if (
    plan.source.checkoutId !== state.run.checkout.gitDir ||
    plan.source.baseSha !== state.run.checkout.startHead ||
    plan.workerConcurrency !== state.run.workerConcurrency
  ) {
    throw new StateError(
      "Execution plan identity does not match this planning run.",
      path,
    );
  }
  const source = sourceIdentityForExecutionPlan(plan);
  if (JSON.stringify(source) !== JSON.stringify(state.run.source)) {
    throw new StateError(
      "Execution plan source identity does not match this planning run.",
      path,
    );
  }
}

function invariantIssues(
  state: RunState,
  path: string,
  previous?: RunState,
): string[] {
  const issues: string[] = [];
  const bound = state.executionPlan !== undefined;
  if (state.phase === "planning" && bound) {
    issues.push("planning cannot bind an execution plan");
  }
  if (
    !bound &&
    !["planning", "stopping", "failed", "incomplete"].includes(state.phase)
  ) {
    issues.push("only planning-derived stop and failure states may be unbound");
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
      try {
        loadRequirementsContext(join(state.executionPlan!.path, ".."), plan);
      } catch {
        issues.push(
          "source corpus is missing, invalid, or does not match the execution plan",
        );
      }
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
    if (
      workstream.phase !== "queued" &&
      workstream.phase !== "dependency_skipped" &&
      !workstream.baseSha
    ) {
      issues.push(`source workstream ${key} has no assigned runtime base`);
    }
  }
  for (const [key, workstream] of Object.entries(state.workstreams.overall)) {
    if (key !== workstream.repairId) {
      issues.push(`overall workstream key ${key} does not match its repair ID`);
    }
  }
  const wholePlanEpoch = state.wholePlanReview.epoch;
  if (
    state.wholePlanReview.reviewRetry?.status === "open" &&
    state.phase !== "whole_plan_review"
  ) {
    issues.push(
      "whole-plan review retry may run only during whole-plan review",
    );
  }
  if (state.wholePlanReview.status === "repairing" && !wholePlanEpoch) {
    issues.push("whole-plan repair requires a retained review epoch");
  }
  if (
    state.wholePlanReview.status === "pending" &&
    wholePlanEpoch &&
    !wholePlanEpoch.latestRepair
  ) {
    issues.push(
      "a pending anchored whole-plan review requires a published repair",
    );
  }
  if (wholePlanEpoch) {
    const epochIds = new Set(wholePlanEpoch.findingIds);
    if (epochIds.size !== wholePlanEpoch.findingIds.length) {
      issues.push("whole-plan review epoch repeats a canonical finding ID");
    }
    const pendingIds = new Set(wholePlanEpoch.pendingCorrectionIds);
    if (pendingIds.size !== wholePlanEpoch.pendingCorrectionIds.length) {
      issues.push("whole-plan review epoch repeats a pending finding ID");
    }
    for (const findingId of wholePlanEpoch.findingIds) {
      const finding = state.findings[findingId];
      if (!finding) {
        issues.push("whole-plan review epoch lost a canonical finding");
      } else if (
        finding.scope.kind !== "whole_plan" ||
        finding.scope.initialTargetSha !== wholePlanEpoch.initialTargetSha ||
        finding.scope.initialTargetTreeSha !==
          wholePlanEpoch.initialTargetTreeSha
      ) {
        issues.push(
          `whole-plan review epoch has a finding outside its immutable scope: ${findingId}`,
        );
      }
    }
    for (const findingId of wholePlanEpoch.pendingCorrectionIds) {
      const finding = state.findings[findingId];
      if (
        !epochIds.has(findingId) ||
        !finding ||
        finding.status !== "open" ||
        finding.scope.kind !== "whole_plan" ||
        finding.scope.initialTargetSha !== wholePlanEpoch.initialTargetSha ||
        finding.scope.initialTargetTreeSha !==
          wholePlanEpoch.initialTargetTreeSha
      ) {
        issues.push("whole-plan review epoch has an invalid pending finding");
      }
    }
    const openEpochIds = wholePlanEpoch.findingIds.filter(
      (findingId) => state.findings[findingId]?.status === "open",
    );
    if (
      JSON.stringify(openEpochIds) !==
      JSON.stringify(wholePlanEpoch.pendingCorrectionIds)
    ) {
      issues.push(
        "whole-plan review epoch does not retain every open finding as pending",
      );
    }
    const latestCandidate = wholePlanEpoch.latestRepair
      ? state.candidates[wholePlanEpoch.latestRepair.candidateId]
      : undefined;
    if (wholePlanEpoch.latestRepair && !latestCandidate) {
      issues.push(
        "whole-plan review epoch references an unknown repair candidate",
      );
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
    (state.phase === "stopping" || state.phase === "failed") !==
    (state.failure !== undefined)
  ) {
    issues.push("only stopping and failed runs retain failure metadata");
  }
  if (
    state.phase === "completed" &&
    state.wholePlanReview.status !== "approved"
  ) {
    issues.push("a completed run requires an approved whole-plan review");
  }
  if (state.phase === "incomplete") {
    if (!bound) {
      issues.push("an incomplete run requires a bound execution plan");
    }
    if (
      Object.values(state.workstreams.source).some(
        (workstream) =>
          !["completed", "failed", "dependency_skipped"].includes(
            workstream.phase,
          ),
      ) ||
      Object.values(state.workstreams.overall).some(
        (workstream) => !["completed", "failed"].includes(workstream.phase),
      ) ||
      Object.keys(state.processLeases).length > 0 ||
      state.projectionDebt.length > 0 ||
      state.wholePlanReview.status === "reviewing" ||
      state.wholePlanReview.status === "repairing" ||
      Object.values(state.operationalRetries).some(
        (retry) => retry.status === "open",
      ) ||
      Object.values(state.workspaceRecreations).some(
        (recreation) =>
          recreation.status === "pending" || recreation.status === "running",
      ) ||
      Object.values(state.revisionAssignments).some(
        (assignment) => assignment.status === "open",
      ) ||
      Object.values(state.reconciliationAssignments).some(
        (assignment) => assignment.status === "pending",
      ) ||
      (state.wholePlanReview.status === "pending" &&
        state.wholePlanReview.reviewRetry?.status !== "exhausted" &&
        Object.values(state.workstreams.source).every(
          (workstream) => workstream.phase === "completed",
        ) &&
        Object.values(state.workstreams.overall).every(
          (workstream) => workstream.phase === "completed",
        )) ||
      Object.values(state.publication.intents).some(
        (intent) =>
          !state.publication.receipts[intent.id] &&
          !state.publication.supersessions[intent.id] &&
          !state.publication.abandonments[intent.id],
      )
    ) {
      issues.push("an incomplete run retains safe work or unsettled debt");
    }
    if (
      Object.values(state.workstreams.source).every(
        (workstream) => workstream.phase === "completed",
      ) &&
      Object.values(state.workstreams.overall).every(
        (workstream) => workstream.phase === "completed",
      ) &&
      state.wholePlanReview.status === "approved"
    ) {
      issues.push("an incomplete run cannot represent full delivery");
    }
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
          : lease.kind === "revision"
            ? "revising"
            : lease.kind === "workspace_recreation"
              ? "recreating_workspace"
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
      lease.kind === "revision" &&
      (!lease.revisionAssignmentId ||
        state.revisionAssignments[lease.revisionAssignmentId]?.status !==
          "open")
    ) {
      issues.push(`revision lease ${key} does not match an open assignment`);
    }
    if (
      lease.kind === "workspace_recreation" &&
      (!lease.workspaceRecreationId ||
        state.workspaceRecreations[lease.workspaceRecreationId]?.status !==
          "running")
    ) {
      issues.push(
        `workspace recreation lease ${key} does not match its operation`,
      );
    }
    if (
      lease.reconciliationAssignmentId !== undefined &&
      (lease.kind !== "reconciliation" ||
        state.reconciliationAssignments[lease.reconciliationAssignmentId]
          ?.status !== "pending" ||
        state.reconciliationAssignments[lease.reconciliationAssignmentId]
          ?.candidateId !== lease.candidateId)
    ) {
      issues.push(
        `reconciliation lease ${key} does not match its exact assignment`,
      );
    }
    if (lease.kind !== "revision" && lease.revisionAssignmentId !== undefined) {
      issues.push(`non-revision lease ${key} references a revision assignment`);
    }
  }
  if (
    state.phase === "planning" &&
    Object.keys(state.processLeases).length > 0
  ) {
    issues.push("an unbound planning run cannot have process leases");
  }
  for (const [key, settlement] of Object.entries(state.operationSettlements)) {
    if (key !== settlement.operationId) {
      issues.push(`operation settlement key ${key} does not match its ID`);
    }
    if (state.processLeases[key]) {
      issues.push(`operation ${key} is both active and settled`);
    }
    if (!workstreamExists(state, settlement.workstream)) {
      issues.push(
        `operation settlement ${key} references an unknown workstream`,
      );
    }
  }
  for (const lease of Object.values(state.processLeases)) {
    if (state.operationSettlements[lease.id]) {
      issues.push(`active operation ${lease.id} already has a settlement`);
    }
  }
  for (const [key, preparation] of Object.entries(
    state.publication.preparations,
  )) {
    const operation =
      state.processLeases[preparation.operationId] ??
      state.operationSettlements[preparation.operationId];
    if (key !== preparation.id || operation?.kind !== "reconciliation") {
      issues.push(`publication preparation ${key} has no reconciliation owner`);
    }
  }
  for (const [key, intent] of Object.entries(state.publication.intents)) {
    const operation =
      state.processLeases[intent.operationId] ??
      state.operationSettlements[intent.operationId];
    if (
      key !== intent.id ||
      operation?.kind !== "reconciliation" ||
      state.publication.preparations[intent.preparationId]?.operationId !==
        intent.operationId
    ) {
      issues.push(
        `publication intent ${key} has no matching preparation owner`,
      );
    }
  }
  for (const [key, receipt] of Object.entries(state.publication.receipts)) {
    const operation =
      state.processLeases[receipt.operationId] ??
      state.operationSettlements[receipt.operationId];
    if (key !== receipt.intentId || operation?.kind !== "publication") {
      issues.push(`publication receipt ${key} has no publication owner`);
    }
  }
  for (const [key, supersession] of Object.entries(
    state.publication.supersessions,
  )) {
    const intent = state.publication.intents[supersession.intentId];
    const operation =
      state.processLeases[supersession.publicationOperationId] ??
      state.operationSettlements[supersession.publicationOperationId];
    if (
      key !== supersession.intentId ||
      !intent ||
      state.publication.receipts[key] ||
      state.publication.abandonments[key] ||
      operation?.kind !== "publication" ||
      operation.publicationIntentId !== supersession.intentId ||
      intent.operationId !== supersession.preparationOperationId ||
      !sameWorkstreamIdentity(intent.workstream, supersession.workstream) ||
      intent.candidateId !== supersession.candidateId ||
      intent.preparationId !== supersession.preparationId ||
      intent.targetRef !== supersession.targetRef ||
      intent.targetBaseSha !== supersession.expectedTargetSha ||
      supersession.actualTargetSha === supersession.expectedTargetSha ||
      supersession.actualTargetSha === intent.preparedCommitSha
    ) {
      issues.push(`publication supersession ${key} has no exact pre-CAS proof`);
    }
  }
  for (const [key, abandonment] of Object.entries(
    state.publication.abandonments,
  )) {
    const intent = state.publication.intents[abandonment.intentId];
    const operation =
      state.processLeases[abandonment.publicationOperationId] ??
      state.operationSettlements[abandonment.publicationOperationId];
    if (
      key !== abandonment.intentId ||
      !intent ||
      state.publication.receipts[key] ||
      state.publication.supersessions[key] ||
      operation?.kind !== "publication" ||
      !isProvenNoWriteAbandonment(operation) ||
      operation.publicationIntentId !== abandonment.intentId ||
      intent.operationId !== abandonment.preparationOperationId ||
      !sameWorkstreamIdentity(intent.workstream, abandonment.workstream) ||
      intent.candidateId !== abandonment.candidateId ||
      intent.preparationId !== abandonment.preparationId ||
      intent.targetRef !== abandonment.targetRef ||
      intent.targetBaseSha !== abandonment.targetBaseSha
    ) {
      issues.push(`publication abandonment ${key} has no exact no-write proof`);
    }
  }
  for (const [key, candidate] of Object.entries(state.candidates)) {
    if (key !== candidate.id) {
      issues.push(`candidate key ${key} does not match its ID`);
    }
    if (!workstreamExists(state, candidate.workstream)) {
      issues.push(`candidate ${key} references an unknown workstream`);
    }
    if (
      candidate.workstream.kind === "source" &&
      state.workstreams.source[candidate.workstream.id]?.baseSha !==
        candidate.baseSha
    ) {
      issues.push(
        `candidate ${key} does not match its workstream runtime base`,
      );
    }
  }
  const findingIds = new Set<string>();
  for (const [key, finding] of Object.entries(state.findings)) {
    if (key !== finding.id || findingIds.has(finding.id)) {
      issues.push(`finding key ${key} does not match its immutable ID`);
    }
    findingIds.add(finding.id);
    const prior = previous?.findings[finding.id];
    if (
      prior &&
      (prior.candidateId !== finding.candidateId ||
        JSON.stringify(prior.workstream) !==
          JSON.stringify(finding.workstream) ||
        JSON.stringify(prior.scope) !== JSON.stringify(finding.scope) ||
        prior.origin !== finding.origin ||
        prior.introducedRound !== finding.introducedRound)
    ) {
      issues.push(`finding ${key} changed immutable introduction provenance`);
    }
    if (
      (finding.scope.kind === "source" &&
        (finding.workstream.kind !== "source" ||
          finding.workstream.id !== finding.scope.id)) ||
      (finding.scope.kind === "whole_plan" &&
        (finding.workstream.kind !== "overall" ||
          state.wholePlanReview.epoch?.initialTargetSha !==
            finding.scope.initialTargetSha ||
          state.wholePlanReview.epoch?.initialTargetTreeSha !==
            finding.scope.initialTargetTreeSha))
    ) {
      issues.push(`finding ${key} has an invalid immutable scope`);
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
    const outstanding = new Set(review.pendingCorrectionIds);
    if (outstanding.size !== review.pendingCorrectionIds.length) {
      issues.push(`review ${key} repeats an outstanding finding ID`);
    }
    const authorizedIds =
      candidate.workstream.kind === "overall"
        ? (state.wholePlanReview.epoch?.findingIds ?? [])
        : Object.values(state.findings)
            .filter(
              (finding) =>
                candidate.workstream.kind === "source" &&
                finding.workstream.kind === "source" &&
                finding.workstream.id === candidate.workstream.id,
            )
            .map((finding) => finding.id);
    for (const findingId of review.pendingCorrectionIds) {
      const finding = state.findings[findingId];
      if (
        !finding ||
        finding.status !== "open" ||
        !authorizedIds.includes(findingId)
      ) {
        issues.push(
          `review ${key} has an invalid pending finding ${findingId}`,
        );
      }
    }
    if (candidate.workstream.kind === "overall") {
      const openEpochIds = authorizedIds.filter(
        (findingId) => state.findings[findingId]?.status === "open",
      );
      if (
        JSON.stringify(review.pendingCorrectionIds) !==
        JSON.stringify(openEpochIds)
      ) {
        issues.push(
          `overall review ${key} does not retain every open epoch finding as pending`,
        );
      }
    } else {
      for (const findingId of authorizedIds) {
        const finding = state.findings[findingId]!;
        if (
          finding.status === "open" &&
          finding.disposition === "blocking" &&
          !outstanding.has(findingId) &&
          !["approved", "completed"].includes(
            workstreamPhase(state, candidate.workstream) ?? "",
          )
        ) {
          issues.push(`review ${key} lost open blocking finding ${findingId}`);
        }
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
    if (
      candidate.integrationBaseSha !== undefined &&
      review.comparisonBase !== candidate.integrationBaseSha
    ) {
      issues.push(
        `review ${key} does not retain its integration comparison base`,
      );
    }
    if (
      review.publicationCommitSubject &&
      candidate.baseSha === candidate.commitSha
    ) {
      issues.push(
        `review ${key} has a publication subject for an unchanged candidate`,
      );
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
        !candidate ||
        !review ||
        review.candidateId !== candidateId ||
        review.pendingCorrectionIds.length > 0 ||
        Object.values(state.findings).some(
          (finding) =>
            finding.status === "open" &&
            finding.disposition === "blocking" &&
            (workstream.kind === "source"
              ? finding.workstream.kind === "source" &&
                finding.workstream.id === workstream.id
              : state.wholePlanReview.epoch?.findingIds.includes(finding.id)),
        ) ||
        (candidate.baseSha !== candidate.commitSha &&
          !review.publicationCommitSubject)
      ) {
        issues.push(
          "approved or completed workstreams require a converged current review",
        );
      }
    }
  }
  for (const [key, failure] of Object.entries(state.failures)) {
    const candidate = failure.candidateId
      ? state.candidates[failure.candidateId]
      : undefined;
    if (
      key !== failure.id ||
      !workstreamExists(state, failure.workstream) ||
      (failure.candidateId &&
        (!candidate ||
          !sameWorkstreamIdentity(candidate.workstream, failure.workstream)))
    ) {
      issues.push(`failure ${key} has an invalid owner or candidate`);
    }
  }
  for (const [key, assignment] of Object.entries(state.revisionAssignments)) {
    const candidate = state.candidates[assignment.candidateId];
    const review = state.reviews[workstreamIdentity(assignment.workstream)];
    const hasInvalidFindingSnapshot = assignment.pendingCorrectionIds.some(
      (findingId) => {
        const finding = state.findings[findingId];
        return (
          !finding ||
          (assignment.workstream.kind === "source"
            ? finding.workstream.kind !== "source" ||
              finding.workstream.id !== assignment.workstream.id
            : finding.scope.kind !== "whole_plan" ||
              !state.wholePlanReview.epoch?.findingIds.includes(findingId))
        );
      },
    );
    if (
      key !== assignment.id ||
      !candidate ||
      !sameWorkstreamIdentity(candidate.workstream, assignment.workstream) ||
      assignment.comparisonBase !== candidate.commitSha ||
      new Set(assignment.pendingCorrectionIds).size !==
        assignment.pendingCorrectionIds.length ||
      hasInvalidFindingSnapshot ||
      (assignment.status === "open" &&
        (!review ||
          review.candidateId !== assignment.candidateId ||
          review.round !== assignment.findingEpoch ||
          JSON.stringify(review.pendingCorrectionIds) !==
            JSON.stringify(assignment.pendingCorrectionIds)))
    ) {
      issues.push(`revision assignment ${key} does not match its review epoch`);
    }
  }
  for (const [key, retry] of Object.entries(state.operationalRetries)) {
    if (key !== retry.id || !workstreamExists(state, retry.workstream)) {
      issues.push(`operational retry ${key} has an invalid owner`);
    }
  }
  for (const [key, recreation] of Object.entries(state.workspaceRecreations)) {
    if (
      key !== recreation.id ||
      !workstreamExists(state, recreation.workstream)
    ) {
      issues.push(`workspace recreation ${key} has an invalid owner`);
    }
  }
  for (const [key, assignment] of Object.entries(
    state.reconciliationAssignments,
  )) {
    const candidate = state.candidates[assignment.candidateId];
    const currentCandidateId = workstreamCandidateId(
      state,
      assignment.workstream,
    );
    if (
      key !== assignment.id ||
      !candidate ||
      !sameWorkstreamIdentity(candidate.workstream, assignment.workstream) ||
      assignment.candidateCommitSha !== candidate.commitSha ||
      assignment.candidateTreeSha !== candidate.treeSha ||
      !sameWorkstreamIdentity(
        assignment.context.workstream,
        assignment.workstream,
      ) ||
      assignment.context.candidateTreeSha !== assignment.candidateTreeSha ||
      assignment.context.targetSha !== assignment.targetSha ||
      assignment.context.disposition !== assignment.disposition ||
      !samePaths(
        assignment.context.relevantPaths,
        canonicalRelevantPaths(assignment.paths),
      ) ||
      assignment.context.key !== reconciliationContextKey(assignment.context) ||
      !canonicalGitPaths(assignment.context.relevantPaths) ||
      (assignment.semanticAttempt === "initial" &&
        assignment.priorAttemptEvidence.length !== 0) ||
      (assignment.semanticAttempt === "escalated" &&
        assignment.priorAttemptEvidence.length === 0) ||
      assignment.staging.id === "" ||
      assignment.staging.branchName === "" ||
      assignment.staging.targetRef !== state.run.checkout.branchRef ||
      !canonicalGitPaths(assignment.paths.candidate) ||
      !canonicalGitPaths(assignment.paths.target) ||
      !canonicalGitPaths(assignment.paths.replay) ||
      (assignment.status === "pending" &&
        currentCandidateId !== assignment.candidateId)
    ) {
      issues.push(`reconciliation assignment ${key} has an invalid candidate`);
    }
  }
  const reconciliationContexts = new Map<
    string,
    (typeof state.reconciliationAssignments)[string][]
  >();
  for (const assignment of Object.values(state.reconciliationAssignments)) {
    const retained = reconciliationContexts.get(assignment.context.key) ?? [];
    retained.push(assignment);
    reconciliationContexts.set(assignment.context.key, retained);
  }
  for (const [key, assignments] of reconciliationContexts) {
    if (
      assignments.length > 2 ||
      assignments.filter(
        (assignment) => assignment.semanticAttempt === "initial",
      ).length !== 1 ||
      assignments.filter(
        (assignment) => assignment.semanticAttempt === "escalated",
      ).length > 1 ||
      assignments.filter((assignment) => assignment.status === "pending")
        .length > 1
    ) {
      issues.push(
        `reconciliation context ${key} exceeds its convergence bound`,
      );
    }
  }
  for (const [key, receipt] of Object.entries(state.satisfaction.receipts)) {
    const candidate = state.candidates[receipt.candidateId];
    const assessment = Object.values(state.satisfaction.assessments).find(
      (entry) =>
        entry.candidateId === receipt.candidateId &&
        entry.targetSha === receipt.assessedTargetSha &&
        entry.status === "approved",
    );
    if (
      key !== receipt.id ||
      !candidate ||
      candidate.workstream.kind !== "source" ||
      candidate.workstream.id !== receipt.workstream.id ||
      !assessment
    ) {
      issues.push(`satisfaction receipt ${key} has no approved assessment`);
    }
  }
  for (const [key, assessment] of Object.entries(
    state.satisfaction.assessments,
  )) {
    const candidate = state.candidates[assessment.candidateId];
    if (
      key !== assessment.id ||
      !candidate ||
      candidate.commitSha !== candidate.baseSha ||
      candidate.baseSha !== assessment.historicalBaseSha ||
      candidate.workstream.kind !== "source" ||
      candidate.workstream.id !== assessment.workstream.id
    ) {
      issues.push(
        `satisfaction assessment ${key} does not match its candidate`,
      );
    }
  }
  for (const [key, preparation] of Object.entries(
    state.publication.preparations,
  )) {
    const candidate = state.candidates[preparation.candidateId];
    const staging = stagingIdentity({
      runId: state.run.id,
      operationId: preparation.operationId,
      candidateId: preparation.candidateId,
      candidateCommitSha: preparation.candidateCommitSha,
      candidateTreeSha: preparation.candidateTreeSha,
      targetBaseSha: preparation.targetBaseSha,
      targetRef: preparation.targetRef,
    });
    if (
      key !== preparation.id ||
      preparation.id !==
        publicationPreparationId({
          runId: state.run.id,
          preparation,
        }) ||
      !candidate ||
      candidate.commitSha !== preparation.candidateCommitSha ||
      candidate.treeSha !== preparation.candidateTreeSha ||
      preparation.targetRef !== state.run.checkout.branchRef ||
      preparation.stagingBranch !== staging.branchName ||
      preparation.stagingWorktree !==
        join(
          state.run.checkout.root,
          ".pi",
          "pipkin",
          "implement",
          "worktrees",
          state.run.id,
          staging.id,
        ) ||
      (preparation.disposition === "same_base" &&
        (candidate.integrationBaseSha !== undefined ||
          preparation.targetBaseSha !== candidate.baseSha)) ||
      (preparation.disposition === "reconciled_same_base" &&
        (candidate.integrationBaseSha === undefined ||
          preparation.targetBaseSha !== candidate.integrationBaseSha)) ||
      (preparation.disposition === "clean_non_overlap" &&
        preparation.targetBaseSha ===
          (candidate.integrationBaseSha ?? candidate.baseSha)) ||
      preparation.preparedTreeSha === "" ||
      preparation.replayPatchHash === ""
    ) {
      issues.push(
        `publication preparation ${key} does not match its reviewed candidate`,
      );
    }
  }
  for (const [key, intent] of Object.entries(state.publication.intents)) {
    const candidate = state.candidates[intent.candidateId];
    const preparation = state.publication.preparations[intent.preparationId];
    if (
      key !== intent.id ||
      !candidate ||
      !preparation ||
      intent.id !==
        publicationIntentId({
          runId: state.run.id,
          operationId: intent.operationId,
          preparation,
        }) ||
      preparation.operationId !== intent.operationId ||
      !sameWorkstreamIdentity(candidate.workstream, intent.workstream) ||
      (state.publication.supersessions[key] === undefined &&
        state.publication.abandonments[key] === undefined &&
        workstreamCandidateId(state, intent.workstream) !==
          intent.candidateId) ||
      preparation.candidateId !== intent.candidateId ||
      preparation.targetRef !== intent.targetRef ||
      preparation.targetBaseSha !== intent.targetBaseSha ||
      preparation.preparedCommitSha !== intent.preparedCommitSha ||
      preparation.preparedTreeSha !== intent.preparedTreeSha ||
      [
        state.publication.supersessions[key],
        state.publication.abandonments[key],
        state.publication.receipts[key],
      ].filter(Boolean).length > 1
    ) {
      issues.push(
        `publication intent ${key} does not match its immutable preparation`,
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
    for (const [id, workstream] of Object.entries(
      previous.workstreams.source,
    )) {
      const current = state.workstreams.source[id];
      if (
        workstream.baseSha !== undefined &&
        current?.baseSha !== workstream.baseSha
      ) {
        issues.push(`source workstream ${id} runtime base was overwritten`);
      }
      if (
        ["failed", "dependency_skipped"].includes(workstream.phase) &&
        current?.phase !== workstream.phase
      ) {
        issues.push(`terminal source workstream ${id} was reactivated`);
      }
    }
    for (const [id, workstream] of Object.entries(
      previous.workstreams.overall,
    )) {
      if (
        workstream.phase === "failed" &&
        state.workstreams.overall[id]?.phase !== "failed"
      ) {
        issues.push(`terminal overall workstream ${id} was reactivated`);
      }
    }
    for (const [id, settlement] of Object.entries(
      previous.operationSettlements,
    )) {
      if (
        JSON.stringify(state.operationSettlements[id]) !==
        JSON.stringify(settlement)
      ) {
        issues.push(`operation settlement ${id} was overwritten or removed`);
      }
    }
    for (const [id, candidate] of Object.entries(previous.candidates)) {
      if (JSON.stringify(state.candidates[id]) !== JSON.stringify(candidate)) {
        issues.push(`candidate ${id} was overwritten or removed`);
      }
    }
    for (const [id, finding] of Object.entries(previous.findings)) {
      const retained = state.findings[id];
      if (!retained) {
        issues.push(`finding ${id} was removed`);
      } else if (
        finding.status === "resolved" &&
        retained.status !== "resolved"
      ) {
        issues.push(`resolved finding ${id} was reopened`);
      }
    }
    for (const [id, receipt] of Object.entries(
      previous.satisfaction.receipts,
    )) {
      if (
        JSON.stringify(state.satisfaction.receipts[id]) !==
        JSON.stringify(receipt)
      ) {
        issues.push(`satisfaction receipt ${id} was overwritten or removed`);
      }
    }
    for (const [id, preparation] of Object.entries(
      previous.publication.preparations,
    )) {
      if (
        JSON.stringify(state.publication.preparations[id]) !==
        JSON.stringify(preparation)
      ) {
        issues.push(`publication preparation ${id} was overwritten or removed`);
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
    for (const [id, supersession] of Object.entries(
      previous.publication.supersessions,
    )) {
      if (
        JSON.stringify(state.publication.supersessions[id]) !==
        JSON.stringify(supersession)
      ) {
        issues.push(
          `publication supersession ${id} was overwritten or removed`,
        );
      }
    }
    for (const [id, abandonment] of Object.entries(
      previous.publication.abandonments,
    )) {
      if (
        JSON.stringify(state.publication.abandonments[id]) !==
        JSON.stringify(abandonment)
      ) {
        issues.push(`publication abandonment ${id} was overwritten or removed`);
      }
    }
  }
  if (previous) {
    for (const [id, failure] of Object.entries(previous.failures)) {
      if (JSON.stringify(state.failures[id]) !== JSON.stringify(failure)) {
        issues.push(`failure ${id} was overwritten or removed`);
      }
    }
    for (const [id, assignment] of Object.entries(
      previous.revisionAssignments,
    )) {
      const retained = state.revisionAssignments[id];
      if (
        !retained ||
        retained.candidateId !== assignment.candidateId ||
        retained.comparisonBase !== assignment.comparisonBase ||
        retained.findingEpoch !== assignment.findingEpoch ||
        JSON.stringify(retained.pendingCorrectionIds) !==
          JSON.stringify(assignment.pendingCorrectionIds)
      ) {
        issues.push(
          `revision assignment ${id} rewrites its immutable identity`,
        );
      }
    }
    for (const [id, assignment] of Object.entries(
      previous.reconciliationAssignments,
    )) {
      const retained = state.reconciliationAssignments[id];
      if (!retained) {
        issues.push(`reconciliation assignment ${id} was removed`);
        continue;
      }
      const {
        status: _previousStatus,
        executionFailures: _previousFailures,
        attemptEvidence: _previousAttemptEvidence,
        ...identity
      } = assignment;
      const {
        status: _retainedStatus,
        executionFailures: _retainedFailures,
        attemptEvidence: _retainedAttemptEvidence,
        ...retainedIdentity
      } = retained;
      if (JSON.stringify(identity) !== JSON.stringify(retainedIdentity)) {
        issues.push(
          `reconciliation assignment ${id} rewrites its immutable failed replay context`,
        );
      }
    }
  }
  return issues;
}

function workstreamExists(
  state: RunState,
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

function reconciliationContextKey(
  context: z.infer<typeof reconciliationContextSchema>,
): string {
  return `reconciliation-context-${sha256(
    JSON.stringify({
      workstream: workstreamIdentity(context.workstream),
      candidateTreeSha: context.candidateTreeSha,
      targetSha: context.targetSha,
      disposition: context.disposition,
      relevantPaths: context.relevantPaths,
    }),
  )}`;
}

function canonicalRelevantPaths(
  paths: z.infer<typeof reconciliationAssignmentSchema>["paths"],
): string[] {
  return [
    ...new Set([...paths.candidate, ...paths.target, ...paths.replay]),
  ].sort();
}

function isProvenNoWriteAbandonment(
  operation:
    | RunState["processLeases"][string]
    | RunState["operationSettlements"][string]
    | undefined,
): boolean {
  if (
    !operation ||
    !("eventFingerprint" in operation) ||
    operation.kind !== "publication" ||
    operation.outcome !== "effect_failed"
  ) {
    return false;
  }
  try {
    const event = JSON.parse(operation.eventFingerprint) as {
      kind?: unknown;
      effect?: unknown;
      provenNoWrite?: unknown;
    };
    return (
      event.kind === "effect_failed" &&
      event.effect === "publication" &&
      event.provenNoWrite === true
    );
  } catch {
    return false;
  }
}

function samePaths(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    left.every((path, index) => path === right[index])
  );
}

function canonicalGitPaths(paths: readonly string[]): boolean {
  return (
    new Set(paths).size === paths.length &&
    paths.every(
      (path, index) =>
        path === path.trim() &&
        path !== "" &&
        !path.startsWith("/") &&
        !path.split("/").includes("..") &&
        (index === 0 || paths[index - 1]! < path),
    )
  );
}

function workstreamPhase(
  state: RunState,
  workstream: z.infer<typeof candidateSchema>["workstream"],
): string | undefined {
  return workstream.kind === "source"
    ? state.workstreams.source[workstream.id]?.phase
    : state.workstreams.overall[workstream.repairId]?.phase;
}

function workstreamCandidateId(
  state: RunState,
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
    throw new StateError(
      "Implement requires a Git worktree containing the invocation directory.",
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
    throw new StateError(message, path);
  }
}

function assertPathComponentsAreNotSymlinks(root: string, path: string): void {
  const relativePath = relative(root, path);
  if (
    relativePath === "" ||
    relativePath === ".." ||
    relativePath.startsWith("../")
  ) {
    throw new StateError(
      "Checkout state path escapes the target checkout.",
      path,
    );
  }
  let current = root;
  for (const component of relativePath.split("/")) {
    current = join(current, component);
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) {
      throw new StateError(
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
    throw new StateError(
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
    throw new StateError(
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
    throw new StateError(
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
      throw new StateError(
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

export function makeRunId(): string {
  return `r${Date.now().toString(36)}-${randomBytes(8).toString("hex")}`;
}
