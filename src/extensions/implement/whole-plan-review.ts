import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ExecutionPlan } from "./execution-plan.js";
import type { GitClient } from "./git.js";
import {
  buildAnchoredOverallReviewPrompt,
  buildInitialOverallReviewPrompt,
} from "./prompts.js";
import { sha256 } from "./source-integrity.js";
import { loadRequirementsContext } from "./requirements-context.js";
import {
  type AnchoredWorkstreamReviewCompletion,
  type InitialOverallReviewCompletion,
} from "./result-schemas.js";
import type { SchedulerEvent } from "./scheduler/scheduler.js";
import type { ImplementRoles, SubagentClient } from "./subagents.js";
import { writeAtomicJson } from "./atomic-json.js";
import { protectedArtifactsMatch, type RunState } from "./store.js";
import { spawnValidatedWorker } from "./worker-invocation.js";

export type WholePlanReviewPacket = {
  role: "reviewer";
  completionKind: "initial-overall-review" | "anchored-review";
  identity: string;
  workspace: { path: string; mutationBoundary: string };
  target: { commitSha: string; treeSha: string };
  baseSha: string;
  previousSha?: string;
  planContext: string;
  candidateContext: string;
  receipts: RunState["publication"]["receipts"];
  uncertainty: string[];
  outstandingFindings: NonNullable<
    RunState["wholePlanReview"]["epoch"]
  >["findings"];
};

export function buildWholePlanReviewPacket(args: {
  state: RunState;
  plan: ExecutionPlan;
  currentTargetSha: string;
  currentTargetTreeSha: string;
  previousSha?: string;
  completionKind: WholePlanReviewPacket["completionKind"];
  outstandingFindings: WholePlanReviewPacket["outstandingFindings"];
}): WholePlanReviewPacket {
  if (!protectedArtifactsMatch(args.state)) {
    throw new Error(
      "Whole-plan review material no longer matches the immutable corpus.",
    );
  }
  const requirements = loadRequirementsContext(
    join(args.state.executionPlan!.path, ".."),
    args.plan,
  );
  const completed = Object.values(args.state.workstreams.source).map(
    (workstream) => ({
      id: workstream.id,
      candidateId: workstream.candidateId,
      phase: workstream.phase,
      tasks: workstream.taskIds,
    }),
  );
  const uncertainty = Object.values(args.state.candidates)
    .flatMap((candidate) => candidate.implementationEvidence?.uncertainty ?? [])
    .filter((value, index, all) => all.indexOf(value) === index);
  return {
    role: "reviewer",
    completionKind: args.completionKind,
    identity: `${args.state.run.id}/whole-plan/${args.currentTargetSha}`,
    workspace: {
      path: args.state.run.checkout.root,
      mutationBoundary:
        "Read-only target checkout; do not mutate Git or protected corpus.",
    },
    target: {
      commitSha: args.currentTargetSha,
      treeSha: args.currentTargetTreeSha,
    },
    baseSha: args.state.run.checkout.startHead,
    ...(args.previousSha ? { previousSha: args.previousSha } : {}),
    outstandingFindings: args.outstandingFindings,
    planContext: [
      "## Complete compiled contracts",
      JSON.stringify(requirements.contracts, null, 2),
      "## Complete frozen source corpus",
      ...requirements.corpus.map(
        ({ path, content }) => `### ${path}\n${content}`,
      ),
      "## Worker-safe execution schedule",
      JSON.stringify(requirements.schedule, null, 2),
    ].join("\n\n"),
    candidateContext: [
      `Run base: ${args.state.run.checkout.startHead}`,
      `Current target: ${args.currentTargetSha}`,
      "## Source workstreams and verification evidence",
      JSON.stringify(
        completed.map((workstream) => ({
          ...workstream,
          verification: workstream.candidateId
            ? inlineImplementationEvidence(
                args.state.candidates[workstream.candidateId]
                  ?.implementationEvidence,
              )
            : undefined,
        })),
        null,
        2,
      ),
      "## Publication receipts",
      JSON.stringify(args.state.publication.receipts, null, 2),
      "## Implementer uncertainty",
      uncertainty.length > 0
        ? uncertainty.map((item) => `- ${item}`).join("\n")
        : "None retained.",
    ].join("\n\n"),
    receipts: args.state.publication.receipts,
    uncertainty,
  };
}

