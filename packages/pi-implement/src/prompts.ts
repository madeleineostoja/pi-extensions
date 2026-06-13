import type { ExecutionManifest } from "./execution-plan.js";
import type { ParsedImplementerResult } from "./verdict.js";

export function formatExecutionManifestSummary(
  manifest?: ExecutionManifest,
): string {
  if (!manifest) {
    return "";
  }

  const parts: string[] = [
    "## Execution Manifest",
    "",
    "The per-task implementers were given only compiled task contracts, not the full plan. The manifest below records the contracts that controlled each task's scope. Your job is to verify that the completed implementation satisfies the full original human plan intent, not just the individual contracts.",
    "",
  ];

  if (manifest.sourcePlanPath) {
    parts.push(`- Source plan: ${manifest.sourcePlanPath}`);
  }
  if (manifest.sourcePlanHash) {
    parts.push(`- Source plan hash: ${manifest.sourcePlanHash}`);
  }
  if (manifest.plannerReason) {
    parts.push(`- Planner reason: ${manifest.plannerReason}`);
  }
  if (manifest.plannerConfidence) {
    parts.push(`- Planner confidence: ${manifest.plannerConfidence}`);
  }

  parts.push("", "### Compiled Task Contracts", "");
  parts.push(
    "Each per-task implementer received only its own compiled contract. The contracts below controlled the scope of each task during execution.",
    "",
  );

  for (const task of manifest.tasks) {
    parts.push(`#### ${task.id}: ${task.title}`);
    parts.push(`- Objective: ${task.compiledContract.objective}`);
    parts.push(
      `- In scope: ${task.compiledContract.inScope.join(", ")}`,
    );
    parts.push(
      `- Acceptance criteria: ${task.compiledContract.acceptanceCriteria.join(", ")}`,
    );
    parts.push(
      `- Out of scope: ${task.compiledContract.outOfScope.join(", ")}`,
    );
    parts.push("");
  }

  parts.push(
    "### Review Focus",
    "",
    "- Check for planner/compiler omissions: requirements in the original plan that were missed because no compiled task contract covered them.",
    "- Verify that tasks integrate correctly even though they were implemented in isolation.",
    "- Confirm cross-task gaps and edge cases from the original plan were addressed.",
    "",
  );

  return parts.join("\n");
}

function buildSiblingTasksSection(outOfScopeTasks?: string[]): string {
  if (!outOfScopeTasks || outOfScopeTasks.length === 0) {
    return "";
  }
  return `\n## Out-of-Scope Sibling Tasks\n\nThe following tasks are not selected. Use them only to identify scope creep in the candidate diff.\n\n${outOfScopeTasks.join("\n")}\n`;
}

