import type { OverallRepairPacket } from "./overall-repair.js";
import type { RevisionPacket } from "./revision.js";
import type { WorkstreamPacket } from "./workstream-candidate.js";
import type {
  AnchoredSourceReviewPacket,
  InitialSourceReviewPacket,
} from "./review.js";

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
        `### ${index + 1}. ${task.id}: ${task.title}\n\nObjective: ${task.compiledContract.objective}\n\nIn scope:\n${task.compiledContract.inScope.map((item) => `- ${item}`).join("\n")}\n\nAcceptance criteria:\n${task.compiledContract.acceptanceCriteria.map((item) => `- ${item}`).join("\n")}\n\nOut of scope:\n${task.compiledContract.outOfScope.map((item) => `- ${item}`).join("\n")}${task.supportingDocuments?.length ? `\n\nSupporting requirement documents:\n${task.supportingDocuments.map((path) => `- ${path}`).join("\n")}` : ""}${task.compiledContract.implementationNotes ? `\n\nImplementation notes: ${task.compiledContract.implementationNotes}` : ""}${task.compiledContract.verificationGuidance ? `\n\nVerification guidance: ${task.compiledContract.verificationGuidance}` : ""}`,
    )
    .join("\n\n");
  const material = packet.sourceMaterial
    .map(({ path, content }) => `### ${path}\n\n${content}`)
    .join("\n\n");
  const prior = Object.entries(packet.priorCheckpoints)
    .map(([taskId, checkpoint]) => `- ${taskId}: ${checkpoint}`)
    .join("\n");
  const comparison = `git diff --stat ${packet.baseSha}..HEAD and git diff --name-status ${packet.baseSha}..HEAD, then inspect scoped per-file diffs with git diff ${packet.baseSha}..HEAD -- <path>`;
  return `You are the Pipkin Implement implementer for one ordered workstream. Work only in this assigned Git worktree:\n\n  ${packet.workspace.path}\n\n${packet.workspace.mutationBoundary}\n\nImplement every ordered task contract as one coherent invocation. Start by running ${comparison}; do not dump the full range into context. Satisfy the contracts with the smallest coherent change that fits the repository's existing architecture. Inspect relevant nearby code and available project or ecosystem capabilities before adding custom mechanisms. Do not add speculative flexibility, compatibility, configuration, or adjacent cleanup. Prefer a checkpoint after a task only when it leaves the workstream coherent; tightly coupled tasks may share one checkpoint, and never manufacture administrative commits. Later correction commits may change earlier task work. Your candidate must descend from base ${packet.baseSha} and remain coherent and safe to publish, even when a dependent workstream will consume its contract. Do not modify source plan or other protected artifacts.\n\n## Prior committed checkpoints\n\n${prior || "None."}\n\n## Ordered task contracts\n\n${tasks}\n\n## Task source material\n\n${material}\n\nBefore completion, inspect the scoped cumulative changes and remove abandoned helpers, redundant guards, duplicate tests, temporary compatibility paths, and other implementation residue not needed for the contracts, while preserving required behavior and risk controls.

Submit the typed completion as your final action. Return outcome \`changed\` only when you have left a committed candidate that changes the workstream tree. Return outcome \`already_satisfied\` only when every contract was already satisfied and you made no commits; include concrete repository-state evidence for that outcome. Include at least one concise verification statement describing what you checked and the outcome. Verification may use tests, static analysis, direct inspection, or other appropriate evidence; it does not require a shell command. Include uncertainty when applicable.`;
}

