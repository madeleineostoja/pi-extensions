import { buildReviewResponsibilityContext } from "./execution-plan.js";
import type {
  ExecutionManifest,
  RequirementRef,
  ReviewResponsibilityContext,
} from "./execution-plan.js";
import type { ReviewFinding } from "./review-convergence.js";

export const PAPERCUT_GUIDANCE = `## Optional Papercut Candidates

If this work exposed a novel recurring project-specific failure absent from current instructions, tests, tooling, or docs, include it in the optional \`papercuts\` result array. Each candidate must contain \`key\`, \`title\`, \`trigger\`, \`impact\`, \`currentGap\`, \`proposedResolution\`, and \`suggestedDestination\`. Use \`suggestedDestination\` only for \`agents\`, \`skill\`, \`test\`, \`lint\`, \`tooling\`, \`docs\`, or \`code\`. Malformed candidates are discarded without failing your result. Exclude expected intermediate, transient, ordinary self-corrected, and correctly guided failures.`;

export function formatExecutionManifestSummary(
  manifest?: ExecutionManifest,
  responsibilityContext?: ReviewResponsibilityContext,
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

  const context =
    responsibilityContext ?? buildReviewResponsibilityContext(manifest);
  const tasks = [...manifest.tasks].sort(
    (left, right) => left.planIndex - right.planIndex,
  );
  const requirementsByTask = new Map<string, RequirementRef[]>();
  for (const requirement of context?.requirements ?? []) {
    const requirements = requirementsByTask.get(requirement.taskId) ?? [];
    requirements.push(requirement);
    requirementsByTask.set(requirement.taskId, requirements);
  }

  parts.push("", "### Responsibility Map", "");
  parts.push(
    "Each per-task implementer received only its own detailed contract. This compact map records ownership and direct dependencies without expanding sibling scope.",
    "",
  );
  for (const task of tasks) {
    const responsibility = context?.responsibilities.find(
      (entry) => entry.taskId === task.id,
    );
    parts.push(`#### ${task.id}: ${task.title}`);
    parts.push(`- Objective: ${task.compiledContract.objective}`);
    parts.push(
      `- Owns: ${(responsibility?.owns ?? task.compiledContract.inScope).join("; ")}`,
    );
    parts.push(
      `- Direct dependencies: ${(responsibility?.dependsOn ?? task.dependsOn).join(", ") || "none"}`,
    );
    parts.push(
      `- Acceptance IDs: ${(responsibility?.acceptanceIds ?? []).join(", ") || "not derived"}`,
    );
    parts.push(`- In scope: ${task.compiledContract.inScope.join(", ")}`);
    parts.push(
      `- Acceptance criteria: ${task.compiledContract.acceptanceCriteria.join(", ")}`,
    );
    parts.push(
      `- Out of scope: ${task.compiledContract.outOfScope.join(", ")}`,
    );
    parts.push("");
  }

  if (context) {
    parts.push("### Requirement References", "");
    for (const task of tasks) {
      parts.push(`#### ${task.id}: ${task.title}`);
      for (const requirement of requirementsByTask.get(task.id) ?? []) {
        parts.push(
          `- ${requirement.id} (${requirement.kind}): ${requirement.text}${requirement.fallbackGenerated ? " (fallback-generated)" : ""}`,
        );
      }
      parts.push("");
    }
    parts.push(`Context identity: ${context.contextId}`, "");
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

function buildResponsibilitySection(args: {
  responsibilityContext?: ReviewResponsibilityContext;
  selectedTaskId?: string;
}): string {
  const { responsibilityContext: context, selectedTaskId } = args;
  if (!context || !selectedTaskId) {
    return "";
  }
  const selected = context.responsibilities.find(
    (responsibility) => responsibility.taskId === selectedTaskId,
  );
  if (!selected) {
    return "";
  }
  const requirements = context.requirements.filter(
    (requirement) => requirement.taskId === selectedTaskId,
  );
  const siblings = context.responsibilities.filter(
    (responsibility) => responsibility.taskId !== selectedTaskId,
  );
  return `## Stable Requirements\n\n${requirements.map((requirement) => `- ${requirement.id} (${requirement.kind}): ${requirement.text}${requirement.fallbackGenerated ? " (fallback-generated)" : ""}`).join("\n")}\n\n## Responsibility Context\n\nSelected task ${selected.taskId} owns: ${selected.owns.join("; ")}\nDirect dependencies: ${selected.dependsOn.join(", ") || "none"}\n\nSibling ownership is context for interface and scope boundaries, not permission to implement sibling deliverables.\n\n${siblings.map((sibling) => `- ${sibling.taskId}: ${sibling.title}\n  Objective: ${sibling.objective}\n  Owns: ${sibling.owns.join("; ")}\n  Direct dependencies: ${sibling.dependsOn.join(", ") || "none"}\n  Acceptance IDs: ${sibling.acceptanceIds.join(", ") || "none"}`).join("\n")}\n\nContext identity: ${context.contextId}`;
}

function formatSourceMaterialSection(sourceMaterial?: string): string {
  const material = sourceMaterial?.trim()
    ? sourceMaterial.trim()
    : "No referenced source material was resolved for this task.";
  return `## Referenced Source Material\n\n${material}`;
}

export function buildImplementerPrompt(args: {
  compiledContract: string;
  worktreePath: string;
  sourceMaterial?: string;
  responsibilityContext?: ReviewResponsibilityContext;
  selectedTaskId?: string;
  feedback?: string;
  priorSummary?: string;
  findingCompletions?: Array<{
    id: string;
    sourceScope: "task_review" | "integration_fallback";
    summary: string;
    evidence: string;
    requiredChange: string;
    acceptanceCriteria: string[];
    basis?: unknown;
  }>;
}): string {
  const reworkProtocol = args.findingCompletions?.length
    ? `\n## Rework Completion Protocol\n\nFor every supplied finding, return findingCompletions with each ID exactly once as addressed or not_addressed. Each completion requires concrete evidence, changedPaths, and finding-level verification. An addressed completion with no changed paths must explain why no source change was necessary. Your declaration is evidence for anchored review; it does not resolve a finding itself.\n\n${args.findingCompletions.map((finding) => `- ${finding.id} [${finding.sourceScope}]\n  Demonstrated defect: ${finding.evidence}\n  Requirement / acceptance basis: ${finding.acceptanceCriteria.join("; ")}\n  Requirement reference: ${JSON.stringify(finding.basis ?? "not recorded")}\n  Minimum observable correction: ${finding.requiredChange}`).join("\n")}`
    : "";
  const retry = args.feedback
    ? `\n## Retry Context\n\nPrevious attempt summary:\n${args.priorSummary ?? "(none)"}\n\nFeedback to address:\n${args.feedback}${reworkProtocol}\n`
    : reworkProtocol;
  const intro = `You are the pi-implement implementer for exactly one task. This prompt is the complete task packet and must work even if your subagent definition is generic.

Run non-interactively. No human will see your intermediate messages or answer questions. Never ask for clarification, never ask how to proceed, and never wait for input. Make reasonable decisions yourself and finish with the result block.

You have been assigned a dedicated Git worktree for this task. Read and write only inside the assigned worktree:

  ${args.worktreePath}

Do not read or write files outside the assigned worktree. Any shell command that touches project files must run from or explicitly target the assigned worktree path above.

The compiled task contract plus referenced source material below is the complete task packet for this task. Compact sibling responsibility context may be included for interface and scope boundaries; it does not expand your scope or provide sibling contract details.

**Required implementation scope:** Only the items listed in the compiled task contract. Referenced source material supplies exact details, constraints, examples, schemas, prompts, fixtures, or design context needed to satisfy that contract. Use referenced material only to satisfy the compiled contract. Do not implement sibling tasks or unrelated cleanup, even when broader context mentions them.

If you notice you are implementing an unselected sibling task, stop and narrow the change to only what is necessary for the selected task. If the selected task is impossible without some prerequisite work from a sibling task, do only the minimal prerequisite and explain it in your summary and verification. Do not complete the sibling task's own deliverable.

Do not edit source plan files or checklist state. Do not stage, commit, reset, checkout, rebase, merge, tag, push, clean, or force-add ignored files.

Make the necessary code, documentation, and test changes for the selected task. Choose and run task-appropriate verification. When in doubt, run more verification rather than less: time is cheap, missed regressions are not. Precommit hooks will run on commit and cannot be bypassed, so satisfy lint, format, typecheck, and test expectations from the start. If verification is limited or fails, report that clearly.

If useful, call the injected \`explore\` tool for broad map-building or targeted context checks before direct reads/searches. Treat exploration as guidance only: verify relevant findings yourself and do not expand scope based on exploration results.

If blocked, leave the repository in a safe state and explain the blocker in the result block.`;
  return `${intro}${retry}
## Compiled Task Contract

${args.compiledContract}

${formatSourceMaterialSection(args.sourceMaterial)}

${buildResponsibilitySection(args)}

${PAPERCUT_GUIDANCE}

Submit the result through the injected completion tool as your final action.
`;
}

export function buildIntegrationReviewerPrompt(args: {
  diff: string;
  planArtifacts: string[];
  deferredConcerns?: Array<{
    id: string;
    summary: string;
    evidence: string;
    basis: unknown;
  }>;
  outstandingFindings?: Array<{
    id: string;
    summary: string;
    evidence: string;
    requiredChange: string;
    acceptanceCriteria: string[];
  }>;
  previousCandidate?: string;
  currentCandidate?: string;
  latestDelta?: string;
  reworkCompletions?: Array<{
    id: string;
    status: "addressed" | "not_addressed";
    evidence: string;
    changedPaths: string[];
    verification: Array<{ command: string; result: string; rationale: string }>;
  }>;
}): string {
  const anchored = args.outstandingFindings
    ? `\n## Outstanding Integration Findings\n\n${args.outstandingFindings.map((finding) => `- ${finding.id}: ${finding.summary}\n  Evidence: ${finding.evidence}\n  Required change: ${finding.requiredChange}\n  Acceptance: ${finding.acceptanceCriteria.join("; ")}`).join("\n")}\n`
    : "";
  const deferred = args.deferredConcerns?.length
    ? `\n## Deferred Concerns\n\n${args.deferredConcerns.map((concern) => `- ${concern.id}: ${concern.summary}\n  Evidence: ${concern.evidence}\n  Basis: ${JSON.stringify(concern.basis)}`).join("\n")}\n`
    : "";
  const anchoredContext = args.outstandingFindings
    ? `\n## Anchored Candidate Context\n\nPrevious candidate: ${args.previousCandidate ?? "unknown"}\nCurrent candidate: ${args.currentCandidate ?? "unknown"}\n\nExact previous→current delta:\n\`\`\`diff\n${args.latestDelta ?? args.diff}\n\`\`\`\n\n## Owner Rework Declarations\n\n${args.reworkCompletions?.map((completion) => `- ${completion.id}: ${completion.status}\n  Evidence: ${completion.evidence}\n  Changed paths: ${completion.changedPaths.join(", ") || "none"}\n  Verification: ${completion.verification.map((step) => `${step.command}: ${step.result}`).join("; ")}`).join("\n") || "No matching declarations were recorded."}\n`
    : "";
  const resultProtocol = args.outstandingFindings
    ? "Return an anchored assessment for every outstanding ID exactly once, attributable regression proposals caused by the exact latest delta, and optional observations."
    : "Return approved or changes_requested with atomic proposal findings. Each proposal needs summary, evidence, requiredChange, acceptanceCriteria, and a grounded basis: requirement, candidate_regression, or correctness_invariant. Findings are proposals until separately admitted.";
  return `Review this integrated task diff on the main checkout.

No command validation is configured or auto-detected. Decide whether the integrated diff is safe to commit.

Do not edit files, stage, reset, commit, checkout, merge, rebase, clean, install dependencies, or run any command that changes files or git state. Use read-only commands only.

Plan artifacts are not part of the implementation commit and should be ignored: ${args.planArtifacts.join(", ")}
${anchored}${deferred}${anchoredContext}
## Staged Diff

\`\`\`diff
${args.diff}
\`\`\`

${PAPERCUT_GUIDANCE}

${resultProtocol}

Submit the typed integration review result through the injected completion tool as your final action.`;
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
- If you modify repair files but cannot stage them, list every modified path in filesChanged so the orchestrator can stage exactly those declared repair files.

You must NOT:
- Implement future plan tasks.
- Edit source plan or checklist artifacts.
- Push, rebase, rewrite unrelated history, or bypass validation.
- Commit or change HEAD.
- Hide uncertainty.

## Repair Result

Submit the self-heal result through the injected completion tool as your final action.

\`retryMode\` must be one of:
- \`continue_candidate\`: the current checkout/index contains the repaired integration candidate. The orchestrator will proceed to snapshot and validation.
- \`retry_cherry_pick\`: the agent cleaned/aborted/reset the interrupted candidate and the orchestrator should rerun \`git cherry-pick --no-commit <taskCommitSha>\` from the pre-integration HEAD.
- \`retry_validation\`: the candidate is already applied and only validation should be rerun, usually after environment repair such as dependency installation.

If you cannot repair the issue, set \`repaired: false\` and \`retryIntegration: false\`, and provide a clear \`remainingBlocker\`.

${PAPERCUT_GUIDANCE}
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

Submit the self-heal result through the injected completion tool as your final action.

If you cannot repair the issue, set \`repaired: false\` and \`retryScheduler: false\`, and provide a clear \`remainingBlocker\`.

${PAPERCUT_GUIDANCE}
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

Per-task reviewers may have approved simple tasks after bounded triage; this overall pass remains responsible for whole-feature integration and missed original-plan requirements.

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

- Start from the plan and combined diff. Inspect unchanged code only when needed to establish a changed path's integration impact; do not turn the review into a general repository audit.
- Keep exploration proportional to the feature and its risk. Prefer targeted reads and searches, and use broad exploration only for a specific unresolved cross-task question.
- Approve if the feature is complete, correct, and the tasks integrate well.
- Request changes if there are material gaps, missed edge cases, integration problems, or insufficient verification.
- Be specific about what must change and keep it to the minimum observable correction. In particular, check for planner/compiler omissions: requirements in the original plan that may have been missed because no compiled task contract covered them.

${PAPERCUT_GUIDANCE}

Submit the overall review verdict through the injected completion tool as your final action. For requested changes, include concrete follow-up changes and optional concise recovery guidance.
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
  findings: ReviewFinding[];
  worktreePath?: string;
  recommendationMarkdown?: string;
  priorAttemptFailures?: string[];
  executionManifest?: ExecutionManifest;
  findingCompletions?: Array<{
    id: string;
    sourceScope: "task_review" | "integration_fallback";
    summary: string;
    evidence: string;
    requiredChange: string;
    acceptanceCriteria: string[];
    basis?: unknown;
  }>;
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
  const requiredChanges = args.findings.map(
    (finding) =>
      `${finding.id}: ${finding.summary}\n  Evidence: ${finding.evidence}\n  Required change: ${finding.requiredChange}\n  Acceptance: ${finding.acceptanceCriteria.join("; ")}`,
  );
  const recommendationSection = args.recommendationMarkdown
    ? `\n## Recommendation\n\n${args.recommendationMarkdown}\n`
    : "";
  const manifestSection = formatExecutionManifestSummary(
    args.executionManifest,
  );
  const reworkProtocol = args.findingCompletions?.length
    ? `\n## Rework Completion Protocol\n\nReturn findingCompletions with every supplied ID exactly once as addressed or not_addressed. Each completion requires concrete evidence, changedPaths, and finding-level verification. An addressed completion with no changed paths must explain why no source change was necessary. Declarations are anchored-review evidence, not self-resolution.\n\n${args.findingCompletions.map((finding) => `- ${finding.id} [${finding.sourceScope}]\n  Demonstrated defect: ${finding.evidence}\n  Requirement / acceptance basis: ${finding.acceptanceCriteria.join("; ")}\n  Requirement reference: ${JSON.stringify(finding.basis ?? "not recorded")}\n  Minimum observable correction: ${finding.requiredChange}`).join("\n")}`
    : "";

  return `You are the pi-implement overall rework implementer. Your job is to address the overall review feedback for the completed feature.

Run non-interactively. No human will see your intermediate messages or answer questions. Never ask for clarification, never ask how to proceed, and never wait for input. Make reasonable decisions yourself and finish with the result block.

## Scope

Make only the changes required to satisfy the overall review feedback and the original plan. Do not reopen completed tasks for unrelated improvements or scope creep.

## Constraints

Work only in the assigned overall candidate worktree${args.worktreePath ? `:\n\n  ${args.worktreePath}` : ""}. Do not edit source plan files or checklist state. Do not stage, commit, reset, checkout, rebase, merge, tag, push, clean, or force-add ignored files.

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

${requiredChanges.map((c) => `- ${c}`).join("\n")}
${reworkProtocol}${recommendationSection}${priorFailuresSection}
${PAPERCUT_GUIDANCE}

Submit the overall rework result through the injected completion tool as your final action.

The commitMessage is optional; if omitted or invalid, a fallback will be used.
`;
}

export function buildInitialTaskReviewPrompt(args: {
  compiledContract: string;
  worktreePath: string;
  candidateContext: string;
  responsibilityContext?: ReviewResponsibilityContext;
  selectedTaskId?: string;
}): string {
  return buildInitialReviewPrompt({
    scope: "task",
    compiledContract: args.compiledContract,
    worktreePath: args.worktreePath,
    candidateContext: args.candidateContext,
    responsibilityContext: args.responsibilityContext,
    selectedTaskId: args.selectedTaskId,
  });
}

export const FINDING_ADMISSION_SYSTEM_PROMPT = `You classify only the supplied review proposals. Do not inspect the repository, use tools, discover findings, rewrite proposals, choose an implementation design, or reject a proposal when uncertain. Return exactly one disposition for each supplied proposal ID and echo the supplied proposalBatchId. Mark uncertainty explicitly as uncertain.`;

export function buildFindingAdmissionPrompt(args: {
  scope: "task" | "overall" | "integration";
  compiledContract: string;
  requirementIds: Array<{ id: string; text: string }>;
  candidateIdentity: string;
  latestDeltaPaths: readonly string[];
  proposalBatchId: string;
  proposals: readonly {
    proposalId: string;
    summary: string;
    evidence: string;
    requiredChange: string;
    acceptanceCriteria: string[];
    basis: unknown;
  }[];
  responsibilityContext?: ReviewResponsibilityContext;
  selectedTaskId?: string;
}): string {
  return `Classify the supplied ${args.scope}-review proposals against the supplied evidence only. Return the exact proposalBatchId and one certain or uncertain disposition (admit, defer, demote, or reject) for every proposal. Do not add proposals. If uncertain, use certainty: uncertain; uncertainty is never a reason to reject.${args.scope === "overall" ? " Overall concerns cannot be deferred; use admit instead." : ""}

## Proposal Batch

proposalBatchId: ${args.proposalBatchId}
Candidate identity: ${args.candidateIdentity}
Latest delta paths: ${args.latestDeltaPaths.join(", ") || "none"}

## Contract

${args.compiledContract}

## Requirement IDs

${args.requirementIds.map((requirement) => `- ${requirement.id}: ${requirement.text}`).join("\n") || "No stable requirement IDs are available; classify only against supplied invariants and candidate regressions."}

${args.responsibilityContext ? `## Responsibility Context\n\n${buildResponsibilitySection({ responsibilityContext: args.responsibilityContext, selectedTaskId: args.selectedTaskId })}\n` : ""}
## Proposals

${args.proposals.map((proposal) => `### ${proposal.proposalId}\nSummary: ${proposal.summary}\nEvidence: ${proposal.evidence}\nRequired change: ${proposal.requiredChange}\nAcceptance: ${proposal.acceptanceCriteria.join("; ")}\nBasis: ${JSON.stringify(proposal.basis)}`).join("\n\n")}`;
}

export function buildTaskFindingAdmissionPrompt(args: {
  compiledContract: string;
  responsibilityContext: ReviewResponsibilityContext;
  selectedTaskId: string;
  candidateIdentity: string;
  latestDeltaPaths: readonly string[];
  proposalBatchId: string;
  proposals: readonly {
    proposalId: string;
    summary: string;
    evidence: string;
    requiredChange: string;
    acceptanceCriteria: string[];
    basis: unknown;
  }[];
}): string {
  return buildFindingAdmissionPrompt({
    scope: "task",
    compiledContract: args.compiledContract,
    requirementIds: args.responsibilityContext.requirements.filter(
      (requirement) => requirement.taskId === args.selectedTaskId,
    ),
    candidateIdentity: args.candidateIdentity,
    latestDeltaPaths: args.latestDeltaPaths,
    proposalBatchId: args.proposalBatchId,
    proposals: args.proposals,
    responsibilityContext: args.responsibilityContext,
    selectedTaskId: args.selectedTaskId,
  });
}

export function buildAnchoredTaskReviewPrompt(args: {
  compiledContract: string;
  worktreePath: string;
  candidateContext: string;
  outstandingFindings: ReviewFinding[];
  previousCandidate: string;
  currentCandidate: string;
  latestDelta: string;
  reworkCompletions?: Array<{
    id: string;
    status: "addressed" | "not_addressed";
    evidence: string;
    changedPaths: string[];
    verification: Array<{ command: string; result: string; rationale: string }>;
  }>;
  responsibilityContext?: ReviewResponsibilityContext;
  selectedTaskId?: string;
}): string {
  return buildAnchoredReviewPrompt({ scope: "task", ...args });
}

export function buildInitialOverallReviewPrompt(args: {
  planContext: string;
  candidateContext: string;
  worktreePath?: string;
  deferredConcerns?: Array<{
    id: string;
    summary: string;
    evidence: string;
    basis: unknown;
    sourceScope?: string;
    sourceCandidate?: string;
    rationale?: string;
  }>;
}): string {
  return `${buildInitialReviewPrompt({
    scope: "overall",
    compiledContract: args.planContext,
    worktreePath: args.worktreePath ?? "the main checkout",
    candidateContext: args.candidateContext,
  })}

${args.deferredConcerns?.length ? `## Deferred Concerns to Assess\n\nThese are advisory leads, not blockers by themselves. Assess every supplied ID exactly once as not_reproducible, covered_by_proposal (link a proposal from this completion), or observed_non_blocking.\n\n${args.deferredConcerns.map((concern) => `- ${concern.id} [${concern.sourceScope ?? "task"}]${concern.sourceCandidate ? ` @ ${concern.sourceCandidate}` : ""}: ${concern.summary}\n  Evidence: ${concern.evidence}\n  Rationale: ${concern.rationale ?? "Deferred for whole-feature review."}`).join("\n")}` : ""}

Review the complete feature against the original human plan, corpus, execution manifest, landed tasks, and full feature diff. This is review only: do not edit files, change Git state, install dependencies, or run write-producing commands.`;
}

export function buildAnchoredOverallReviewPrompt(args: {
  planContext: string;
  candidateContext: string;
  outstandingFindings: ReviewFinding[];
  previousCandidate: string;
  currentCandidate: string;
  latestDelta: string;
  reworkCompletions?: Array<{
    id: string;
    status: "addressed" | "not_addressed";
    evidence: string;
    changedPaths: string[];
    verification: Array<{ command: string; result: string; rationale: string }>;
  }>;
  worktreePath?: string;
}): string {
  return `${buildAnchoredReviewPrompt({
    scope: "overall",
    compiledContract: args.planContext,
    worktreePath: args.worktreePath ?? "the main checkout",
    ...args,
  })}

The full-feature context represents the landed run plus the cumulative overall candidate. Review only: do not edit files, change Git state, install dependencies, or run write-producing commands.`;
}

function buildInitialReviewPrompt(args: {
  scope: "task" | "overall";
  compiledContract: string;
  worktreePath: string;
  candidateContext: string;
  responsibilityContext?: ReviewResponsibilityContext;
  selectedTaskId?: string;
}): string {
  const recommendation =
    args.scope === "overall"
      ? " You may include advisory recommendationMarkdown, which never controls approval."
      : "";
  return `You are conducting an initial ${args.scope} review in ${args.worktreePath}. This is a complete review: return the full known blocking set, with no arbitrary finding limit.

## Compiled Task Contract

${args.compiledContract}

## Candidate Context

${args.candidateContext}

## Task Packet Fidelity

Use the compiled task contract and referenced source material below to verify scope and exact-source fidelity.

## Scope Review Rules

- Start from the supplied contract and candidate delta. Review every changed behavior, but inspect unchanged code only when needed to establish the impact of a changed path.
- Keep review effort proportional to the candidate and its risk. A complete blocking set means the complete set within the candidate, its contract, and directly affected interfaces—not a general audit of the surrounding subsystem or repository.
- Prefer targeted reads and searches. Use broad exploration only for a specific unresolved cross-file question, not to build a general repository map or duplicate supplied context.
- Small prerequisite changes needed for the selected task may be approved.
- Request changes if the staged diff substantially implements an unselected sibling task or unrelated cleanup.
- Completing a sibling task's own deliverable is scope creep.
${args.scope === "task" ? buildResponsibilitySection(args) : ""}
If approved, submit { verdict: "approved" }. Otherwise submit { verdict: "changes_requested", findings } where every atomic finding is a proposal with summary, evidence, requiredChange, non-empty acceptanceCriteria, and basis. basis must be either { kind: "requirement", requirementIds }, { kind: "candidate_regression", changedPaths, causalEvidence }, or { kind: "correctness_invariant", invariant }. Requirement IDs must come from the supplied contract. One independently resolvable defect belongs in each proposal. Keep the required change and acceptance criteria to the minimum observable correction needed for the demonstrated defect; do not prescribe a broader redesign when a narrower correction satisfies the contract. Omit optional or non-blocking concerns from this initial result.${recommendation}

${PAPERCUT_GUIDANCE}

Submit the review verdict through the injected completion tool as your final action.`;
}

function buildAnchoredReviewPrompt(args: {
  scope: "task" | "overall";
  compiledContract: string;
  worktreePath: string;
  candidateContext: string;
  outstandingFindings: ReviewFinding[];
  previousCandidate: string;
  currentCandidate: string;
  latestDelta: string;
  reworkCompletions?: Array<{
    id: string;
    status: "addressed" | "not_addressed";
    evidence: string;
    changedPaths: string[];
    verification: Array<{ command: string; result: string; rationale: string }>;
  }>;
  responsibilityContext?: ReviewResponsibilityContext;
  selectedTaskId?: string;
}): string {
  return `You are conducting an anchored ${args.scope} re-review in ${args.worktreePath}. Assess every supplied finding ID exactly once. Do not report ordinary new findings during re-review.

## Review Mode: Anchored Re-review

## Contract Context

${args.compiledContract}

${args.scope === "task" ? buildResponsibilitySection(args) : ""}

## Candidate Context

Previous candidate: ${args.previousCandidate}
Current candidate: ${args.currentCandidate}

${args.candidateContext}

${args.reworkCompletions?.length ? `## Implementer Rework Declarations\n\n${args.reworkCompletions.map((completion) => `- ${completion.id}: ${completion.status}\n  Evidence: ${completion.evidence}\n  Changed paths: ${completion.changedPaths.join(", ") || "none"}\n  Verification: ${completion.verification.map((step) => `${step.command}: ${step.result}`).join("; ") || "none"}`).join("\n")}` : "## Implementer Rework Declarations\n\nNo rework declarations were supplied."}

## Prior Required Changes

${formatFindings(args.outstandingFindings)}

## Latest Rework Delta

${args.latestDelta}

Review the latest delta and only the unchanged code needed to assess the supplied findings. Do not re-review the complete candidate, broaden the original findings, or reopen unrelated design questions. Mark a finding unresolved only with current-candidate evidence that a specific acceptance criterion remains unmet. Judge the demonstrated defect and observable acceptance criteria; an equivalent correct implementation resolves the finding even when it differs from the suggested required change.

Submit assessments with each known ID exactly once and status resolved or unresolved plus evidence. You may add regressions only when the latest delta caused them: each regression must include changedPaths that intersect the latest delta and causalEvidence explaining causality. Put all other concerns in observations; observations never block. A resolved ID cannot be reopened. Do not impose a finding cap.

${PAPERCUT_GUIDANCE}`;
}

function formatFindings(findings: ReviewFinding[]): string {
  return findings
    .map(
      (finding) =>
        `### ${finding.id}: ${finding.summary}\nEvidence: ${finding.evidence}\nRequired change: ${finding.requiredChange}\nAcceptance criteria:\n${finding.acceptanceCriteria.map((criterion) => `- ${criterion}`).join("\n")}`,
    )
    .join("\n\n");
}
