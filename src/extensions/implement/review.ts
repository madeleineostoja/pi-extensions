import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { ExecutionPlan } from "./execution-plan.js";
import { changedPathsBetween, type GitClient } from "./git.js";
import {
  buildAnchoredOverallReviewPrompt,
  buildAnchoredWorkstreamReviewPrompt,
  buildInitialWorkstreamReviewPrompt,
} from "./prompts.js";
import { sha256 } from "./source-integrity.js";
import {
  loadRequirementsContext,
  scopedRequirements,
  type WorkerRequirementTask,
  type WorkerSchedule,
} from "./requirements-context.js";
import {
  type AnchoredWorkstreamReviewCompletion,
  type DirectReviewFinding,
  type InitialAnchoredWorkstreamReviewCompletion,
  type InitialWorkstreamReviewCompletion,
  type RepositoryStateReviewCompletion,
} from "./result-schemas.js";
import type { ImplementRoles, SubagentClient } from "./subagents.js";
import {
  spawnValidatedWorker,
  WorkerPacketError,
} from "./worker-invocation.js";
import { overallRepairWorkspace } from "./overall-repair.js";
import { sourceResidualContext } from "./whole-plan-review.js";
import { workstreamWorkspace } from "./workstream-candidate.js";
import { writeAtomicJson } from "./atomic-json.js";
import {
  observeCandidateWorkspace,
  type CandidateWorkspaceObservation,
} from "./candidate-admission.js";
import type { RuntimeWorkstream } from "./scheduler/scheduler.js";
import { protectedArtifactsMatch, type RunState } from "./store.js";

export class ReviewWorkspaceSafetyError extends Error {
  constructor(
    message: string,
    readonly observation?: CandidateWorkspaceObservation,
  ) {
    super(message);
  }
}

export type ReviewState = {
  candidateId: string;
  comparisonBase: string;
  previousCandidateId?: string;
  round: number;
  pendingCorrectionIds: string[];
  latestCorrection?: {
    fromCandidateId: string;
    changedPaths: string[];
    evidence: string;
    mode: "changed" | "unchanged";
    summary?: string;
    verification?: string[];
    uncertainty?: string;
    artifactPath?: string;
  };
  repositoryAssessment?: { targetSha: string };
  correctionConsumed: boolean;
  evidence: string[];
  observations: Array<{ summary: string; evidence: string }>;
  publicationCommitSubject?: string;
};

export type ReviewFinding = DirectReviewFinding & {
  id: string;
  candidateId: string;
  workstream: RuntimeWorkstream;
  scope:
    | { kind: "source"; id: string }
    | {
        kind: "whole_plan";
        initialTargetSha: string;
        initialTargetTreeSha: string;
      };
  origin: "initial" | "regression";
  introducedRound: number;
  status: "open" | "resolved";
};

export type ReviewPacket = {
  workstream: RuntimeWorkstream;
  candidate: RunState["candidates"][string];
  previousCandidate?: RunState["candidates"][string];
  contracts: WorkerRequirementTask[];
  sourceMaterial: Array<{ path: string; content: string }>;
  corpus: Array<{ path: string; content: string }>;
  schedule: WorkerSchedule;
  checkpoints: Record<string, string>;
  satisfiedEvidence: Record<string, string>;
  verificationEvidence?: RunState["candidates"][string]["implementationEvidence"];
  uncertainty?: string;
  outstandingFindings: ReviewFinding[];
  latestCorrection?: ReviewState["latestCorrection"];
  comparisonBase?: string;
  findingEpoch?: number;
  priorReviewEvidence?: string[];
  publicationCommitSubject?: string;
  currentEvidence?: {
    status: "reported" | "unavailable";
    summary?: string;
    artifactPath?: string;
  };
};

export type InitialSourceReviewPacket = ReviewPacket & {
  role: "reviewer";
  completionKind: "initial-review" | "repository-state-review";
  identity: string;
  workspace: { path: string; mutationBoundary: string };
  mode: "initial" | "repository_state";
  repositoryState?: {
    historicalBaseSha: string;
    assessedTargetSha: string;
    priorReviewEvidence: string[];
  };
};

export type AnchoredSourceReviewPacket = ReviewPacket & {
  role: "reviewer";
  completionKind: "initial-anchored-review" | "anchored-review";
  identity: string;
  workspace: { path: string; mutationBoundary: string };
  mode: "anchored";
  previousCandidate: RunState["candidates"][string];
  latestCorrection: NonNullable<ReviewState["latestCorrection"]>;
};