export function buildInitialWorkstreamReviewPrompt(
  packet: InitialSourceReviewPacket,
): string {
  const comparisonBase =
    packet.repositoryState?.historicalBaseSha ?? packet.candidate.baseSha;
  const comparisonCurrent =
    packet.repositoryState?.assessedTargetSha ?? packet.candidate.commitSha;
  const repositoryContext = packet.repositoryState
    ? `\nRepository-state assessment:\nHistorical base SHA: ${packet.repositoryState.historicalBaseSha}\nAssessed current SHA: ${packet.repositoryState.assessedTargetSha}\nPrior review evidence: ${JSON.stringify(packet.repositoryState.priorReviewEvidence)}`
    : "";
  const publicationSubject =
    packet.completionKind === "initial-review"
      ? "After completing the cumulative review, author one concise Conventional Commit subject for the complete workstream. It is publication metadata, not approval: provide it whether you approve or request changes. Do not use or inspect checkpoint or correction subjects. "
      : "";
  return `You are the independent reviewer for one cumulative Pipkin Implement workstream. Review read-only in this assigned candidate worktree:\n\n  ${packet.workspace.path}\n\nCandidate: ${packet.candidate.id}\nBase SHA: ${packet.candidate.baseSha}\nCurrent SHA: ${packet.candidate.commitSha}\nTree: ${packet.candidate.treeSha}${repositoryContext}\n\nStart by running git diff --stat ${comparisonBase}..${comparisonCurrent} and git diff --name-status ${comparisonBase}..${comparisonCurrent}, then inspect scoped per-file diffs with git diff ${comparisonBase}..${comparisonCurrent} -- <path>. Do not dump the full range into context. Review in two passes within this one invocation: first assess every ordered contract and acceptance criterion, then assess cumulative interactions, regressions, verification evidence, and unnecessary machinery. The task checkpoints, already-satisfied claims, implementation verification, and uncertainty are evidence to assess, not proof of correctness; do not require a task manifest or task-specific provenance gate. For an already-satisfied claim, inspect repository state even though the candidate diff is empty. Do not edit files, change Git state, install dependencies, or run write-producing commands.\n\n## Ordered contracts\n\n${packet.contracts.map((task, index) => `### ${index + 1}. ${task.id}: ${task.title}\nObjective: ${task.compiledContract.objective}\nIn scope: ${task.compiledContract.inScope.join("; ")}\nAcceptance: ${task.compiledContract.acceptanceCriteria.join("; ")}\nOut of scope: ${task.compiledContract.outOfScope.join("; ")}`).join("\n\n")}\n\n## Source material\n\n${packet.sourceMaterial.map((material) => `### ${material.path}\n\n${material.content}`).join("\n\n") || "No additional source material."}\n\n## Task evidence\n\nCheckpoints: ${JSON.stringify(packet.checkpoints)}\nAlready-satisfied evidence: ${JSON.stringify(packet.satisfiedEvidence)}\nVerification: ${JSON.stringify(packet.verificationEvidence?.verification ?? [])}\nUncertainty: ${packet.uncertainty ?? "none"}\n\n${publicationSubject}Return approved only when the cumulative candidate satisfies every contract. Otherwise return the complete known set of material blocking findings directly. Each finding must state current evidence, the minimum observable correction, and concrete acceptance criteria. An economy finding must identify an unnecessary construct, a concrete sufficient replacement, the behavior and risk controls it preserves, and meaningful maintenance burden. Omit minor, uncertain, or non-material simplifications from this typed result. Exclude style nits, speculative improvements, unrelated audits, and broader redesigns when a narrow correction satisfies the contract.`;
}