export function buildImplementerPrompt(args: {
  compiledContract: string;
  worktreePath: string;
  feedback?: string;
  priorSummary?: string;
  scoutContext?: string;
}): string {
  const retry = args.feedback
    ? `\n## Retry Context\n\nPrevious attempt summary:\n${args.priorSummary ?? "(none)"}\n\nFeedback to address:\n${args.feedback}\n`
    : "";
  const scout = args.scoutContext
    ? `\n## Scout Context\n\nThe following context was gathered by a read-only Scout for this attempt only. It is a starting map, not authoritative truth.\n\n- Treat Scout findings as hints, not facts. Read relevant files yourself before editing.\n- Do not expand your implementation scope based on Scout discoveries. Stick to the selected task contract.\n- Avoid broad repository searches unless the Scout context is clearly insufficient for the task.\n\n${args.scoutContext}\n`
    : "";
  const intro = `You are the pi-implement implementer for exactly one task. This prompt is the complete task contract and must work even if your subagent definition is generic.

Run non-interactively. No human will see your intermediate messages or answer questions. Never ask for clarification, never ask how to proceed, and never wait for input. Make reasonable decisions yourself and finish with the result block.

You have been assigned a dedicated Git worktree for this task. Read and write only inside the assigned worktree:

  ${args.worktreePath}

Do not read or write files outside the assigned worktree. Any shell command that touches project files must run from or explicitly target the assigned worktree path above.

The compiled task contract below is the complete, authoritative implementation scope for this task. Sibling task contracts are intentionally omitted — they are not truncation and not your concern. They do not expand your scope.

**Required implementation scope:** Only the items listed in the compiled task contract. Do not implement sibling tasks or unrelated cleanup, even when broader context mentions them.

If you notice you are implementing an unselected sibling task, stop and narrow the change to only what is necessary for the selected task. If the selected task is impossible without some prerequisite work from a sibling task, do only the minimal prerequisite and explain it in your summary and verification. Do not complete the sibling task's own deliverable.

Do not edit source plan files or checklist state. Do not stage, commit, reset, checkout, rebase, merge, tag, push, clean, or force-add ignored files.

Make the necessary code, documentation, and test changes for the selected task. Choose and run task-appropriate verification. When in doubt, run more verification rather than less: time is cheap, missed regressions are not. Precommit hooks will run on commit and cannot be bypassed, so satisfy lint, format, typecheck, and test expectations from the start. If verification is limited or fails, report that clearly.

If blocked, leave the repository in a safe state and explain the blocker in the result block.`;
  return `${intro}${retry}${scout}
## Compiled Task Contract

${args.compiledContract}

End with exactly one <pi-implement-result> block containing raw JSON matching this shape. Do not wrap it in a markdown code fence. Do not put comments in the JSON.

Use \`outcome: "changed"\` when you have made new code, test, or documentation changes that require a commit.
Use \`outcome: "already_satisfied"\` only when the current repository state already satisfies the selected task and no file changes are necessary. You must verify the selected task against current files and tests before claiming \`already_satisfied\`; do not use it to avoid work.

<pi-implement-result>
{
  "outcome": "changed",
  "summary": "Briefly describe what changed.",
  "verification": [
    {
      "command": "command or check that was run",
      "result": "passed, failed, or not applicable",
      "rationale": "why this verification is sufficient or what limitation remains"
    }
  ],
  "commitMessage": "type: short description\\n\\nOptional body explaining non-obvious context."
}
</pi-implement-result>

Or for already-satisfied:

<pi-implement-result>
{
  "outcome": "already_satisfied",
  "summary": "Briefly describe why the task is already satisfied.",
  "verification": [
    {
      "command": "command or check that was run",
      "result": "passed, failed, or not applicable",
      "rationale": "why this verification is sufficient or what limitation remains"
    }
  ]
}
</pi-implement-result>
`;
}