export type SourceReviewWorkerPacket =
  | InitialSourceReviewPacket
  | AnchoredSourceReviewPacket;

export type OverallAnchoredReviewPacket = {
  role: "reviewer";
  completionKind: "initial-anchored-review" | "anchored-review";
  identity: string;
  workspace: { path: string; mutationBoundary: string };
  planContext: string;
  candidateContext: string;
  previousCandidate: RunState["candidates"][string];
  candidate: RunState["candidates"][string];
  comparisonBase: string;
  findingEpoch: number;
  priorReviewEvidence: string[];
  publicationCommitSubject?: string;
  completeFindings: ReviewFinding[];
  outstandingFindings: ReviewFinding[];
};

export type ReviewOutcome =
  | {
      kind: "initial";
      candidateId: string;
      completion:
        | InitialWorkstreamReviewCompletion
        | RepositoryStateReviewCompletion;
      evidence: string;
    }
  | {
      kind: "repository_state";
      candidateId: string;
      assessedTargetSha: string;
      completion: RepositoryStateReviewCompletion;
      evidence: string;
    }
  | {
      kind: "anchored";
      candidateId: string;
      previousCandidateId: string;
      comparisonBase: string;
      changedPaths: string[];
      findingEpoch: number;
      assessedTargetSha?: string;
      completion:
        | AnchoredWorkstreamReviewCompletion
        | InitialAnchoredWorkstreamReviewCompletion;
      evidence: string;
    };

export function reviewKey(workstream: RuntimeWorkstream): string {
  return workstream.kind === "source"
    ? `source:${workstream.id}`
    : `overall:${workstream.repairId}`;
}

export function workstreamReviewState(
  state: RunState,
  workstream: RuntimeWorkstream,
): ReviewState | undefined {
  return state.reviews[reviewKey(workstream)];
}

export function workstreamReviewFindings(
  state: RunState,
  workstream: RuntimeWorkstream,
): ReviewFinding[] {
  if (workstream.kind === "overall") {
    const ids = state.wholePlanReview.epoch?.findingIds ?? [];
    return ids.flatMap((id) => {
      const finding = state.findings[id];
      return finding ? [finding] : [];
    });
  }
  return Object.values(state.findings).filter(
    (finding) =>
      finding.workstream.kind === "source" &&
      finding.workstream.id === workstream.id,
  );
}

export function buildReviewPacket(args: {
  state: RunState;
  plan: ExecutionPlan;
  workstream: RuntimeWorkstream;
}): ReviewPacket {
  const identity = `${args.state.run.id}/${reviewKey(args.workstream)}`;
  if (args.state.executionPlan?.hash !== args.plan.executionPlanHash) {
    throw new Error(
      `Reviewer packet ${identity} does not match the immutable execution plan.`,
    );
  }
  if (!protectedArtifactsMatch(args.state)) {
    throw new Error(
      `Reviewer packet ${identity} material no longer matches the immutable corpus.`,
    );
  }
  const candidateId =
    args.workstream.kind === "source"
      ? args.state.workstreams.source[args.workstream.id]?.candidateId
      : args.state.workstreams.overall[args.workstream.repairId]?.candidateId;
  const candidate = candidateId
    ? args.state.candidates[candidateId]
    : undefined;
  if (!candidate || !sameWorkstream(candidate.workstream, args.workstream)) {
    throw new Error(
      `Reviewer packet ${identity} requires the workstream's current candidate.`,
    );
  }
  const review = workstreamReviewState(args.state, args.workstream);
  const taskIds =
    args.workstream.kind === "source"
      ? args.state.workstreams.source[args.workstream.id]!.taskIds
      : [];
  const context = loadRequirementsContext(
    dirname(args.state.executionPlan!.path),
    args.plan,
  );
  const { contracts, sourceMaterial } = scopedRequirements(context, taskIds);
  const checkpoints: Record<string, string> = {};
  const satisfiedEvidence: Record<string, string> = {};
  for (const taskId of taskIds) {
    const task = args.state.tasks[taskId];
    if (task?.phase === "checkpointed") {
      checkpoints[taskId] = task.checkpoint;
    }
    if (
      (task?.phase === "satisfaction_claimed" ||
        task?.phase === "reviewed_satisfied" ||
        task?.phase === "published") &&
      task.evidence
    ) {
      satisfiedEvidence[taskId] = task.evidence;
    }
  }
  return {
    workstream: args.workstream,
    candidate,
    ...(review?.previousCandidateId
      ? { previousCandidate: args.state.candidates[review.previousCandidateId] }
      : {}),
    contracts,
    sourceMaterial,
    corpus: context.corpus,
    schedule: context.schedule,
    checkpoints,
    satisfiedEvidence,
    ...(candidate.implementationEvidence
      ? { verificationEvidence: candidate.implementationEvidence }
      : {}),
    currentEvidence: {
      status: candidate.evidenceStatus ?? "reported",
      ...(candidate.implementationEvidence?.summary
        ? { summary: candidate.implementationEvidence.summary }
        : {}),
    },
    ...(candidate.implementationEvidence?.uncertainty
      ? { uncertainty: candidate.implementationEvidence.uncertainty }
      : {}),
    outstandingFindings: workstreamReviewFindings(args.state, args.workstream)
      .filter((finding) => review?.pendingCorrectionIds.includes(finding.id))
      .sort(
        (left, right) =>
          review!.pendingCorrectionIds.indexOf(left.id) -
          review!.pendingCorrectionIds.indexOf(right.id),
      ),
    ...(review?.latestCorrection
      ? { latestCorrection: review.latestCorrection }
      : {}),
    ...(review
      ? {
          comparisonBase: review.comparisonBase,
          findingEpoch: review.round,
          priorReviewEvidence: [...review.evidence],
          ...(review.publicationCommitSubject
            ? { publicationCommitSubject: review.publicationCommitSubject }
            : {}),
        }
      : {}),
  };
}

