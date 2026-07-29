import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ExecutionPlan } from "./execution-plan.js";
import { changedPathsBetween, type GitClient } from "./git.js";
import {
  buildAnchoredOverallReviewPrompt,
  buildAnchoredWorkstreamReviewPrompt,
  buildInitialWorkstreamReviewPrompt,
} from "./prompts.js";
import {
  resolveCorpusPath as resolveImmutableCorpusPath,
  sha256,
} from "./source-integrity.js";
import {
  type AnchoredWorkstreamReviewCompletion,
  type DirectReviewFinding,
  type InitialWorkstreamReviewCompletion,
} from "./result-schemas.js";
import type { ImplementRoles, SubagentClient } from "./subagents.js";
import {
  spawnValidatedWorker,
  WorkerPacketError,
} from "./worker-invocation.js";
import { overallRepairWorkspace } from "./overall-repair.js";
import { workstreamWorkspace } from "./workstream-candidate.js";
import { writeAtomicJson } from "./atomic-json.js";
import type { RuntimeWorkstream } from "./scheduler.js";
import { protectedArtifactsMatch, type RunState } from "./store.js";

export type ReviewState = {
  candidateId: string;
  previousCandidateId?: string;
  round: number;
  outstandingIds: string[];
  latestCorrection?: {
    fromCandidateId: string;
    changedPaths: string[];
    evidence: string;
  };
  evidence: string[];
  observations: Array<{ summary: string; evidence: string }>;
};

export type ReviewFinding = DirectReviewFinding & {
  id: string;
  candidateId: string;
  workstream: RuntimeWorkstream;
  origin: "initial" | "regression";
  introducedRound: number;
  status: "open" | "resolved";
};

export type ReviewPacket = {
  workstream: RuntimeWorkstream;
  candidate: RunState["candidates"][string];
  previousCandidate?: RunState["candidates"][string];
  contracts: ExecutionPlan["tasks"];
  sourceMaterial: Array<{ path: string; content: string }>;
  checkpoints: Record<string, string>;
  satisfiedEvidence: Record<string, string>;
  verificationEvidence?: RunState["candidates"][string]["implementationEvidence"];
  uncertainty?: string;
  outstandingFindings: ReviewFinding[];
  latestCorrection?: ReviewState["latestCorrection"];
};

export type InitialSourceReviewPacket = ReviewPacket & {
  role: "reviewer";
  completionKind: "initial-review";
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
  completionKind: "anchored-review";
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
  completionKind: "anchored-review";
  identity: string;
  workspace: { path: string; mutationBoundary: string };
  planContext: string;
  candidateContext: string;
  previousCandidate: RunState["candidates"][string];
  candidate: RunState["candidates"][string];
  outstandingFindings: ReviewFinding[];
};

