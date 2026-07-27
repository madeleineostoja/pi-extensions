import type { RecoveryWorkerPacket } from "./recovery-packet.js";
import type { WorkstreamPacket } from "./workstream-candidate.js";
import type {
  AnchoredSourceReviewPacket,
  InitialSourceReviewPacket,
} from "./review.js";

export type WorkstreamImplementerPromptTask = {
  id: string;
  title: string;
  objective: string;
  inScope: string[];
  acceptanceCriteria: string[];
  outOfScope: string[];
  provenance: Array<{ path: string; quote: string }>;
  implementationNotes?: string;
  verificationGuidance?: string;
};

type Finding = {
  id: string;
  summary: string;
  evidence: string;
  requiredChange: string;
  acceptanceCriteria: string[];
};

export function buildWorkstreamImplementerPrompt(
  packet: WorkstreamPacket,
): string {
  const tasks = packet.tasks
    .map(
      (task, index) =>
        `### ${index + 1}. ${task.id}: ${task.title}\n\nObjective: ${task.compiledContract.objective}\n\nIn scope:\n${task.compiledContract.inScope.map((item) => `- ${item}`).join("\n")}\n\nAcceptance criteria:\n${task.compiledContract.acceptanceCriteria.map((item) => `- ${item}`).join("\n")}\n\nOut of scope:\n${task.compiledContract.outOfScope.map((item) => `- ${item}`).join("\n")}\n\nEmbedded provenance:\n${task.provenance.map((reference) => `- ${reference.path}: ${reference.quote}`).join("\n")}${task.compiledContract.implementationNotes ? `\n\nImplementation notes: ${task.compiledContract.implementationNotes}` : ""}${task.compiledContract.verificationGuidance ? `\n\nVerification guidance: ${task.compiledContract.verificationGuidance}` : ""}`,
    )
    .join("\n\n");
  const material = packet.sourceMaterial
    .map(({ path, content }) => `### ${path}\n\n${content}`)
    .join("\n\n");
  const prior = Object.entries(packet.priorCheckpoints)
    .map(([taskId, checkpoint]) => `- ${taskId}: ${checkpoint}`)
    .join("\n");
  const obligations = packet.recoveryObligations.length
    ? packet.recoveryObligations.map((item) => `- ${item}`).join("\n")
    : "- Preserve and build on every committed checkpoint listed below.";
  return `You are the Pipkin Implement implementer for one ordered workstream. Work only in this assigned Git worktree:\n\n  ${packet.workspace.path}\n\n${packet.workspace.mutationBoundary}\n\nImplement every ordered task contract as one coherent invocation. Satisfy the contracts with the smallest coherent change that fits the repository's existing architecture. Inspect relevant nearby code and available project or ecosystem capabilities before adding custom mechanisms. Do not add speculative flexibility, compatibility, configuration, or adjacent cleanup. Commit valuable progress as you complete each task. Later correction commits may change earlier task work. Your candidate must descend from base ${packet.baseSha}. Do not modify source plan or other protected artifacts.\n\n## Prior committed checkpoints\n\n${prior || "None."}\n\n## Recovery obligations\n\n${obligations}\n\n## Ordered task contracts\n\n${tasks}\n\n## Selected immutable source material\n\n${material || "No additional material was selected."}\n\nBefore completion, inspect the cumulative base-to-tip diff and remove abandoned helpers, redundant guards, duplicate tests, temporary compatibility paths, and other implementation residue not needed for the contracts, while preserving required behavior and risk controls.

Submit the typed completion as your final action. For every task return exactly one taskCompletions entry: use kind \`checkpoint\` with the reachable commit SHA that covers it, or kind \`already_satisfied\` with concrete repository-state evidence. If any tracked work changed, return outcome \`changed\` and candidateTip equal to the final committed HEAD. If all tasks were already satisfied, return outcome \`already_satisfied\` and omit candidateTip. Include verification evidence and uncertainty when applicable.`;
}