export function buildSourceReviewWorkerPacket(args: {
  state: RunState;
  workstream: Extract<RuntimeWorkstream, { kind: "source" }>;
  workspacePath: string;
  packet: ReviewPacket;
  review?: ReviewState;
  assessment?: RunState["satisfaction"]["assessments"][string];
  actualChangedPaths?: string[];
}): SourceReviewWorkerPacket {
  const expectedWorkspace = workstreamWorkspace(args.state, args.workstream.id);
  if (resolve(args.workspacePath) !== resolve(expectedWorkspace.worktreePath)) {
    throw new Error(
      `Reviewer packet ${args.workstream.id} has an invalid assigned workspace.`,
    );
  }
  if (
    !sameWorkstream(args.packet.workstream, args.workstream) ||
    !sameWorkstream(args.packet.candidate.workstream, args.workstream)
  ) {
    throw new Error(
      `Reviewer packet ${args.workstream.id} does not match its source workstream.`,
    );
  }
  const common = {
    ...args.packet,
    role: "reviewer" as const,
    identity: `${args.state.run.id}/${args.workstream.id}/${args.packet.candidate.id}`,
    workspace: {
      path: expectedWorkspace.worktreePath,
      mutationBoundary:
        "Review is read-only; the target checkout and run artifacts are not readable worker inputs.",
    },
  };
  if (args.assessment) {
    if (
      args.assessment.candidateId !== args.packet.candidate.id ||
      args.assessment.workstream.id !== args.workstream.id
    ) {
      throw new Error(
        `Reviewer packet ${args.workstream.id} has an inconsistent repository-state assessment.`,
      );
    }
    return {
      ...common,
      completionKind: "repository-state-review",
      mode: "repository_state",
      repositoryState: {
        historicalBaseSha: args.assessment.historicalBaseSha,
        assessedTargetSha: args.assessment.targetSha,
        priorReviewEvidence: args.review?.evidence ?? [],
      },
    };
  }
  if (!args.review) {
    if (args.packet.outstandingFindings.length > 0) {
      throw new Error(
        `Reviewer packet ${args.workstream.id} has findings without a review epoch.`,
      );
    }
    return {
      ...common,
      completionKind:
        args.packet.candidate.commitSha === args.packet.candidate.baseSha
          ? "repository-state-review"
          : "initial-review",
      mode: "initial",
    };
  }
  const pendingCorrectionIds = args.packet.outstandingFindings.map(
    (finding) => finding.id,
  );
  if (
    args.review.candidateId !== args.packet.candidate.id ||
    !args.review.previousCandidateId ||
    !args.packet.comparisonBase ||
    args.packet.comparisonBase !== args.review.comparisonBase ||
    !args.packet.previousCandidate ||
    args.packet.previousCandidate.id !== args.review.previousCandidateId ||
    !sameWorkstream(
      args.packet.previousCandidate.workstream,
      args.workstream,
    ) ||
    !args.review.latestCorrection ||
    args.review.latestCorrection.fromCandidateId !==
      args.packet.previousCandidate.id ||
    !sameIds(pendingCorrectionIds, args.review.pendingCorrectionIds) ||
    !sameIds(
      args.actualChangedPaths ?? [],
      args.review.latestCorrection.changedPaths,
    ) ||
    args.packet.outstandingFindings.some((finding) => {
      const retained = args.state.findings[finding.id];
      return (
        !retained ||
        retained.status !== "open" ||
        !sameWorkstream(retained.workstream, args.workstream)
      );
    })
  ) {
    throw new Error(
      `Reviewer packet ${args.workstream.id} does not match its anchored review epoch.`,
    );
  }
  return {
    ...common,
    completionKind:
      args.review.latestCorrection.mode === "unchanged" ||
      args.review.publicationCommitSubject
        ? "anchored-review"
        : "initial-anchored-review",
    mode: "anchored",
    previousCandidate: args.packet.previousCandidate,
    latestCorrection: args.review.latestCorrection,
  };
}

