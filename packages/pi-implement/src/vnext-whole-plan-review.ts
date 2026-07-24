import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExecutionPlan } from "./execution-plan-vnext.js";
import type { GitClient } from "./git.js";
import { buildInitialOverallReviewPrompt } from "./prompts.js";
import {
  initialOverallReviewSchema,
  type InitialOverallReviewCompletion,
} from "./result-schemas.js";
import type { VNextSchedulerEvent } from "./scheduler-vnext.js";
import type { SubagentClient } from "./subagents.js";
import { writeAtomicJson } from "./atomic-json.js";
import { protectedArtifactsMatch, type VNextRunState } from "./vnext-store.js";

export type WholePlanReviewPacket = {
  planContext: string;
  candidateContext: string;
  fullDiff: string;
  receipts: VNextRunState["publication"]["receipts"];
  uncertainty: string[];
};

export function buildWholePlanReviewPacket(args: {
  state: VNextRunState;
  plan: ExecutionPlan;
  currentTargetSha: string;
  fullDiff: string;
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
            ? args.state.candidates[workstream.candidateId]
                ?.implementationEvidence
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
    receipts: args.state.publication.receipts,
    uncertainty,
  };
}

export async function runVNextWholePlanReview(args: {
  state: VNextRunState;
  plan: ExecutionPlan;
  git: GitClient;
  subagents: SubagentClient;
  artifactsPath: string;
  signal?: AbortSignal;
  dispatch: (event: VNextSchedulerEvent) => Promise<void>;
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
  if (!(await args.git.isClean()) || (await args.git.activeOperation())) {
    throw new Error(
      "Whole-plan review requires a clean target checkout with no active Git operation.",
    );
  }
  const target = await args.git.head();
  const [targetTree, fullDiff] = await Promise.all([
    args.git.treeAt(target),
    args.git.diffRange(args.state.run.checkout.startHead, target),
  ]);
  const packet = buildWholePlanReviewPacket({
    state: args.state,
    plan: args.plan,
    currentTargetSha: target,
    fullDiff,
  });
  const handle = await args.subagents.spawn({
    type: "pi-implement:reviewer",
    role: "reviewer",
    taskId: "whole-plan",
    description: `Review complete run ${args.state.run.id}`,
    cwd: args.state.run.checkout.root,
    readOnly: true,
    prompt: buildInitialOverallReviewPrompt({
      planContext: packet.planContext,
      candidateContext: packet.candidateContext,
      worktreePath: args.state.run.checkout.root,
    }),
    completion: {
      description:
        "Approve the complete run or return direct blocking findings.",
      schema: initialOverallReviewSchema,
    } as never,
  });
  const result = await args.subagents.waitFor<unknown>(handle, args.signal);
  if (result.status !== "completed") {
    throw new Error(`Whole-plan reviewer ${result.status}: ${result.error}`);
  }
  if (
    (await args.git.head()) !== target ||
    (await args.git.treeAt(target)) !== targetTree ||
    !(await args.git.isClean()) ||
    (await args.git.activeOperation()) ||
    !(await protectedArtifactsMatch(args.state))
  ) {
    throw new Error(
      "Whole-plan reviewer changed the target checkout or protected corpus.",
    );
  }
  const completion = result.result as InitialOverallReviewCompletion;
  const evidence = writeWholePlanEvidence(args.artifactsPath, {
    packet,
    completion,
  });
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
    },
  });
}

export async function completeVNextWholePlanRun(args: {
  state: VNextRunState;
  git: GitClient;
  dispatch: (event: VNextSchedulerEvent) => Promise<void>;
}): Promise<void> {
  const review = args.state.wholePlanReview;
  if (
    review.status !== "approved" ||
    !review.reviewedTargetSha ||
    !review.reviewedTargetTreeSha ||
    !(await args.git.isClean()) ||
    (await args.git.activeOperation()) ||
    !(await protectedArtifactsMatch(args.state))
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

function nextRepairId(state: VNextRunState): string {
  let number = 1;
  while (state.workstreams.overall[`overall-repair-${number}`]) {
    number++;
  }
  return `overall-repair-${number}`;
}

function writeWholePlanEvidence(path: string, value: unknown): string {
  mkdirSync(path, { recursive: true });
  const fingerprint = createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex");
  const evidence = join(path, `whole-plan-review-${fingerprint}.json`);
  writeAtomicJson(evidence, value);
  return evidence;
}