export function buildAnchoredWorkstreamReviewPrompt(
  packet: AnchoredSourceReviewPacket,
): string {
  return `You are the independent reviewer for an anchored Pipkin Implement workstream re-review. Review read-only in:\n\n  ${packet.workspace.path}\n\nBase SHA: ${packet.candidate.baseSha}\nPrevious candidate: ${packet.previousCandidate.id} @ ${packet.previousCandidate.commitSha}\nCurrent candidate: ${packet.candidate.id} @ ${packet.candidate.commitSha}\nChanged paths: ${packet.latestCorrection.changedPaths.join(", ") || "none"}\nCorrection evidence: ${packet.latestCorrection.evidence}\nCurrent verification: ${JSON.stringify(packet.verificationEvidence?.verification ?? [])}\nCurrent uncertainty: ${packet.uncertainty ?? "none"}\n\nStart by running git diff --stat ${packet.previousCandidate.commitSha}..${packet.candidate.commitSha} and git diff --name-status ${packet.previousCandidate.commitSha}..${packet.candidate.commitSha}, then inspect scoped per-file diffs with git diff ${packet.previousCandidate.commitSha}..${packet.candidate.commitSha} -- <path>. Do not dump the full range into context. Assess every outstanding ID exactly once against the current candidate and the latest correction delta. Do not re-review the complete candidate. A resolved ID cannot reopen. Add a new blocking regression only when this exact latest delta caused it and list a changed path from the latest delta. Put every other concern in observations; observations never block. Do not edit files, change Git state, install dependencies, or run write-producing commands.\n\n## Ordered contracts\n\n${packet.contracts.map((task, index) => `### ${index + 1}. ${task.id}: ${task.title}\nObjective: ${task.compiledContract.objective}\nAcceptance: ${task.compiledContract.acceptanceCriteria.join("; ")}`).join("\n\n")}\n\n## Embedded source material\n\n${packet.sourceMaterial.map((material) => `### ${material.path}\n\n${material.content}`).join("\n\n") || "No additional source material."}\n\n## Outstanding findings\n\n${formatFindings(packet.outstandingFindings)}\n\nReturn one resolved or unresolved assessment for each supplied ID, direct causal regressions only, and optional observations.`;
}

export function buildInitialOverallReviewPrompt(args: {
  planContext: string;
  candidateContext: string;
  baseSha: string;
  currentSha: string;
  worktreePath?: string;
}): string {
  return `You are the independent whole-plan reviewer for a completed Pipkin Implement run. Review read-only in ${args.worktreePath ?? "the target checkout"}.\n\nBase SHA: ${args.baseSha}\nCurrent SHA: ${args.currentSha}\n\nStart by running git diff --stat ${args.baseSha}..${args.currentSha} and git diff --name-status ${args.baseSha}..${args.currentSha}, then inspect scoped per-file diffs with git diff ${args.baseSha}..${args.currentSha} -- <path>. Do not dump the full range into context. Assess the complete immutable source corpus and execution plan against the published target changes. Do not edit files, change Git state, install dependencies, or run write-producing commands.\n\n## Immutable plan and corpus\n\n${args.planContext}\n\n## Published candidate context\n\n${args.candidateContext}\n\nReturn approved only when the complete run is correct and satisfies the source corpus. Otherwise return the complete known set of direct material blocking findings. Each finding needs current evidence, the minimum observable correction, and concrete acceptance criteria. An economy finding must identify an unnecessary construct, a concrete sufficient replacement, the behavior and risk controls it preserves, and meaningful maintenance burden. Omit minor, uncertain, or non-material simplifications from this typed result. Check for materially burdensome duplicate mechanisms introduced independently across workstreams, but do not redesign a valid architecture merely for uniformity. Exclude style nits, speculative improvements, unrelated audits, and broader redesigns when a narrow correction satisfies the plan.`;
}

export function buildOverallReworkPrompt(packet: OverallRepairPacket): string {
  return `You are the Pipkin Implement overall repair implementer. Address only the supplied whole-plan review findings in this assigned worktree:\n\n  ${packet.workspace.path}\n\n${packet.workspace.mutationBoundary}\n\nDo not access or mutate the target checkout, source plan, or checkbox state. The plan path and retained artifacts are orchestrator provenance, not required worker input. You may repair the candidate, run appropriate checks, and commit tracked changes. Leave no active Git operation or uncommitted work.\n\nRun: ${packet.runId}\nBase SHA: ${packet.runBaseSha}\nCurrent candidate SHA: ${packet.baseline.commitSha}\n\nStart by running git diff --stat ${packet.runBaseSha}..${packet.baseline.commitSha} and git diff --name-status ${packet.runBaseSha}..${packet.baseline.commitSha}, then inspect scoped per-file diffs with git diff ${packet.runBaseSha}..${packet.baseline.commitSha} -- <path>. Do not dump the full range into context.\n\n## Immutable execution plan\n\n${JSON.stringify(packet.plan, null, 2)}\n\n## Complete current required corrections\n\n${formatFindings(packet.findings)}\n\nSubmit the typed completion with a concise summary, optional uncertainty, and at least one concise verification statement describing what you checked and the outcome. Verification may use tests, static analysis, direct inspection, or other appropriate evidence; it does not require a shell command.`;
}