export async function runWorkstreamReview(args: {
  state: RunState;
  plan: ExecutionPlan;
  workstream: RuntimeWorkstream;
  git: GitClient;
  subagents: SubagentClient;
  signal?: AbortSignal;
  artifactsPath: string;
  roles: ImplementRoles;
}): Promise<ReviewOutcome> {
  if (args.workstream.kind !== "source") {
    return runOverallAnchoredReview({
      ...args,
      workstream: args.workstream,
    });
  }
  let runtime: RunState["workstreams"]["source"][string];
  let candidate: RunState["candidates"][string];
  try {
    const retained = args.state.workstreams.source[args.workstream.id];
    const candidateId = retained?.candidateId;
    const current = candidateId
      ? args.state.candidates[candidateId]
      : undefined;
    if (!retained || !current) {
      throw new Error("A workstream review requires a current candidate.");
    }
    runtime = retained;
    candidate = current;
  } catch (error) {
    throw new WorkerPacketError(
      `Reviewer packet ${args.state.run.id}/${args.workstream.id} could not be materialized: ${message(error)}`,
    );
  }
  const candidateId = candidate.id;
  const assessment = Object.values(args.state.satisfaction.assessments).find(
    (entry) =>
      entry.status === "pending" &&
      entry.candidateId === candidateId &&
      entry.workstream.kind === "source" &&
      entry.workstream.id === runtime.id,
  );
  const review = workstreamReviewState(args.state, args.workstream);
  const assessedTargetSha =
    assessment?.targetSha ?? review?.repositoryAssessment?.targetSha;
  const previousCandidate = review?.previousCandidateId
    ? args.state.candidates[review.previousCandidateId]
    : undefined;
  let packet: ReviewPacket;
  try {
    packet = buildReviewPacket({
      state: args.state,
      plan: args.plan,
      workstream: args.workstream,
    });
  } catch (error) {
    throw new WorkerPacketError(
      `Reviewer packet ${args.state.run.id}/${args.workstream.id} could not be materialized: ${message(error)}`,
    );
  }
  const workspace = workstreamWorkspace(args.state, args.workstream.id);
  const worktreePath = workspace.worktreePath;
  const workspaceGit = args.git.forWorktree(worktreePath);
  if (
    (await workspaceGit.head()) !== candidate.commitSha ||
    !(await workspaceGit.isClean())
  ) {
    throw new ReviewWorkspaceSafetyError(
      "The review workspace does not match its current candidate.",
      await observeCandidateWorkspace(workspaceGit),
    );
  }
  if (assessedTargetSha && (await args.git.head()) !== assessedTargetSha) {
    throw new Error(
      "Repository-state assessment target changed before review.",
    );
  }
  const actualChangedPaths =
    review && previousCandidate
      ? await changedPathsBetween(
          workspaceGit,
          previousCandidate.commitSha,
          candidate.commitSha,
        )
      : undefined;
  let workerPacket: SourceReviewWorkerPacket;
  try {
    workerPacket = buildSourceReviewWorkerPacket({
      state: args.state,
      workstream: args.workstream,
      workspacePath: worktreePath,
      packet,
      review,
      assessment,
      actualChangedPaths,
    });
  } catch (error) {
    throw new WorkerPacketError(
      `Reviewer packet ${args.state.run.id}/${args.workstream.id} could not be materialized: ${message(error)}`,
    );
  }
  const handle =
    workerPacket.mode === "anchored"
      ? await spawnValidatedWorker({
          packet: workerPacket,
          subagents: args.subagents,
          roles: args.roles,
          taskId: args.workstream.id,
          description: `Review workstream ${args.workstream.id}`,
          render: buildAnchoredWorkstreamReviewPrompt,
        })
      : await spawnValidatedWorker({
          packet: workerPacket,
          subagents: args.subagents,
          roles: args.roles,
          taskId: args.workstream.id,
          description: `Review workstream ${args.workstream.id}`,
          render: buildInitialWorkstreamReviewPrompt,
        });
  let result:
    | Awaited<ReturnType<typeof args.subagents.waitFor<unknown>>>
    | undefined;
  let failure: unknown;
  try {
    result = await args.subagents.waitFor<unknown>(handle, args.signal);
  } catch (error) {
    failure = error;
  }
  if (
    (await workspaceGit.currentBranch()) !== workspace.branchName ||
    (await workspaceGit.head()) !== candidate.commitSha ||
    (await workspaceGit.tree()) !== candidate.treeSha ||
    !(await workspaceGit.isClean()) ||
    (await workspaceGit.activeOperation()) ||
    (assessedTargetSha && (await args.git.head()) !== assessedTargetSha)
  ) {
    throw new ReviewWorkspaceSafetyError(
      "The reviewer changed the assessed repository state.",
      await observeCandidateWorkspace(workspaceGit),
    );
  }
  if (failure) {
    throw failure;
  }
  if (!result || result.status !== "completed") {
    throw new Error(
      `Workstream reviewer ${result?.status}: ${result?.error ?? "no completion"}`,
    );
  }
  const evidence = reviewEvidencePath(args.artifactsPath, args.workstream.id, {
    packet,
    completion: result.result,
  });
  return assessment
    ? {
        kind: "repository_state",
        candidateId: candidate.id,
        assessedTargetSha: assessment.targetSha,
        completion: result.result as RepositoryStateReviewCompletion,
        evidence,
      }
    : review
      ? {
          kind: "anchored",
          candidateId: candidate.id,
          previousCandidateId: previousCandidate!.id,
          comparisonBase: review!.comparisonBase,
          changedPaths: [...actualChangedPaths!],
          findingEpoch: review!.round,
          ...(review?.repositoryAssessment
            ? { assessedTargetSha: review.repositoryAssessment.targetSha }
            : {}),
          completion: result.result as AnchoredWorkstreamReviewCompletion,
          evidence,
        }
      : {
          kind: "initial",
          candidateId: candidate.id,
          completion: result.result as
            | InitialWorkstreamReviewCompletion
            | RepositoryStateReviewCompletion,
          evidence,
        };
}