export function buildInitialWorkstreamReviewPrompt(
  packet: InitialSourceReviewPacket,
): string {
  const repositoryContext = packet.repositoryState
    ? `\nRepository-state assessment:\nHistorical satisfaction base: ${packet.repositoryState.historicalBaseSha}\nAssessed target: ${packet.repositoryState.assessedTargetSha}\nPrior review evidence: ${JSON.stringify(packet.repositoryState.priorReviewEvidence)}`
    : "";
  return `You are the independent reviewer for one cumulative Pipkin Implement workstream. Review read-only in this assigned candidate worktree:\n\n  ${packet.workspace.path}\n\nCandidate: ${packet.candidate.id}\nBase: ${packet.candidate.baseSha}\nTip: ${packet.candidate.commitSha}\nTree: ${packet.candidate.treeSha}${repositoryContext}\n\nReview every ordered contract as one cumulative candidate. The task checkpoints, already-satisfied claims, implementation verification, and uncertainty are evidence to assess, not proof of correctness. For an already-satisfied claim, inspect repository state even though the candidate diff is empty. Do not edit files, change Git state, install dependencies, or run write-producing commands.\n\n## Ordered contracts\n\n${packet.contracts.map((task, index) => `### ${index + 1}. ${task.id}: ${task.title}\nObjective: ${task.compiledContract.objective}\nIn scope: ${task.compiledContract.inScope.join("; ")}\nAcceptance: ${task.compiledContract.acceptanceCriteria.join("; ")}\nOut of scope: ${task.compiledContract.outOfScope.join("; ")}`).join("\n\n")}\n\n## Source material\n\n${packet.sourceMaterial.map((material) => `### ${material.path}\n\n${material.content}`).join("\n\n") || "No additional source material."}\n\n## Task evidence\n\nCheckpoints: ${JSON.stringify(packet.checkpoints)}\nAlready-satisfied evidence: ${JSON.stringify(packet.satisfiedEvidence)}\nVerification: ${JSON.stringify(packet.verificationEvidence?.verification ?? [])}\nUncertainty: ${packet.uncertainty ?? "none"}\n\n## Cumulative base-to-tip diff\n\n\`\`\`diff\n${packet.baseToTipDiff}\n\`\`\`\n\nReturn approved only when the cumulative candidate satisfies every contract. Otherwise return the complete known set of material blocking findings directly. Each finding must state current evidence, the minimum observable correction, and concrete acceptance criteria. An economy finding must identify an unnecessary construct, a concrete sufficient replacement, the behavior and risk controls it preserves, and meaningful maintenance burden. Omit minor, uncertain, or non-material simplifications from this typed result. Exclude style nits, speculative improvements, unrelated audits, and broader redesigns when a narrow correction satisfies the contract.`;
}

export function buildAnchoredWorkstreamReviewPrompt(
  packet: AnchoredSourceReviewPacket,
): string {
  return `You are the independent reviewer for an anchored Pipkin Implement workstream re-review. Review read-only in:\n\n  ${packet.workspace.path}\n\nPrevious candidate: ${packet.previousCandidate.id} @ ${packet.previousCandidate.commitSha}\nCurrent candidate: ${packet.candidate.id} @ ${packet.candidate.commitSha}\nChanged paths: ${packet.latestCorrection.changedPaths.join(", ") || "none"}\nCorrection evidence: ${packet.latestCorrection.evidence}\nCurrent verification: ${JSON.stringify(packet.verificationEvidence?.verification ?? [])}\nCurrent uncertainty: ${packet.uncertainty ?? "none"}\n\nAssess every outstanding ID exactly once against the current candidate and the latest correction delta. Do not re-review the complete candidate. A resolved ID cannot reopen. Add a new blocking regression only when this exact latest delta caused it and list a changed path from the latest delta. Put every other concern in observations; observations never block. Do not edit files, change Git state, install dependencies, or run write-producing commands.\n\n## Ordered contracts\n\n${packet.contracts.map((task, index) => `### ${index + 1}. ${task.id}: ${task.title}\nObjective: ${task.compiledContract.objective}\nAcceptance: ${task.compiledContract.acceptanceCriteria.join("; ")}`).join("\n\n")}\n\n## Embedded source material\n\n${packet.sourceMaterial.map((material) => `### ${material.path}\n\n${material.content}`).join("\n\n") || "No additional source material."}\n\n## Outstanding findings\n\n${formatFindings(packet.outstandingFindings)}\n\n## Latest correction delta\n\n\`\`\`diff\n${packet.baseToTipDiff}\n\`\`\`\n\nReturn one resolved or unresolved assessment for each supplied ID, direct causal regressions only, and optional observations.`;
}

export function buildInitialOverallReviewPrompt(args: {
  planContext: string;
  candidateContext: string;
  worktreePath?: string;
}): string {
  return `You are the independent whole-plan reviewer for a completed Pipkin Implement run. Review read-only in ${args.worktreePath ?? "the target checkout"}.\n\nAssess the complete immutable source corpus and execution plan against the published target diff. Do not edit files, change Git state, install dependencies, or run write-producing commands.\n\n## Immutable plan and corpus\n\n${args.planContext}\n\n## Published candidate context\n\n${args.candidateContext}\n\nReturn approved only when the complete run is correct and satisfies the source corpus. Otherwise return the complete known set of direct material blocking findings. Each finding needs current evidence, the minimum observable correction, and concrete acceptance criteria. An economy finding must identify an unnecessary construct, a concrete sufficient replacement, the behavior and risk controls it preserves, and meaningful maintenance burden. Omit minor, uncertain, or non-material simplifications from this typed result. Check for materially burdensome duplicate mechanisms introduced independently across workstreams, but do not redesign a valid architecture merely for uniformity. Exclude style nits, speculative improvements, unrelated audits, and broader redesigns when a narrow correction satisfies the plan.`;
}

