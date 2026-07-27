import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExecutionPlan } from "./execution-plan.js";
import type { GitClient } from "./git.js";
import {
  buildAnchoredOverallReviewPrompt,
  buildInitialOverallReviewPrompt,
} from "./prompts.js";
import { sha256 } from "./source-integrity.js";
import {
  anchoredReviewSchema,
  initialOverallReviewSchema,
  wholePlanRecoveryCompletionSchema,
  type AnchoredWorkstreamReviewCompletion,
  type InitialOverallReviewCompletion,
  type WholePlanRecoveryCompletion,
} from "./result-schemas.js";
import { boundedRecoveryOutput, type RecoveryAction } from "./recovery.js";
import type { SchedulerEvent } from "./scheduler.js";
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
  planContext: string;
  candidateContext: string;
  fullDiff: string;
  latestDelta?: string;
  receipts: RunState["publication"]["receipts"];
  uncertainty: string[];
  outstandingFindings: NonNullable<
    RunState["wholePlanReview"]["epoch"]
  >["findings"];
};

export type WholePlanRecoveryPacket = {
  role: "recovery";
  completionKind: "whole-plan-recovery";
  identity: string;
  workspace: { path: string; mutationBoundary: string };
  failure: NonNullable<RunState["wholePlanReview"]["recovery"]>;
};

export function buildWholePlanReviewPacket(args: {
  state: RunState;
  plan: ExecutionPlan;
  currentTargetSha: string;
  currentTargetTreeSha: string;
  fullDiff: string;
  latestDelta?: string;
  completionKind: WholePlanReviewPacket["completionKind"];
  outstandingFindings: WholePlanReviewPacket["outstandingFindings"];
}): WholePlanReviewPacket {
  if (!protectedArtifactsMatch(args.state)) {
    throw new Error(
      "Whole-plan review material no longer matches the immutable corpus.",
    );
  }
  const source = args.plan.source.corpusFiles.map((artifact) => ({
    path: artifact.path,
    content: readFileSync(artifact.path, "utf-8"),
  }));
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
    outstandingFindings: args.outstandingFindings,
    planContext: [
      "## Immutable execution plan",
      JSON.stringify(args.plan, null, 2),
      "## Source corpus",
      ...source.map(({ path, content }) => `### ${path}\n${content}`),
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
      "## Complete run diff",
      `\`\`\`diff\n${args.fullDiff}\n\`\`\``,
    ].join("\n\n"),
    fullDiff: args.fullDiff,
    ...(args.latestDelta ? { latestDelta: args.latestDelta } : {}),
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
      (intent) => !args.state.publication.receipts[intent.id],
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
  const fullDiff = await args.git.diffRange(
    args.state.run.checkout.startHead,
    target,
  );
  const latestDelta = anchored
    ? await args.git.diffRange(anchored.targetBaseSha, target)
    : undefined;
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
    fullDiff,
    ...(latestDelta ? { latestDelta } : {}),
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
    readOnly: true,
    completionKind: packet.completionKind,
    completion: (anchored
      ? {
          description: "Assess every outstanding finding.",
          schema: anchoredReviewSchema,
        }
      : {
          description:
            "Approve the complete run or return direct blocking findings.",
          schema: initialOverallReviewSchema,
        }) as never,
    render: (workerPacket) =>
      anchored
        ? buildAnchoredOverallReviewPrompt({
            planContext: workerPacket.planContext,
            candidateContext: workerPacket.candidateContext,
            outstandingFindings: workerPacket.outstandingFindings as never,
            previousCandidate: anchored.targetBaseSha,
            currentCandidate: anchored.publishedCommitSha,
            latestDelta: workerPacket.latestDelta ?? "",
            worktreePath: workerPacket.workspace.path,
          })
        : buildInitialOverallReviewPrompt({
            planContext: workerPacket.planContext,
            candidateContext: workerPacket.candidateContext,
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

export async function runWholePlanRecovery(args: {
  state: RunState;
  subagents: SubagentClient;
  signal?: AbortSignal;
  roles: ImplementRoles;
}): Promise<RecoveryAction> {
  const recovery = args.state.wholePlanReview.recovery;
  if (!recovery || recovery.status !== "running") {
    throw new Error("Whole-plan recovery has no retained failure evidence.");
  }
  const packet: WholePlanRecoveryPacket = {
    role: "recovery",
    completionKind: "whole-plan-recovery",
    identity: `${args.state.run.id}/whole-plan-recovery`,
    workspace: {
      path: args.state.run.checkout.root,
      mutationBoundary:
        "Read-only target checkout; diagnose retained whole-plan failure only.",
    },
    failure: recovery,
  };
  const handle = await spawnValidatedWorker({
    packet,
    subagents: args.subagents,
    roles: args.roles,
    taskId: "whole-plan-recovery",
    description: `Recover whole-plan review for ${args.state.run.id}`,
    readOnly: true,
    completionKind: "whole-plan-recovery",
    completion: {
      description: "Return a bounded whole-plan recovery action.",
      schema: wholePlanRecoveryCompletionSchema,
    },
    render: (workerPacket) =>
      `You are the Pipkin Implement recovery agent for a failed whole-plan review. ${workerPacket.workspace.mutationBoundary} Do not edit files, change Git state, install dependencies, or rerun the review yourself. Return retry when the orchestrator can safely rerun the same immutable assessment, diagnose for additional bounded evidence, or no_safe_action when manual intervention is required.\n\n${JSON.stringify(workerPacket.failure, null, 2)}`,
  });
  const response = await args.subagents.waitFor<WholePlanRecoveryCompletion>(
    handle,
    args.signal,
  );
  if (response.status !== "completed") {
    throw new Error(
      `Whole-plan recovery agent ${response.status}: ${response.error}`,
    );
  }
  const completion = response.result;
  return {
    kind: completion.action,
    outcome:
      completion.action === "no_safe_action" ? "no_safe_action" : "completed",
    summary: completion.summary,
    evidence: boundedRecoveryOutput(
      completion.diagnosis
        ? `${completion.evidence}\nDiagnosis: ${completion.diagnosis}`
        : completion.evidence,
    ),
    at: new Date().toISOString(),
  };
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