async function runOverallAnchoredReview(args: {
  state: RunState;
  plan: ExecutionPlan;
  workstream: Extract<RuntimeWorkstream, { kind: "overall" }>;
  git: GitClient;
  subagents: SubagentClient;
  signal?: AbortSignal;
  artifactsPath: string;
  roles: ImplementRoles;
}): Promise<ReviewOutcome> {
  const runtime = args.state.workstreams.overall[args.workstream.repairId];
  const candidateId = runtime?.candidateId;
  const candidate = candidateId
    ? args.state.candidates[candidateId]
    : undefined;
  const review = workstreamReviewState(args.state, args.workstream);
  const previousCandidate = review?.previousCandidateId
    ? args.state.candidates[review.previousCandidateId]
    : undefined;
  if (!runtime || !candidate || !review || !previousCandidate) {
    throw new Error(
      "Overall repair review requires an anchored candidate epoch.",
    );
  }
  if (!protectedArtifactsMatch(args.state)) {
    throw new Error("Overall repair review requires intact protected corpus.");
  }
  const workspace = overallRepairWorkspace(
    args.state,
    args.workstream.repairId,
    candidate.baseSha,
  );
  const workspaceGit = args.git.forWorktree(workspace.worktreePath);
  if (
    (await workspaceGit.head()) !== candidate.commitSha ||
    !(await workspaceGit.isClean())
  ) {
    throw new ReviewWorkspaceSafetyError(
      "The overall repair workspace does not match its current candidate.",
      await observeCandidateWorkspace(workspaceGit),
    );
  }
  const completeFindings = workstreamReviewFindings(
    args.state,
    args.workstream,
  );
  const available = new Map(
    completeFindings.map((finding) => [finding.id, finding]),
  );
  const findings = review.pendingCorrectionIds.map((id) => {
    const finding = available.get(id);
    if (!finding || finding.status !== "open") {
      throw new WorkerPacketError(
        "Overall repair review has a missing current anchored finding.",
      );
    }
    return finding;
  });
  if (new Set(review.pendingCorrectionIds).size !== findings.length) {
    throw new WorkerPacketError(
      "Overall repair review has duplicate anchored finding references.",
    );
  }
  const packet: OverallAnchoredReviewPacket = {
    role: "reviewer",
    completionKind:
      review.latestCorrection?.mode === "unchanged" ||
      review.publicationCommitSubject
        ? "anchored-review"
        : "initial-anchored-review",
    identity: `${args.state.run.id}/${args.workstream.repairId}/${candidate.id}`,
    workspace: {
      path: workspace.worktreePath,
      mutationBoundary:
        "Read-only candidate worktree; do not mutate Git or protected corpus.",
    },
    planContext: JSON.stringify(
      loadRequirementsContext(
        dirname(args.state.executionPlan!.path),
        args.plan,
      ),
      null,
      2,
    ),
    candidateContext: `Run base: ${args.state.run.checkout.startHead}\nHistorical workstream base: ${candidate.baseSha}\nComparison base: ${review.comparisonBase}\nPrevious candidate: ${previousCandidate.commitSha}\nCandidate: ${candidate.commitSha}\nCorrection mode: ${review.latestCorrection?.mode ?? "unknown"}\nCanonical comparison paths: ${review.latestCorrection?.changedPaths.join(", ") || "none"}\nCorrection evidence: ${review.latestCorrection?.evidence ?? "none"}\nCorrection summary: ${review.latestCorrection?.summary ?? "none"}\nCorrection verification: ${JSON.stringify(review.latestCorrection?.verification ?? [])}\nCorrection uncertainty: ${review.latestCorrection?.uncertainty ?? "none"}\nCorrection artifact: ${review.latestCorrection?.artifactPath ?? "none"}\nFinding epoch: ${review.round}\nPrior review evidence: ${JSON.stringify(review.evidence)}\nCurrent verification: ${JSON.stringify(candidate.implementationEvidence?.verification ?? [])}\nCurrent evidence status: ${candidate.evidenceStatus ?? "unavailable"}\nCurrent uncertainty: ${candidate.implementationEvidence?.uncertainty ?? "none"}\nCumulative publication subject: ${review.publicationCommitSubject ?? "not yet authored"}
Open source review context: ${JSON.stringify(sourceResidualContext(args.state, args.plan), null, 2)}`,
    previousCandidate,
    candidate,
    comparisonBase: review.comparisonBase,
    findingEpoch: review.round,
    priorReviewEvidence: [...review.evidence],
    ...(review.publicationCommitSubject
      ? { publicationCommitSubject: review.publicationCommitSubject }
      : {}),
    completeFindings,
    outstandingFindings: findings,
  };
  const actualChangedPaths = await changedPathsBetween(
    workspaceGit,
    review.comparisonBase,
    candidate.commitSha,
  );
  if (
    !sameIds(actualChangedPaths, review.latestCorrection?.changedPaths ?? [])
  ) {
    throw new WorkerPacketError(
      "Overall repair review does not match its canonical comparison range.",
    );
  }
  const handle = await spawnValidatedWorker({
    packet,
    subagents: args.subagents,
    roles: args.roles,
    taskId: args.workstream.repairId,
    description: `Assess overall repair ${args.workstream.repairId}`,
    render: (workerPacket) =>
      buildAnchoredOverallReviewPrompt({
        planContext: workerPacket.planContext,
        candidateContext: workerPacket.candidateContext,
        baseSha: workerPacket.comparisonBase,
        outstandingFindings: workerPacket.outstandingFindings as never,
        completeFindings: workerPacket.completeFindings as never,
        previousCandidate: workerPacket.previousCandidate.commitSha,
        currentCandidate: workerPacket.candidate.commitSha,
        worktreePath: workerPacket.workspace.path,
        authorPublicationCommitSubject:
          workerPacket.completionKind === "initial-anchored-review",
      }),
  });
  let result:
    | Awaited<ReturnType<typeof args.subagents.waitFor<unknown>>>
    | undefined;
  let failure: unknown;
  try {
    result = await args.subagents.waitFor<unknown>(handle, args.signal);
  } catch (error) {
    failure = error;
  }
  if (
    (await workspaceGit.currentBranch()) !== workspace.branchName ||
    (await workspaceGit.head()) !== candidate.commitSha ||
    (await workspaceGit.tree()) !== candidate.treeSha ||
    !(await workspaceGit.isClean()) ||
    (await workspaceGit.activeOperation())
  ) {
    throw new ReviewWorkspaceSafetyError(
      "The reviewer changed the overall repair workspace.",
      await observeCandidateWorkspace(workspaceGit),
    );
  }
  if (failure) {
    throw failure;
  }
  if (!result || result.status !== "completed") {
    throw new Error(
      `Overall repair reviewer ${result?.status}: ${result?.error ?? "no completion"}`,
    );
  }
  const evidence = reviewEvidencePath(
    args.artifactsPath,
    args.workstream.repairId,
    {
      previousCandidate,
      candidate,
      completion: result.result,
    },
  );
  return {
    kind: "anchored",
    candidateId: candidate.id,
    previousCandidateId: previousCandidate.id,
    comparisonBase: review.comparisonBase,
    changedPaths: actualChangedPaths,
    findingEpoch: review.round,
    completion: result.result as
      | AnchoredWorkstreamReviewCompletion
      | InitialAnchoredWorkstreamReviewCompletion,
    evidence,
  };
}