export type ReviewOutcome =
  | {
      kind: "repository_state";
      candidateId: string;
      assessedTargetSha: string;
      completion: InitialWorkstreamReviewCompletion;
      evidence: string;
    }
  | {
      kind: "initial";
      candidateId: string;
      completion: InitialWorkstreamReviewCompletion;
      evidence: string;
    }
  | {
      kind: "anchored";
      candidateId: string;
      completion: AnchoredWorkstreamReviewCompletion;
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
  return Object.values(state.findings).filter((finding) => {
    if (finding.workstream.kind === "source" && workstream.kind === "source") {
      return finding.workstream.id === workstream.id;
    }
    if (
      finding.workstream.kind === "overall" &&
      workstream.kind === "overall"
    ) {
      return finding.workstream.repairId === workstream.repairId;
    }
    return false;
  });
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
  const contracts = taskIds.map((taskId) => {
    const task = args.plan.tasks.find((item) => item.id === taskId);
    if (!task) {
      throw new Error(`The execution plan is missing task ${taskId}.`);
    }
    return task;
  });
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
    sourceMaterial: [
      ...new Set(
        contracts.flatMap((task) =>
          task.sourcePaths.map((sourcePath) =>
            resolveCorpusPath(args.state, args.plan, sourcePath),
          ),
        ),
      ),
    ].map((path) => ({ path, content: readFileSync(path, "utf-8") })),
    checkpoints,
    satisfiedEvidence,
    ...(candidate.implementationEvidence
      ? { verificationEvidence: candidate.implementationEvidence }
      : {}),
    ...(candidate.implementationEvidence?.uncertainty
      ? { uncertainty: candidate.implementationEvidence.uncertainty }
      : {}),
    outstandingFindings: workstreamReviewFindings(args.state, args.workstream)
      .filter((finding) => review?.outstandingIds.includes(finding.id))
      .sort(
        (left, right) =>
          review!.outstandingIds.indexOf(left.id) -
          review!.outstandingIds.indexOf(right.id),
      ),
    ...(review?.latestCorrection
      ? { latestCorrection: review.latestCorrection }
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
      completionKind: "initial-review",
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
    return { ...common, completionKind: "initial-review", mode: "initial" };
  }
  const outstandingIds = args.packet.outstandingFindings.map(
    (finding) => finding.id,
  );
  if (
    args.review.candidateId !== args.packet.candidate.id ||
    !args.review.previousCandidateId ||
    !args.packet.previousCandidate ||
    args.packet.previousCandidate.id !== args.review.previousCandidateId ||
    !sameWorkstream(
      args.packet.previousCandidate.workstream,
      args.workstream,
    ) ||
    !args.review.latestCorrection ||
    args.review.latestCorrection.fromCandidateId !==
      args.packet.previousCandidate.id ||
    !sameIds(outstandingIds, args.review.outstandingIds) ||
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
    completionKind: "anchored-review",
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
    throw new Error(
      "The review workspace does not match its current candidate.",
    );
  }
  if (assessment && (await args.git.head()) !== assessment.targetSha) {
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
  const result = await args.subagents.waitFor<unknown>(handle, args.signal);
  if (result.status !== "completed") {
    throw new Error(`Workstream reviewer ${result.status}: ${result.error}`);
  }
  if (
    (await workspaceGit.head()) !== candidate.commitSha ||
    !(await workspaceGit.isClean()) ||
    (assessment && (await args.git.head()) !== assessment.targetSha)
  ) {
    throw new Error("The reviewer changed the assessed repository state.");
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
        completion: result.result as InitialWorkstreamReviewCompletion,
        evidence,
      }
    : review
      ? {
          kind: "anchored",
          candidateId: candidate.id,
          completion: result.result as AnchoredWorkstreamReviewCompletion,
          evidence,
        }
      : {
          kind: "initial",
          candidateId: candidate.id,
          completion: result.result as InitialWorkstreamReviewCompletion,
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
    throw new Error(
      "The overall repair workspace does not match its current candidate.",
    );
  }
  const available = new Map(
    workstreamReviewFindings(args.state, args.workstream).map((finding) => [
      finding.id,
      finding,
    ]),
  );
  const findings = review.outstandingIds.map((id) => {
    const finding = available.get(id);
    if (!finding || finding.status !== "open") {
      throw new WorkerPacketError(
        "Overall repair review has a missing current anchored finding.",
      );
    }
    return finding;
  });
  if (new Set(review.outstandingIds).size !== findings.length) {
    throw new WorkerPacketError(
      "Overall repair review has duplicate anchored finding references.",
    );
  }
  const packet: OverallAnchoredReviewPacket = {
    role: "reviewer",
    completionKind: "anchored-review",
    identity: `${args.state.run.id}/${args.workstream.repairId}/${candidate.id}`,
    workspace: {
      path: workspace.worktreePath,
      mutationBoundary:
        "Read-only candidate worktree; do not mutate Git or protected corpus.",
    },
    planContext: JSON.stringify(args.plan, null, 2),
    candidateContext: `Run base: ${args.state.run.checkout.startHead}\nCandidate: ${candidate.commitSha}`,
    previousCandidate,
    candidate,
    outstandingFindings: findings,
  };
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
        baseSha: workerPacket.candidate.baseSha,
        outstandingFindings: workerPacket.outstandingFindings as never,
        previousCandidate: workerPacket.previousCandidate.commitSha,
        currentCandidate: workerPacket.candidate.commitSha,
        worktreePath: workerPacket.workspace.path,
      }),
  });
  const result = await args.subagents.waitFor<unknown>(handle, args.signal);
  if (result.status !== "completed") {
    throw new Error(
      `Overall repair reviewer ${result.status}: ${result.error}`,
    );
  }
  if (
    (await workspaceGit.head()) !== candidate.commitSha ||
    !(await workspaceGit.isClean())
  ) {
    throw new Error("The reviewer changed the overall repair workspace.");
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
    completion: result.result as AnchoredWorkstreamReviewCompletion,
    evidence,
  };
}