export function buildOverallReworkPrompt(args: {
  planContent: string;
  planPath: string;
  baseSha: string;
  headSha: string;
  diff: string;
  runId?: string;
  findings: Finding[];
  worktreePath?: string;
}): string {
  return `You are the Pipkin Implement overall repair implementer. Address only the supplied whole-plan review findings in this assigned worktree:\n\n  ${args.worktreePath ?? "(not provided)"}\n\nDo not access or mutate the target checkout, source plan, or checkbox state. You may repair the candidate, run appropriate checks, and commit tracked changes. Leave no active Git operation or uncommitted work.\n\nSource: ${args.planPath}\nRun: ${args.runId ?? "unknown"}\nBaseline: ${args.baseSha}\nCandidate: ${args.headSha}\n\n## Immutable execution plan\n\n${args.planContent}\n\n## Existing run diff\n\n\`\`\`diff\n${args.diff}\n\`\`\`\n\n## Required corrections\n\n${formatFindings(args.findings)}\n\nSubmit the typed completion with a concise summary and verification evidence. The commitMessage is optional.`;
}

export function buildAnchoredOverallReviewPrompt(args: {
  planContext: string;
  candidateContext: string;
  outstandingFindings: Finding[];
  previousCandidate: string;
  currentCandidate: string;
  latestDelta: string;
  worktreePath?: string;
}): string {
  return `You are the independent reviewer for an anchored whole-plan repair. Review read-only in ${args.worktreePath ?? "the repair worktree"}.\n\nPlan context:\n${args.planContext}\n\nCandidate context:\n${args.candidateContext}\n\nPrevious candidate: ${args.previousCandidate}\nCurrent candidate: ${args.currentCandidate}\n\nAssess every outstanding finding exactly once against the current candidate and latest correction delta. Do not re-review the complete candidate. A resolved finding cannot reopen. Add a blocking regression only when the latest delta caused it; place every other concern in observations.\n\n## Outstanding findings\n\n${formatFindings(args.outstandingFindings)}\n\n## Latest correction delta\n\n\`\`\`diff\n${args.latestDelta}\n\`\`\`\n\nDo not edit files, change Git state, install dependencies, or run write-producing commands.`;
}

export function buildRecoveryPrompt(packet: RecoveryWorkerPacket): string {
  const provenance = packet.gate.artifactProvenance
    ? `\n\n## Retained artifact provenance\n\nThis provenance is for operator diagnostics only. It is not readable from the assigned workspace; do not open or rely on it.\n\n${JSON.stringify(packet.gate.artifactProvenance, null, 2)}`
    : "";
  return `You are the Pipkin Implement recovery agent. Recover only the validated failure packet below.\n\nRuntime repair workspace:\n\n  ${packet.workspace.path}\n\nTracked correction worktree:\n\n  ${packet.workspace.correctionPath}\n\nThe target checkout and immutable source corpus are orchestrator-owned. Do not access or mutate them. Inspect and repair ignored/runtime state only in the runtime repair workspace. Make tracked changes only when necessary to correct the retained candidate or reconciliation failure, and commit them only in the tracked correction worktree before reporting them. Do not push, rewrite history, bypass hooks, change protected plan artifacts, or leave an active Git operation or uncommitted work.\n\nTarget identity: ${packet.target.branchRef} @ ${packet.target.startHead}\nPermitted mutation boundary: ${packet.workspace.mutationBoundary}\nCurrent candidate: ${JSON.stringify(packet.candidate ?? null, null, 2)}\n\n## Failed gate evidence\n\n${JSON.stringify(packet.gate, null, 2)}\n\n## Recovery episode\n\n${JSON.stringify(packet.episode, null, 2)}\n\n## Complete outstanding findings\n\n${formatFindings(packet.outstandingFindings)}${provenance}\n\nChoose exactly one typed action. Use \`retry\` only when the retained candidate/workspace identity is unchanged and the failed lifecycle gate can be rerun. Use \`repair_environment\` for ignored or runtime repair in the runtime repair workspace. Use \`recreate_workspace\` only when a trusted checkpoint is retained. Use \`rework_candidate\` or \`reconcile\` only after committing a tracked correction in the tracked correction worktree; include candidateTip and the changed paths. Use \`diagnose\` only to retain a bounded diagnosis before another recovery turn. Use \`no_safe_action\` when no safe bounded action exists. Include concrete evidence for every action.`;
}

function formatFindings(findings: Finding[]): string {
  return findings
    .map(
      (finding) =>
        `### ${finding.id}: ${finding.summary}\nEvidence: ${finding.evidence}\nRequired change: ${finding.requiredChange}\nAcceptance criteria:\n${finding.acceptanceCriteria.map((criterion) => `- ${criterion}`).join("\n")}`,
    )
    .join("\n\n");
}