export function applyInitialWorkstreamReview(args: {
  workstream: RuntimeWorkstream;
  candidateId: string;
  comparisonBase: string;
  completion:
    | InitialWorkstreamReviewCompletion
    | RepositoryStateReviewCompletion;
  evidence: string;
  scope?: ReviewFinding["scope"];
}): { review: ReviewState; findings: ReviewFinding[] } {
  const scope =
    args.scope ??
    (args.workstream.kind === "source"
      ? { kind: "source" as const, id: args.workstream.id }
      : undefined);
  if (!scope) {
    throw new Error("Whole-plan findings require an observed target tree.");
  }
  const findings = args.completion.findings.map((finding, index) => ({
    scope,
    ...finding,
    id: `${reviewKey(args.workstream).replace(":", "-")}-r${index + 1}`,
    candidateId: args.candidateId,
    workstream: args.workstream,
    origin: "initial" as const,
    introducedRound: 0,
    status: "open" as const,
  }));
  return {
    review: {
      candidateId: args.candidateId,
      comparisonBase: args.comparisonBase,
      round: 0,
      pendingCorrectionIds: findings.map((finding) => finding.id),
      correctionConsumed: findings.length > 0,
      evidence: [args.evidence],
      observations: [],
      ...("publicationCommitSubject" in args.completion
        ? { publicationCommitSubject: args.completion.publicationCommitSubject }
        : {}),
    },
    findings,
  };
}