export function buildAnchoredOverallReviewPrompt(args: {
  planContext: string;
  candidateContext: string;
  baseSha: string;
  outstandingFindings: Finding[];
  previousCandidate: string;
  currentCandidate: string;
  worktreePath?: string;
  authorPublicationCommitSubject?: boolean;
}): string {
  const publicationSubject = args.authorPublicationCommitSubject
    ? " When returning the initial repair assessment, also author one concise Conventional Commit subject describing the complete repair delta. This is publication metadata, not an additional review pass."
    : "";
  return `You are the independent reviewer for an anchored whole-plan repair. Review read-only in ${args.worktreePath ?? "the repair worktree"}.\n\nBase SHA: ${args.baseSha}\nPrevious candidate SHA: ${args.previousCandidate}\nCurrent candidate SHA: ${args.currentCandidate}\n\nStart by running git diff --stat ${args.previousCandidate}..${args.currentCandidate} and git diff --name-status ${args.previousCandidate}..${args.currentCandidate}, then inspect scoped per-file diffs with git diff ${args.previousCandidate}..${args.currentCandidate} -- <path>. Do not dump the full range into context.\n\nPlan context:\n${args.planContext}\n\nCandidate context:\n${args.candidateContext}\n\nAssess every outstanding finding exactly once against the current candidate and latest correction delta. Do not re-review the complete candidate. A resolved finding cannot reopen. Add a blocking regression only when the latest delta caused it; place every other concern in observations.\n\n## Outstanding findings\n\n${formatFindings(args.outstandingFindings)}\n\nDo not edit files, change Git state, install dependencies, or run write-producing commands.${publicationSubject}`;
}

export function buildRevisionPrompt(packet: RevisionPacket): string {
  return `You are the Pipkin Implement revision worker for one exact reviewed candidate. Work only in this assigned Git worktree:\n\n  ${packet.workspace.path}\n\n${packet.workspace.mutationBoundary}\n\nThe scheduler fixed this assignment. Do not select a retry, workspace recreation, reconciliation phase, or repository-safety action. Do not access or mutate the target checkout, rewrite history, bypass hooks, modify protected source artifacts, or leave an active Git operation or uncommitted work. If the requirements cannot be met, report the typed semantic blockage in your summary and uncertainty without changing the candidate.\n\nCandidate: ${packet.candidate.id} @ ${packet.candidate.commitSha}\nComparison base: ${packet.comparisonBase}\nFinding epoch: ${packet.findingEpoch}\nOutstanding IDs: ${packet.outstandingFindingIds.join(", ") || "candidate-changing hook evidence"}\n\nStart by running git diff --stat ${packet.comparisonBase}..HEAD and git diff --name-status ${packet.comparisonBase}..HEAD, then inspect scoped per-file diffs with git diff ${packet.comparisonBase}..HEAD -- <path>. Do not dump the full range into context.\n\n## Required corrections\n\n${formatFindings(packet.findings) || "Apply the retained scheduler evidence to the candidate."}\n\n## Retained evidence\n\n${packet.evidence.map((evidence) => `- ${evidence}`).join("\n") || "None."}\n\nCommit any completed correction and return outcome \`changed\`. If the fixed requirements cannot be met without a candidate change, return outcome \`blocked\` with the retained evidence. Submit only typed semantic evidence; do not report commit IDs, checkpoints, or changed paths because the orchestrator observes those from Git.`;
}

function formatFindings(findings: Finding[]): string {
  return findings
    .map(
      (finding) =>
        `### ${finding.id}: ${finding.summary}\nEvidence: ${finding.evidence}\nRequired change: ${finding.requiredChange}\nAcceptance criteria:\n${finding.acceptanceCriteria.map((criterion) => `- ${criterion}`).join("\n")}`,
    )
    .join("\n\n");
}