export async function runWholePlanReview(args: {
  state: RunState;
  plan: ExecutionPlan;
  git: GitClient;
  subagents: SubagentClient;
  artifactsPath: string;
  signal?: AbortSignal;
  dispatch: (event: SchedulerEvent) => Promise<void>;
  roles: ImplementRoles;
}): Promise<void> {
  if (
    Object.values(args.state.workstreams.source).some(
      (workstream) => workstream.phase !== "completed",
    ) ||
    Object.values(args.state.publication.intents).some(
      (intent) =>
        !args.state.publication.receipts[intent.id] &&
        !args.state.publication.supersessions[intent.id],
    )
  ) {
    throw new Error(
      "Whole-plan review requires settled source workstreams and publication intents.",
    );
  }
  const protectedPaths = Object.keys(args.state.protectedArtifactHashes);
  if (
    !(await args.git.isCleanExcept(protectedPaths)) ||
    (await args.git.hasStagedChangesInPaths(protectedPaths)) ||
    (await args.git.activeOperation()) ||
    !protectedArtifactsMatch(args.state)
  ) {
    throw new Error(
      "Whole-plan review requires a clean target outside sanctioned projections, exact protected content, and no active Git operation.",
    );
  }
  const target = await args.git.head();
  const targetTree = await args.git.treeAt(target);
  const epoch = args.state.wholePlanReview.epoch;
  const anchored = epoch?.latestRepair;
  if (
    anchored &&
    (anchored.publishedCommitSha !== target ||
      anchored.publishedTreeSha !== targetTree)
  ) {
    throw new Error(
      "Anchored whole-plan review target no longer matches its published repair.",
    );
  }
  const outstandingFindings = anchored
    ? epoch!.outstandingFindingIds.map((id) => {
        const finding = epoch!.findings.find(
          (candidate) => candidate.id === id,
        );
        if (!finding) {
          throw new Error(
            "Whole-plan review has a missing current anchored finding.",
          );
        }
        return finding;
      })
    : [];
  if (
    new Set(anchored ? epoch!.outstandingFindingIds : []).size !==
    outstandingFindings.length
  ) {
    throw new Error(
      "Whole-plan review has duplicate anchored finding references.",
    );
  }
  const packet = buildWholePlanReviewPacket({
    state: args.state,
    plan: args.plan,
    currentTargetSha: target,
    currentTargetTreeSha: targetTree,
    ...(anchored ? { previousSha: anchored.targetBaseSha } : {}),
    completionKind: anchored ? "anchored-review" : "initial-overall-review",
    outstandingFindings,
  });
  const handle = await spawnValidatedWorker({
    packet,
    subagents: args.subagents,
    roles: args.roles,
    taskId: "whole-plan",
    description: anchored
      ? `Assess published whole-plan repair for ${args.state.run.id}`
      : `Review complete run ${args.state.run.id}`,
    render: (workerPacket) =>
      anchored
        ? buildAnchoredOverallReviewPrompt({
            planContext: workerPacket.planContext,
            candidateContext: workerPacket.candidateContext,
            baseSha: workerPacket.baseSha,
            outstandingFindings: workerPacket.outstandingFindings as never,
            previousCandidate: workerPacket.previousSha!,
            currentCandidate: workerPacket.target.commitSha,
            worktreePath: workerPacket.workspace.path,
          })
        : buildInitialOverallReviewPrompt({
            planContext: workerPacket.planContext,
            candidateContext: workerPacket.candidateContext,
            baseSha: workerPacket.baseSha,
            currentSha: workerPacket.target.commitSha,
            worktreePath: workerPacket.workspace.path,
          }),
  });
  const result = await args.subagents.waitFor<unknown>(handle, args.signal);
  if (result.status !== "completed") {
    throw new Error(`Whole-plan reviewer ${result.status}: ${result.error}`);
  }
  if (
    (await args.git.head()) !== target ||
    (await args.git.treeAt(target)) !== targetTree ||
    !(await args.git.isCleanExcept(protectedPaths)) ||
    (await args.git.hasStagedChangesInPaths(protectedPaths)) ||
    (await args.git.activeOperation()) ||
    !protectedArtifactsMatch(args.state)
  ) {
    throw new Error(
      "Whole-plan reviewer changed the target checkout or protected corpus.",
    );
  }
  const completion = result.result as InitialOverallReviewCompletion;
  const evidence = writeWholePlanEvidence(args.artifactsPath, {
    packet,
    ...(anchored ? { anchored, outstandingFindings } : {}),
    completion,
  });
  if (anchored) {
    await args.dispatch({
      kind: "whole_plan_review_completed",
      outcome: {
        kind: "anchored",
        completion: result.result as AnchoredWorkstreamReviewCompletion,
        evidence,
        reviewedTargetSha: target,
        reviewedTargetTreeSha: targetTree,
      },
    });
    return;
  }
  if (completion.verdict === "approved") {
    await args.dispatch({
      kind: "whole_plan_review_completed",
      outcome: {
        kind: "approved",
        evidence,
        reviewedTargetSha: target,
        reviewedTargetTreeSha: targetTree,
      },
    });
    return;
  }
  const repairId = nextRepairId(args.state);
  await args.dispatch({
    kind: "whole_plan_review_completed",
    outcome: {
      kind: "changes_requested",
      repairId,
      candidate: {
        id: `overall-baseline:${args.state.run.id}:${repairId}:${target}`,
        workstream: { kind: "overall", repairId },
        baseSha: target,
        commitSha: target,
        treeSha: await args.git.treeAt(target),
      },
      findings: completion.findings.map((finding) => ({
        summary: finding.summary,
        evidence: finding.evidence,
        requiredChange: finding.requiredChange,
        acceptanceCriteria: finding.acceptanceCriteria,
      })),
      evidence,
      reviewedTargetSha: target,
      reviewedTargetTreeSha: targetTree,
    },
  });
}