export function buildReviewerPrompt(args: {
  compiledContract: string;
  worktreePath: string;
  implementer: ParsedImplementerResult;
  outOfScopeTasks?: string[];
  priorRequiredChanges?: string[];
  baseSha?: string;
  alreadySatisfiedDiscrepancy?: boolean;
}): string {
  const siblingSection = buildSiblingTasksSection(args.outOfScopeTasks);
  const discrepancySection = args.alreadySatisfiedDiscrepancy
    ? `\n## Outcome Discrepancy

The implementer reported \`already_satisfied\` (claiming the task needed no changes) but nonetheless produced the staged diff below. Treat the diff as the ground truth and judge it on its own merits: approve only if these changes correctly and minimally satisfy the selected task. Request changes if the diff is spurious, incomplete, out-of-scope, or if the task is genuinely already satisfied and these edits should not be committed.\n`
    : "";
  const diffInstructions = args.baseSha
    ? `The candidate diff is committed on this task branch. Use read-only git commands such as:
- \`cd ${args.worktreePath} && git diff ${args.baseSha}..HEAD\`
- \`git diff ${args.baseSha}..HEAD --stat\` (run from the worktree)
- \`git diff ${args.baseSha}..HEAD --name-status\` (run from the worktree)
- \`git show HEAD\` (run from the worktree)
- \`git show HEAD:path/to/file\` (run from the worktree)`
    : `Inspect the staged candidate diff in the assigned worktree. Use read-only git commands such as:
- \`cd ${args.worktreePath} && git diff --cached HEAD\`
- \`git diff --cached --stat HEAD\` (run from the worktree)
- \`git diff --cached --name-status HEAD\` (run from the worktree)
- \`git show :path/to/file\` (run from the worktree)`;
  const isAnchored = (args.priorRequiredChanges?.length ?? 0) > 0;
  const reviewModeSection = isAnchored
    ? `## Review Mode: Anchored Re-review

Assess only whether each prior required change is resolved. If requesting changes, \`requiredChanges\` must contain exact copies of unresolved prior item text only. Do not restate, broaden, or introduce new issues, even if you notice one during re-review. New or broader concerns belong to the final overall review/rework loop.

## Prior Required Changes

${args.priorRequiredChanges!.map((c, i) => `${i + 1}. ${c}`).join("\n")}`
    : `## Review Mode: Initial Material Review

Perform one complete pass for material task-level blockers. List every blocking issue that must be fixed before this task can be committed.

You may request meaningful cleanup or code-quality fixes when they materially affect maintainability or are naturally coupled to larger required changes. Do not block solely for personal style preferences, trivial nits, speculative improvements, unrelated existing problems, or optional refactors. Non-blocking observations should not be included in \`requiredChanges\`; leave broader concerns for the final overall review.`;

  return `You are the pi-implement reviewer for exactly one staged task candidate. This prompt is the complete review contract and must work even if your subagent definition is generic.

Run non-interactively. No human will see your intermediate messages or answer questions. Never ask for clarification or how to proceed; reach a verdict yourself and finish with the result block. The compiled task contract is a deliberate single-task slice; sibling task contracts are intentionally omitted and are out of scope.

The candidate diff lives in the assigned worktree for this task:

  ${args.worktreePath}

${diffInstructions}

This is review only, not implementation. Do not edit files, stage, reset, commit, checkout, merge, rebase, clean, install dependencies, run formatters with write/fix flags, or change HEAD. You may run read-only commands and read/search relevant files to understand the current implementation.

You are a read-only reviewer and may be unable to install dependencies, run write-producing setup, or execute unavailable commands. If you cannot perform necessary validation because of these limitations, request a concrete implementer action such as running the missing verification command, adding or adjusting objective tests, or reporting verification output in the next implementer result. Treat this as a normal \`changes_requested\` result, not a subagent or system failure.

${reviewModeSection}
${discrepancySection}
## Scope Review Rules

- Small prerequisite changes needed for the selected task may be approved.
- Request changes if the staged diff substantially implements an unselected sibling task, broad remaining-plan work, or unrelated cleanup that is not a necessary minimal prerequisite for the selected task.
- Completing a sibling task's own deliverable is scope creep, even if it seems convenient.${siblingSection}

## Compiled Task Contract

${args.compiledContract}

## Implementer Summary

${args.implementer.summary}

## Implementer Verification

${formatVerification(args.implementer)}

End with exactly one <pi-review-result> block containing raw JSON. Do not wrap it in a markdown code fence. Approve with:

<pi-review-result>
{
  "verdict": "approved"
}
</pi-review-result>

Or request changes with at most 5 concise required changes:

<pi-review-result>
{
  "verdict": "changes_requested",
  "requiredChanges": [
    "Concrete material issue that must be fixed before approval."
  ]
}
</pi-review-result>
`;
}