export function applyAnchoredWorkstreamReview(args: {
  state: ReviewState;
  workstream: RuntimeWorkstream;
  completion:
    | AnchoredWorkstreamReviewCompletion
    | InitialAnchoredWorkstreamReviewCompletion;
  findings: ReviewFinding[];
  evidence: string;
  correctionPaths: string[];
}): { review: ReviewState; findings: ReviewFinding[] } {
  assertAssessmentCoverage(
    args.state.pendingCorrectionIds,
    args.completion.assessments,
  );
  if (
    new Set(args.findings.map((finding) => finding.id)).size !==
      args.findings.length ||
    args.state.pendingCorrectionIds.some((id) => {
      const finding = args.findings.find((candidate) => candidate.id === id);
      return (
        !finding ||
        finding.status !== "open" ||
        (args.workstream.kind === "source"
          ? finding.workstream.kind !== "source" ||
            finding.workstream.id !== args.workstream.id ||
            finding.scope.kind !== "source" ||
            finding.scope.id !== args.workstream.id
          : finding.workstream.kind !== "overall" ||
            finding.workstream.repairId !== args.workstream.repairId ||
            finding.scope.kind !== "whole_plan")
      );
    })
  ) {
    throw new Error("Anchored review does not own its pending findings.");
  }
  const assessments = new Map(
    args.completion.assessments.map((assessment) => [
      assessment.id,
      assessment,
    ]),
  );
  const nextRound = args.state.round + 1;
  const updated = args.findings.map((finding) => {
    const assessment = assessments.get(finding.id);
    if (!assessment) {
      return finding;
    }
    if (finding.status !== "open") {
      throw new Error("Anchored review cannot reopen a resolved finding.");
    }
    return assessment.status === "resolved"
      ? {
          ...finding,
          status: "resolved" as const,
          evidence: assessment.evidence,
        }
      : {
          ...finding,
          summary: assessment.summary,
          evidence: assessment.evidence,
          requiredChange: assessment.requiredChange,
          acceptanceCriteria: assessment.acceptanceCriteria,
        };
  });
  const correctionPaths = new Set(args.correctionPaths);
  const qualifying = args.completion.regressions.filter((finding) =>
    finding.changedPaths.some((path) => correctionPaths.has(path)),
  );
  const observations = [
    ...(args.completion.observations ?? []),
    ...args.completion.regressions
      .filter((finding) => !qualifying.includes(finding))
      .map((finding) => ({
        summary: finding.summary,
        evidence: finding.evidence,
      })),
  ];
  const nextNumber = updated.length + 1;
  const regressions = qualifying.map((finding, index) => ({
    summary: finding.summary,
    evidence: finding.evidence,
    requiredChange: finding.requiredChange,
    acceptanceCriteria: finding.acceptanceCriteria,
    id: `${reviewKey(args.workstream).replace(":", "-")}-r${nextNumber + index}`,
    candidateId: args.state.candidateId,
    workstream: args.workstream,
    scope: regressionScope(args.workstream, args.findings),
    origin: "regression" as const,
    introducedRound: nextRound,
    status: "open" as const,
  }));
  if (
    args.state.latestCorrection?.mode === "unchanged" &&
    args.completion.regressions.length > 0
  ) {
    throw new Error("An unchanged correction cannot introduce regressions.");
  }
  const pendingCorrectionIds: string[] = [];
  if (
    args.state.latestCorrection?.mode === "changed" &&
    !args.state.publicationCommitSubject &&
    !("publicationCommitSubject" in args.completion)
  ) {
    throw new Error(
      "The first anchored changed-candidate review must author a publication subject.",
    );
  }
  if (
    "publicationCommitSubject" in args.completion &&
    args.state.publicationCommitSubject
  ) {
    throw new Error(
      "An anchored review cannot replace its publication subject.",
    );
  }
  return {
    review: {
      ...args.state,
      ...("publicationCommitSubject" in args.completion
        ? { publicationCommitSubject: args.completion.publicationCommitSubject }
        : {}),
      round: nextRound,
      pendingCorrectionIds,
      evidence: [...args.state.evidence, args.evidence],
      observations: [...args.state.observations, ...observations],
    },
    findings: [...updated, ...regressions],
  };
}