export async function completeWholePlanRun(args: {
  state: RunState;
  git: GitClient;
  dispatch: (event: SchedulerEvent) => Promise<void>;
}): Promise<void> {
  const review = args.state.wholePlanReview;
  if (
    review.status !== "approved" ||
    !review.reviewedTargetSha ||
    !review.reviewedTargetTreeSha ||
    !(await args.git.isCleanExcept(
      Object.keys(args.state.protectedArtifactHashes),
    )) ||
    (await args.git.hasStagedChangesInPaths(
      Object.keys(args.state.protectedArtifactHashes),
    )) ||
    (await args.git.activeOperation()) ||
    !protectedArtifactsMatch(args.state)
  ) {
    throw new Error(
      "Whole-plan closure cannot prove the reviewed target boundary.",
    );
  }
  const [head, tree] = await Promise.all([args.git.head(), args.git.tree()]);
  await args.dispatch({
    kind: "run_completed",
    targetSha: head,
    targetTreeSha: tree,
  });
}

function inlineImplementationEvidence(
  evidence: RunState["candidates"][string]["implementationEvidence"],
):
  | Pick<
      NonNullable<RunState["candidates"][string]["implementationEvidence"]>,
      "summary" | "verification" | "uncertainty" | "changedPaths"
    >
  | undefined {
  if (!evidence) {
    return undefined;
  }
  const { summary, verification, uncertainty, changedPaths } = evidence;
  return {
    summary,
    verification,
    ...(uncertainty ? { uncertainty } : {}),
    ...(changedPaths ? { changedPaths } : {}),
  };
}

function nextRepairId(state: RunState): string {
  let number = 1;
  while (state.workstreams.overall[`overall-repair-${number}`]) {
    number++;
  }
  return `overall-repair-${number}`;
}

function writeWholePlanEvidence(path: string, value: unknown): string {
  mkdirSync(path, { recursive: true });
  const fingerprint = sha256(JSON.stringify(value));
  const evidence = join(path, `whole-plan-review-${fingerprint}.json`);
  writeAtomicJson(evidence, value);
  return evidence;
}