export function buildAlreadySatisfiedReviewerPrompt(args: {
  compiledContract: string;
  worktreePath: string;
  implementer: ParsedImplementerResult;
  headSha: string;
  accumulatedDiff?: string;
  outOfScopeTasks?: string[];
  priorRequiredChanges?: string[];
}): string {
  const siblingSection = buildSiblingTasksSection(args.outOfScopeTasks);
  const diffSection =
    args.accumulatedDiff !== undefined
      ? `## Accumulated Run Diff\n\n\`\`\`diff\n${args.accumulatedDiff}\n\`\`\`\n`
      : `## Accumulated Run Diff\n\nThe accumulated diff from the run start to current HEAD was too large to include or was not available. Inspect the current repository state directly using read-only git and file commands.\n`;
  const isAnchored = (args.priorRequiredChanges?.length ?? 0) > 0;
  const reviewModeSection = isAnchored
    ? `## Review Mode: Anchored Re-review\n\nAssess only whether each prior required change is resolved. If requesting changes, \`requiredChanges\` must contain exact copies of unresolved prior item text only. Do not restate, broaden, or introduce new issues, even if you notice one during re-review. New or broader concerns belong to the final overall review/rework loop.\n\n## Prior Required Changes\n\n${args.priorRequiredChanges!.map((c, i) => `${i + 1}. ${c}`).join("\n")}`
    : `## Review Mode: Initial Material Review\n\nPerform one complete pass for material task-level blockers. List every blocking issue that must be fixed before this task can be accepted as already satisfied.\n\nYou may request meaningful cleanup or code-quality fixes when they materially affect maintainability or are naturally coupled to larger required changes. Do not block solely for personal style preferences, trivial nits, speculative improvements, unrelated existing problems, or optional refactors. Non-blocking observations should not be included in \`requiredChanges\`; leave broader concerns for the final overall review.`;

  return `You are the pi-implement reviewer for exactly one task. This prompt is the complete review contract and must work even if your subagent definition is generic.

Run non-interactively. No human will see your intermediate messages or answer questions. Never ask for clarification or how to proceed; reach a verdict yourself and finish with the result block. The compiled task contract is a deliberate single-task slice; sibling task contracts are intentionally omitted and are out of scope.

There is no staged candidate diff for this task. The implementer claims the selected task is already satisfied by the current repository state. Your job is to verify that claim.

The selected task's required scope is defined in the compiled task contract. Approve when the compiled contract is satisfied now. Do not require a new commit solely because the satisfying changes came from an earlier pi-implement task.

Inspect the current repository state in the assigned worktree:

  ${args.worktreePath}

Use read-only git commands and file inspection to verify the claim. Do not edit files, stage, reset, commit, checkout, merge, rebase, clean, install dependencies, run formatters with write/fix flags, or change HEAD.

You are a read-only reviewer and may be unable to install dependencies, run write-producing setup, or execute unavailable commands. If you cannot perform necessary validation because of these limitations, request a concrete implementer action such as running the missing verification command, adding or adjusting objective tests, or reporting verification output in the next implementer result. Treat this as a normal \`changes_requested\` result, not a subagent or system failure.

${reviewModeSection}${siblingSection}

## Compiled Task Contract

${args.compiledContract}

## Implementer Summary

${args.implementer.summary}

## Implementer Verification

${formatVerification(args.implementer)}

Current HEAD: ${args.headSha}

${diffSection}
End with exactly one <pi-review-result> block containing raw JSON. Do not wrap it in a markdown code fence. Approve with:

<pi-review-result>
{
  "verdict": "approved"
}
</pi-review-result>

Or request changes with at most 5 concise required changes:

<pi-review-result>
{
  "verdict": "changes_requested",
  "requiredChanges": [
    "Concrete material issue that must be fixed before approval."
  ]
}
</pi-review-result>
`;
}

