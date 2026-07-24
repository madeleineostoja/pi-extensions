import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { ExecutionPlan } from "./execution-plan-vnext.js";
import type { GitClient } from "./git.js";
import {
  buildAnchoredWorkstreamReviewPrompt,
  buildInitialWorkstreamReviewPrompt,
} from "./prompts.js";
import {
  anchoredWorkstreamReviewSchema,
  initialWorkstreamReviewSchema,
  type AnchoredWorkstreamReviewCompletion,
  type DirectReviewFinding,
  type InitialWorkstreamReviewCompletion,
} from "./result-schemas.js";
import type { SubagentClient } from "./subagents.js";
import { workstreamWorkspace } from "./workstream-candidate.js";
import { writeAtomicJson } from "./atomic-json.js";
import type { RuntimeWorkstream } from "./scheduler-vnext.js";
import { protectedArtifactsMatch, type VNextRunState } from "./vnext-store.js";

export type VNextReviewState = {
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

export type VNextReviewFinding = DirectReviewFinding & {
  id: string;
  candidateId: string;
  workstream: RuntimeWorkstream;
  origin: "initial" | "regression";
  introducedRound: number;
  status: "open" | "resolved";
};

export type VNextReviewPacket = {
  workstream: RuntimeWorkstream;
  candidate: VNextRunState["candidates"][string];
  previousCandidate?: VNextRunState["candidates"][string];
  contracts: ExecutionPlan["tasks"];
  sourceMaterial: Array<{ path: string; content: string }>;
  checkpoints: Record<string, string>;
  satisfiedEvidence: Record<string, string>;
  verificationEvidence?: VNextRunState["candidates"][string]["implementationEvidence"];
  uncertainty?: string;
  outstandingFindings: VNextReviewFinding[];
  latestCorrection?: VNextReviewState["latestCorrection"];
  baseToTipDiff: string;
};

export type VNextReviewOutcome =
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
  state: VNextRunState,
  workstream: RuntimeWorkstream,
): VNextReviewState | undefined {
  return state.reviews[reviewKey(workstream)];
}