export function retargetAnchoredReview(args: {
  state: ReviewState;
  candidateId: string;
  comparisonBase: string;
  correction: {
    fromCandidateId: string;
    changedPaths: string[];
    evidence: string;
    summary?: string;
    verification?: string[];
    uncertainty?: string;
    artifactPath?: string;
  };
}): ReviewState {
  if (args.state.candidateId !== args.correction.fromCandidateId) {
    throw new Error("A correction must begin at the reviewed candidate.");
  }
  const mode =
    args.correction.changedPaths.length === 0 ? "unchanged" : "changed";
  return {
    ...args.state,
    candidateId: args.candidateId,
    comparisonBase: args.comparisonBase,
    previousCandidateId: args.state.candidateId,
    latestCorrection: { ...args.correction, mode },
  };
}

function regressionScope(
  workstream: RuntimeWorkstream,
  findings: ReviewFinding[],
): ReviewFinding["scope"] {
  const scope = findings[0]?.scope;
  if (scope) {
    return scope;
  }
  if (workstream.kind === "source") {
    return { kind: "source", id: workstream.id };
  }
  throw new Error("Whole-plan regressions require an observed target tree.");
}

function reviewEvidencePath(
  artifactsPath: string,
  workstreamId: string,
  evidence: unknown,
): string {
  mkdirSync(artifactsPath, { recursive: true });
  const fingerprint = sha256(JSON.stringify(evidence));
  const path = join(
    artifactsPath,
    `${workstreamId}-review-${fingerprint}.json`,
  );
  writeAtomicJson(path, evidence);
  return path;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sameWorkstream(
  left: RuntimeWorkstream,
  right: RuntimeWorkstream,
): boolean {
  return (
    left.kind === right.kind &&
    (left.kind === "source" && right.kind === "source"
      ? left.id === right.id
      : left.kind === "overall" && right.kind === "overall"
        ? left.repairId === right.repairId
        : false)
  );
}

function sameIds(left: string[], right: string[]): boolean {
  return (
    left.length === right.length &&
    left.every((id, index) => id === right[index])
  );
}

function assertAssessmentCoverage(
  pendingCorrectionIds: string[],
  assessments: AnchoredWorkstreamReviewCompletion["assessments"],
): void {
  const expected = new Set(pendingCorrectionIds);
  const seen = new Set<string>();
  for (const assessment of assessments) {
    if (!expected.has(assessment.id) || seen.has(assessment.id)) {
      throw new Error(
        "Anchored review must assess each outstanding finding exactly once.",
      );
    }
    seen.add(assessment.id);
  }
  if (seen.size !== expected.size) {
    throw new Error(
      "Anchored review must assess each outstanding finding exactly once.",
    );
  }
}