export function buildIntegrationSelfHealPrompt(args: {
  taskId: string;
  title: string;
  planIndex: number;
  taskCommitSha: string;
  preIntegrationHead: string;
  mainCheckoutPath: string;
  worktreePath?: string;
  validationCommands?: string[];
  validationFailure?: string;
  cherryPickFailure?: string;
  landedTasks?: Array<{ id: string; title: string; commitSha?: string }>;
  runArtifactPaths?: string[];
  graphContext?: string;
}): string {
  const landedSection =
    args.landedTasks && args.landedTasks.length > 0
      ? `\n## Landed Tasks\n\n${args.landedTasks.map((t) => `- ${t.id}: ${t.title}${t.commitSha ? ` @ ${t.commitSha.slice(0, 7)}` : ""}`).join("\n")}\n`
      : "";
  const validationSection = args.validationFailure
    ? `\n## Validation Failure\n\nCommands: ${args.validationCommands?.join(", ") ?? "(auto-detected)"}\n\n${args.validationFailure}\n`
    : "";
  const cherryPickSection = args.cherryPickFailure
    ? `\n## Cherry-Pick Failure\n\n${args.cherryPickFailure}\n`
    : "";
  const artifactSection =
    args.runArtifactPaths && args.runArtifactPaths.length > 0
      ? `\n## Run Artifacts\n\n${args.runArtifactPaths.join("\n")}\n`
      : "";
  const graphSection = args.graphContext
    ? `\n## Graph Context\n\n${args.graphContext}\n`
    : "";

  return `You are the pi-implement integration self-heal agent. Your job is to diagnose and repair integration transactions in the main checkout so the orchestrator can retry the deterministic integration step.

Run non-interactively. No human will see your intermediate messages or answer questions. Never ask for clarification, never ask how to proceed, and never wait for input. Make reasonable decisions yourself and finish with the result block.

## Task Context

- Task ID: ${args.taskId}
- Title: ${args.title}
- Plan index: ${args.planIndex + 1}
- Task commit SHA: ${args.taskCommitSha}
- Pre-integration HEAD: ${args.preIntegrationHead}
- Main checkout: ${args.mainCheckoutPath}
${args.worktreePath ? `- Task worktree: ${args.worktreePath}\n` : ""}${landedSection}${artifactSection}${graphSection}${validationSection}${cherryPickSection}
## Permissions

You may:
- Inspect run artifacts, git status, branches, worktrees, package manager state, and validation logs.
- Repair integration/runtime state, install dependencies using the inferred package manager, resolve conflicts, stage integration-resolution changes, and rerun validation.
- Leave staged integration-resolution changes in the main checkout when needed.

You must NOT:
- Implement future plan tasks.
- Edit source plan or checklist artifacts.
- Push, rebase, rewrite unrelated history, or bypass validation.
- Commit or change HEAD.
- Hide uncertainty.

## Repair Result

End with exactly one <pi-self-heal-result> block containing raw JSON matching this shape. Do not wrap it in a markdown code fence. Do not put comments in the JSON.

<pi-self-heal-result>
{
  "repaired": true,
  "retryIntegration": true,
  "retryMode": "continue_candidate",
  "summary": "Briefly describe what was repaired.",
  "commands": ["commands", "run"],
  "filesChanged": ["file1.ts", "package-lock.json"],
  "remainingBlocker": null
}
</pi-self-heal-result>

\`retryMode\` must be one of:
- \`continue_candidate\`: the current checkout/index contains the repaired integration candidate. The orchestrator will proceed to snapshot and validation.
- \`retry_cherry_pick\`: the agent cleaned/aborted/reset the interrupted candidate and the orchestrator should rerun \`git cherry-pick --no-commit <taskCommitSha>\` from the pre-integration HEAD.
- \`retry_validation\`: the candidate is already applied and only validation should be rerun, usually after environment repair such as dependency installation.

If you cannot repair the issue, set \`repaired: false\` and \`retryIntegration: false\`, and provide a clear \`remainingBlocker\`.
`;
}