export function workstreamReviewFindings(
  state: VNextRunState,
  workstream: RuntimeWorkstream,
): VNextReviewFinding[] {
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

export function buildVNextReviewPacket(args: {
  state: VNextRunState;
  plan: ExecutionPlan;
  workstream: RuntimeWorkstream;
  baseToTipDiff: string;
}): VNextReviewPacket {
  if (!protectedArtifactsMatch(args.state)) {
    throw new Error("Review material no longer matches the immutable corpus.");
  }
  const candidateId =
    args.workstream.kind === "source"
      ? args.state.workstreams.source[args.workstream.id]?.candidateId
      : args.state.workstreams.overall[args.workstream.repairId]?.candidateId;
  const candidate = candidateId
    ? args.state.candidates[candidateId]
    : undefined;
  if (!candidate) {
    throw new Error(
      "A review packet requires the workstream's current candidate.",
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
      task?.phase === "satisfaction_claimed" ||
      task?.phase === "reviewed_satisfied"
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
    sourceMaterial: contracts.flatMap((task) =>
      task.provenance.map((reference) => {
        const path = resolveCorpusPath(args.state, args.plan, reference.path);
        return { path, content: readFileSync(path, "utf-8") };
      }),
    ),
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
    baseToTipDiff: args.baseToTipDiff,
  };
}

export async function runVNextWorkstreamReview(args: {
  state: VNextRunState;
  plan: ExecutionPlan;
  workstream: RuntimeWorkstream;
  git: GitClient;
  subagents: SubagentClient;
  signal?: AbortSignal;
  artifactsPath: string;
}): Promise<VNextReviewOutcome> {
  if (args.workstream.kind !== "source") {
    throw new Error(
      "Workstream review packets currently require source workstreams.",
    );
  }
  const runtime = args.state.workstreams.source[args.workstream.id];
  const candidateId = runtime?.candidateId;
  const candidate = candidateId
    ? args.state.candidates[candidateId]
    : undefined;
  if (!runtime || !candidate) {
    throw new Error("A workstream review requires a current candidate.");
  }
  const review = workstreamReviewState(args.state, args.workstream);
  const previousCandidate = review?.previousCandidateId
    ? args.state.candidates[review.previousCandidateId]
    : undefined;
  const packet = buildVNextReviewPacket({
    state: args.state,
    plan: args.plan,
    workstream: args.workstream,
    baseToTipDiff: await args.git.diffRange(
      previousCandidate?.commitSha ?? candidate.baseSha,
      candidate.commitSha,
    ),
  });
  const workspace = workstreamWorkspace(args.state, args.workstream.id);
  const worktreePath =
    candidate.reconciliation?.worktreePath ?? workspace.worktreePath;
  const workspaceGit = args.git.forWorktree(worktreePath);
  if (
    (await workspaceGit.head()) !== candidate.commitSha ||
    !(await workspaceGit.isClean())
  ) {
    throw new Error(
      "The review workspace does not match its current candidate.",
    );
  }
  const prompt = review
    ? buildAnchoredWorkstreamReviewPrompt({
        worktreePath,
        candidate,
        previousCandidate: packet.previousCandidate!,
        latestDelta: packet.baseToTipDiff,
        changedPaths: review.latestCorrection?.changedPaths ?? [],
        correctionEvidence:
          review.latestCorrection?.evidence ??
          "No correction evidence was retained.",
        verification: packet.verificationEvidence?.verification,
        uncertainty: packet.uncertainty,
        outstandingFindings: packet.outstandingFindings,
      })
    : buildInitialWorkstreamReviewPrompt({
        worktreePath,
        candidate,
        diff: packet.baseToTipDiff,
        contracts: packet.contracts.map((task) => ({
          id: task.id,
          title: task.title,
          ...task.compiledContract,
          provenance: task.provenance,
        })),
        sourceMaterial: packet.sourceMaterial,
        checkpoints: packet.checkpoints,
        satisfiedEvidence: packet.satisfiedEvidence,
        verification: packet.verificationEvidence?.verification,
        uncertainty: packet.uncertainty,
      });
  const handle = await args.subagents.spawn({
    type: "pi-implement:reviewer",
    role: "reviewer",
    taskId: args.workstream.id,
    description: `Review workstream ${args.workstream.id}`,
    cwd: workspace.worktreePath,
    prompt,
    readOnly: true,
    completion: (review
      ? {
          description: "Assess every outstanding finding.",
          schema: anchoredWorkstreamReviewSchema,
        }
      : {
          description: "Approve or return direct blocking findings.",
          schema: initialWorkstreamReviewSchema,
        }) as never,
  });
  const result = await args.subagents.waitFor<unknown>(handle, args.signal);
  if (result.status !== "completed") {
    throw new Error(`Workstream reviewer ${result.status}: ${result.error}`);
  }
  if (
    (await workspaceGit.head()) !== candidate.commitSha ||
    !(await workspaceGit.isClean())
  ) {
    throw new Error("The reviewer changed the candidate workspace.");
  }
  if (review && previousCandidate) {
    const changedPaths = await changedPathsBetween(
      workspaceGit,
      previousCandidate.commitSha,
      candidate.commitSha,
    );
    if (!samePaths(changedPaths, review.latestCorrection?.changedPaths ?? [])) {
      throw new Error(
        "The persisted correction paths do not match the candidate delta.",
      );
    }
  }
  const evidence = reviewEvidencePath(args.artifactsPath, args.workstream.id, {
    packet,
    completion: result.result,
  });
  return review
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

export function applyInitialWorkstreamReview(args: {
  workstream: RuntimeWorkstream;
  candidateId: string;
  completion: InitialWorkstreamReviewCompletion;
  evidence: string;
}): { review: VNextReviewState; findings: VNextReviewFinding[] } {
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
  state: VNextReviewState;
  workstream: RuntimeWorkstream;
  completion: AnchoredWorkstreamReviewCompletion;
  findings: VNextReviewFinding[];
  evidence: string;
}): { review: VNextReviewState; findings: VNextReviewFinding[] } {
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
  state: VNextReviewState;
  candidateId: string;
  correction: {
    fromCandidateId: string;
    changedPaths: string[];
    evidence: string;
  };
}): VNextReviewState {
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
  const fingerprint = createHash("sha256")
    .update(JSON.stringify(evidence))
    .digest("hex");
  const path = join(
    artifactsPath,
    `${workstreamId}-review-${fingerprint}.json`,
  );
  writeAtomicJson(path, evidence);
  return path;
}

function resolveCorpusPath(
  state: VNextRunState,
  plan: ExecutionPlan,
  path: string,
): string {
  const candidates = isAbsolute(path)
    ? [resolve(path)]
    : [
        resolve(dirname(plan.source.planPath), path),
        resolve(state.run.checkout.root, path),
      ];
  const corpus = new Set(plan.source.corpusFiles.map((file) => file.path));
  const resolved = candidates.find((candidate) => corpus.has(candidate));
  if (!resolved) {
    throw new Error(`Review material is outside the immutable corpus: ${path}`);
  }
  return resolved;
}

async function changedPathsBetween(
  git: GitClient,
  base: string,
  tip: string,
): Promise<string[]> {
  if (git.changedPathsBetween) {
    return git.changedPathsBetween(base, tip);
  }
  return (await git.diffRange(base, tip)).split("\n").flatMap((line) => {
    const match = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
    return match ? [match[2]!] : [];
  });
}

function samePaths(left: string[], right: string[]): boolean {
  return (
    [...new Set(left)].sort().join("\0") ===
    [...new Set(right)].sort().join("\0")
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