export function applyInitialWorkstreamReview(args: {
  workstream: RuntimeWorkstream;
  candidateId: string;
  completion: InitialWorkstreamReviewCompletion;
  evidence: string;
}): { review: ReviewState; findings: ReviewFinding[] } {
  const findings =
    args.completion.verdict === "changes_requested"
      ? args.completion.findings.map((finding, index) => ({
          ...finding,
          id: `${reviewKey(args.workstream).replace(":", "-")}-r${index + 1}`,
          candidateId: args.candidateId,
          workstream: args.workstream,
          origin: "initial" as const,
          introducedRound: 0,
          status: "open" as const,
        }))
      : [];
  return {
    review: {
      candidateId: args.candidateId,
      round: 0,
      outstandingIds: findings.map((finding) => finding.id),
      evidence: [args.evidence],
      observations: [],
    },
    findings,
  };
}

export function applyAnchoredWorkstreamReview(args: {
  state: ReviewState;
  workstream: RuntimeWorkstream;
  completion: AnchoredWorkstreamReviewCompletion;
  findings: ReviewFinding[];
  evidence: string;
}): { review: ReviewState; findings: ReviewFinding[] } {
  assertAssessmentCoverage(
    args.state.outstandingIds,
    args.completion.assessments,
  );
  const assessments = new Map(
    args.completion.assessments.map((assessment) => [
      assessment.id,
      assessment,
    ]),
  );
  const nextRound = args.state.round + 1;
  const resolved = new Set(
    args.completion.assessments
      .filter((assessment) => assessment.status === "resolved")
      .map((assessment) => assessment.id),
  );
  const updated = args.findings.map((finding) => {
    const assessment = assessments.get(finding.id);
    return assessment
      ? {
          ...finding,
          evidence: assessment.evidence,
          status:
            assessment.status === "resolved"
              ? ("resolved" as const)
              : finding.status,
        }
      : finding;
  });
  const latestPaths = new Set(args.state.latestCorrection?.changedPaths ?? []);
  const qualifying = args.completion.regressions.filter((finding) =>
    finding.changedPaths.some((path) => latestPaths.has(path)),
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
    origin: "regression" as const,
    introducedRound: nextRound,
    status: "open" as const,
  }));
  const outstandingIds = [
    ...args.state.outstandingIds.filter((id) => !resolved.has(id)),
    ...regressions.map((finding) => finding.id),
  ];
  return {
    review: {
      ...args.state,
      round: nextRound,
      outstandingIds,
      evidence: [...args.state.evidence, args.evidence],
      observations: [...args.state.observations, ...observations],
    },
    findings: [...updated, ...regressions],
  };
}

export function retargetAnchoredReview(args: {
  state: ReviewState;
  candidateId: string;
  correction: {
    fromCandidateId: string;
    changedPaths: string[];
    evidence: string;
  };
}): ReviewState {
  if (args.state.candidateId !== args.correction.fromCandidateId) {
    throw new Error("A correction must begin at the reviewed candidate.");
  }
  if (args.candidateId === args.state.candidateId) {
    throw new Error("Tracked rework must create a new candidate identity.");
  }
  return {
    ...args.state,
    candidateId: args.candidateId,
    previousCandidateId: args.state.candidateId,
    latestCorrection: args.correction,
  };
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

function resolveCorpusPath(
  state: RunState,
  plan: ExecutionPlan,
  path: string,
): string {
  return resolveImmutableCorpusPath({
    planPath: plan.source.planPath,
    checkoutRoot: state.run.checkout.root,
    corpus: plan.source.corpusFiles,
    reference: path,
  });
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
  outstandingIds: string[],
  assessments: AnchoredWorkstreamReviewCompletion["assessments"],
): void {
  const expected = new Set(outstandingIds);
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