export function buildSchedulerSelfHealPrompt(args: {
  runId: string;
  mode?: string;
  maxConcurrency?: number;
  baseSha: string;
  currentHead: string;
  planPath: string;
  graphSummary: string;
  eventsTail: string;
  artifactPaths?: string[];
  gitStatus: string;
  matchingBranches: string[];
  worktrees: string[];
}): string {
  const artifactSection =
    args.artifactPaths && args.artifactPaths.length > 0
      ? `\n## Task Artifacts\n\n${args.artifactPaths.join("\n")}\n`
      : "";
  const branchSection =
    args.matchingBranches.length > 0
      ? `\n## Matching Branches\n\n${args.matchingBranches.join("\n")}\n`
      : "\n## Matching Branches\n\n(none)\n";
  const worktreeSection =
    args.worktrees.length > 0
      ? `\n## Worktrees\n\n${args.worktrees.join("\n")}\n`
      : "\n## Worktrees\n\n(none)\n";

  return `You are the pi-implement scheduler self-heal agent. Your job is to diagnose and repair run-level orchestration state so the scheduler can retry, not to implement future plan tasks.

Run non-interactively. No human will see your intermediate messages or answer questions. Never ask for clarification, never ask how to proceed, and never wait for input. Make reasonable decisions yourself and finish with the result block.

## Run Context

- Run ID: ${args.runId}
- Mode: ${args.mode ?? "parallel"}
- Max concurrency: ${args.maxConcurrency ?? 1}
- Base SHA: ${args.baseSha}
- Current HEAD: ${args.currentHead}
- Plan path: ${args.planPath}

## Graph Summary

${args.graphSummary}

## Recent Events

${args.eventsTail}${artifactSection}${branchSection}${worktreeSection}
## Git Status

\`\`\`
${args.gitStatus}
\`\`\`

## Permissions

You may:
- Inspect run artifacts, git status, branches, worktrees, and task logs.
- Remove stale branches and worktrees that match the exact run/task naming scheme.
- Install dependencies or clear interrupted git state if needed.
- Leave the main checkout clean except for plan artifacts.

You must NOT:
- Implement future plan tasks.
- Edit source plan or checklist artifacts.
- Push, rebase, rewrite unrelated history, or bypass validation.
- Commit or change HEAD on the main checkout.
- Hide uncertainty.

## Repair Result

End with exactly one <pi-self-heal-result> block containing raw JSON matching this shape. Do not wrap it in a markdown code fence. Do not put comments in the JSON.

<pi-self-heal-result>
{
  "repaired": true,
  "retryScheduler": true,
  "summary": "Briefly describe what was repaired.",
  "commands": ["commands", "run"],
  "filesChanged": [],
  "remainingBlocker": null
}
</pi-self-heal-result>

If you cannot repair the issue, set \`repaired: false\` and \`retryScheduler: false\`, and provide a clear \`remainingBlocker\`.
`;
}

export function buildOverallReviewerPrompt(args: {
  planContent: string;
  planPath: string;
  baseSha: string;
  headSha: string;
  diff: string;
  runId?: string;
  landedTasks?: Array<{ id: string; title: string; commitSha?: string }>;
  bundleMaterial?: string;
  corpusMaterial?: string;
  executionManifest?: ExecutionManifest;
}): string {
  const runSection = args.runId ? `\nRun ID: ${args.runId}\n` : "\n";
  const taskSection =
    args.landedTasks && args.landedTasks.length > 0
      ? `\n## Landed Tasks\n\n${args.landedTasks.map((t) => `- ${t.id}: ${t.title}${t.commitSha ? ` @ ${t.commitSha.slice(0, 7)}` : ""}`).join("\n")}\n`
      : "";
  const bundleSection = args.bundleMaterial
    ? `\n\n## Referenced Plan Material\n\n${args.bundleMaterial}`
    : "";
  const corpusSection = args.corpusMaterial
    ? `\n\n## Plan Corpus\n\n${args.corpusMaterial}`
    : "";
  const manifestSection = formatExecutionManifestSummary(
    args.executionManifest,
  );
  return `You are the pi-implement overall reviewer. This is a read-only whole-feature review after all planned tasks have been implemented and committed.

Assess whether the combined implementation satisfies the original plan, whether cross-task gaps or edge cases were missed, and whether the tasks fit together correctly.

Do not edit files, stage, reset, commit, checkout, merge, rebase, clean, install dependencies, or run any command that changes files or git state. Use read-only commands only.

## Plan

Source: ${args.planPath}
Base SHA: ${args.baseSha}
Head SHA: ${args.headSha}${runSection}${taskSection}

${args.planContent}${bundleSection}${corpusSection}

${manifestSection}## Combined Diff

\`\`\`diff
${args.diff}
\`\`\`

## Review Rules

- Approve if the feature is complete, correct, and the tasks integrate well.
- Request changes if there are material gaps, missed edge cases, integration problems, or insufficient verification.
- Be specific about what must change. In particular, check for planner/compiler omissions: requirements in the original plan that may have been missed because no compiled task contract covered them.

End with exactly one <pi-overall-review-result> block containing raw JSON matching this shape. Do not wrap it in a markdown code fence. Do not put comments in the JSON.

Approved:
<pi-overall-review-result>
{
  "verdict": "approved"
}
</pi-overall-review-result>

Changes requested:
<pi-overall-review-result>
{
  "verdict": "changes_requested",
  "requiredChanges": [
    "Concrete follow-up change required before considering the feature complete."
  ],
  "recommendationMarkdown": "## Suggested Follow-up\\n\\n..."
}
</pi-overall-review-result>
`;
}

export function buildOverallReworkPrompt(args: {
  planContent: string;
  planPath: string;
  baseSha: string;
  headSha: string;
  diff: string;
  runId?: string;
  landedTasks?: Array<{ id: string; title: string; commitSha?: string }>;
  bundleMaterial?: string;
  corpusMaterial?: string;
  requiredChanges: string[];
  recommendationMarkdown?: string;
  priorAttemptFailures?: string[];
  executionManifest?: ExecutionManifest;
}): string {
  const runSection = args.runId ? `\nRun ID: ${args.runId}\n` : "\n";
  const taskSection =
    args.landedTasks && args.landedTasks.length > 0
      ? `\n## Landed Tasks\n\n${args.landedTasks.map((t) => `- ${t.id}: ${t.title}${t.commitSha ? ` @ ${t.commitSha.slice(0, 7)}` : ""}`).join("\n")}\n`
      : "";
  const bundleSection = args.bundleMaterial
    ? `\n\n## Referenced Plan Material\n\n${args.bundleMaterial}`
    : "";
  const corpusSection = args.corpusMaterial
    ? `\n\n## Plan Corpus\n\n${args.corpusMaterial}`
    : "";
  const priorFailuresSection =
    args.priorAttemptFailures && args.priorAttemptFailures.length > 0
      ? `\n## Prior Rework Attempt Failures\n\n${args.priorAttemptFailures.map((f, i) => `${i + 1}. ${f}`).join("\n")}\n`
      : "";
  const recommendationSection = args.recommendationMarkdown
    ? `\n## Recommendation\n\n${args.recommendationMarkdown}\n`
    : "";
  const manifestSection = formatExecutionManifestSummary(
    args.executionManifest,
  );

  return `You are the pi-implement overall rework implementer. Your job is to address the overall review feedback for the completed feature.

Run non-interactively. No human will see your intermediate messages or answer questions. Never ask for clarification, never ask how to proceed, and never wait for input. Make reasonable decisions yourself and finish with the result block.

## Scope

Make only the changes required to satisfy the overall review feedback and the original plan. Do not reopen completed tasks for unrelated improvements or scope creep.

## Constraints

Do not edit source plan files or checklist state. Do not stage, commit, reset, checkout, rebase, merge, tag, push, clean, or force-add ignored files.

## Context

Source: ${args.planPath}
Base SHA: ${args.baseSha}
Head SHA: ${args.headSha}${runSection}${taskSection}

${args.planContent}${bundleSection}${corpusSection}

${manifestSection}## Combined Diff

\`\`\`diff
${args.diff}
\`\`\`

## Required Changes

${args.requiredChanges.map((c) => `- ${c}`).join("\n")}
${recommendationSection}${priorFailuresSection}
End with exactly one <pi-overall-rework-result> block containing raw JSON matching this shape. Do not wrap it in a markdown code fence. Do not put comments in the JSON.

<pi-overall-rework-result>
{
  "summary": "Briefly describe what changed.",
  "verification": [
    {
      "command": "command or check that was run",
      "result": "passed, failed, or not applicable",
      "rationale": "why this verification is sufficient or what limitation remains"
    }
  ],
  "commitMessage": "type: short description"
}
</pi-overall-rework-result>

The commitMessage is optional; if omitted or invalid, a fallback will be used.
`;
}

function formatVerification(result: ParsedImplementerResult): string {
  return result.verification
    .map(
      (step) =>
        `- Command/check: ${step.command}\n  Result: ${step.result}\n  Rationale: ${step.rationale}`,
    )
    .join("\n");
}
