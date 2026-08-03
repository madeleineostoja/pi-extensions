import type { OverallRepairPacket } from "./overall-repair.js";
import type { ReconciliationPacket } from "./reconciliation.js";
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
  status?: "open" | "resolved";
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
  return `You are the independent reviewer for one cumulative Pipkin Implement workstream. Review read-only in this assigned candidate worktree:\n\n  ${packet.workspace.path}\n\nCandidate: ${packet.candidate.id}\nBase SHA: ${packet.candidate.baseSha}\nCurrent SHA: ${packet.candidate.commitSha}\nTree: ${packet.candidate.treeSha}${repositoryContext}\n\nStart by running git diff --stat ${comparisonBase}..${comparisonCurrent} and git diff --name-status ${comparisonBase}..${comparisonCurrent}, then inspect scoped per-file diffs with git diff ${comparisonBase}..${comparisonCurrent} -- <path>. Do not dump the full range into context. Review in two passes within this one invocation: first assess every ordered contract and acceptance criterion, then assess cumulative interactions, regressions, verification evidence, and unnecessary machinery. The task checkpoints, already-satisfied claims, implementation verification, and uncertainty are evidence to assess, not proof of correctness; do not require a task manifest or task-specific provenance gate. For an already-satisfied claim, inspect repository state even though the candidate diff is empty. Do not edit files, change Git state, install dependencies, or run write-producing commands.\n\n## Ordered contracts\n\n${packet.contracts.map((task, index) => `### ${index + 1}. ${task.id}: ${task.title}\nObjective: ${task.compiledContract.objective}\nIn scope: ${task.compiledContract.inScope.join("; ")}\nAcceptance: ${task.compiledContract.acceptanceCriteria.join("; ")}\nOut of scope: ${task.compiledContract.outOfScope.join("; ")}`).join("\n\n")}\n\n## Source material\n\n${packet.sourceMaterial.map((material) => `### ${material.path}\n\n${material.content}`).join("\n\n") || "No additional source material."}\n\n## Complete frozen source corpus\n\n${packet.corpus.map((material) => `### ${material.path}\n\n${material.content}`).join("\n\n")}\n\n## Execution schedule\n\n${JSON.stringify(packet.schedule, null, 2)}\n\nUse the complete frozen corpus and schedule as context for interpretation, dependency compatibility, and candidate-caused architectural effects.\n\n## Task evidence\n\nCheckpoints: ${JSON.stringify(packet.checkpoints)}\nAlready-satisfied evidence: ${JSON.stringify(packet.satisfiedEvidence)}\nVerification: ${JSON.stringify(packet.verificationEvidence?.verification ?? [])}\nUncertainty: ${packet.uncertainty ?? "none"}\n\n${publicationSubject}Return an empty findings array only when the cumulative candidate satisfies every contract. Otherwise return the complete known set of direct material findings. The scheduler gives every reported material finding one initial correction opportunity; do not return an approval verdict. Each finding must state current evidence, the minimum observable correction, and concrete acceptance criteria. An economy finding must identify an unnecessary construct, a concrete sufficient replacement, the behavior and risk controls it preserves, and meaningful maintenance burden. Omit minor, uncertain, or non-material simplifications from this typed result. Exclude style nits, speculative improvements, unrelated audits, and broader redesigns when a narrow correction satisfies the contract.`;
}

export function buildAnchoredWorkstreamReviewPrompt(
  packet: AnchoredSourceReviewPacket,
): string {
  const integrationBase = packet.comparisonBase!;
  const inspectionRangeHead = packet.candidate.commitSha;
  const correctionRangeBase = packet.latestCorrection.rangeBaseSha;
  const correctionRangeHead = packet.latestCorrection.rangeHeadSha;
  const publicationSubject = packet.publicationCommitSubject
    ? "Retain the supplied cumulative publication subject unchanged."
    : packet.latestCorrection.mode === "unchanged"
      ? "No publication subject is required for an unchanged correction."
      : "Author one concise Conventional Commit subject for the complete changed workstream. It is publication metadata, not approval: provide it whether assessments leave residual findings or none.";
  return `You are the independent reviewer for an anchored Pipkin Implement workstream re-review. Review read-only in:\n\n  ${packet.workspace.path}\n\nHistorical workstream base: ${packet.candidate.baseSha}\nIntegration base: ${integrationBase}
Correction range: ${correctionRangeBase}..${correctionRangeHead}\nPrevious candidate: ${packet.previousCandidate.id} @ ${packet.previousCandidate.commitSha}\nCurrent candidate: ${packet.candidate.id} @ ${packet.candidate.commitSha}\nCorrection mode: ${packet.latestCorrection.mode}\nCanonical correction paths: ${packet.latestCorrection.changedPaths.join(", ") || "none"}\nCorrection evidence: ${packet.latestCorrection.evidence}\nCorrection summary: ${packet.latestCorrection.summary ?? "none"}\nCorrection verification: ${JSON.stringify(packet.latestCorrection.verification ?? [])}\nCorrection uncertainty: ${packet.latestCorrection.uncertainty ?? "none"}\nCorrection artifact: ${packet.latestCorrection.artifactPath ?? "none"}\nFinding epoch: ${packet.findingEpoch}\nPrior review evidence: ${JSON.stringify(packet.priorReviewEvidence ?? [])}\nCurrent verification: ${JSON.stringify(packet.verificationEvidence?.verification ?? [])}\nCurrent evidence: ${JSON.stringify(packet.currentEvidence ?? { status: "unavailable" })}\nCurrent uncertainty: ${packet.uncertainty ?? "none"}\nCumulative publication subject: ${packet.publicationCommitSubject ?? "not yet authored"}\n${publicationSubject}\n\nStart by running git diff --stat ${integrationBase}..${inspectionRangeHead} and git diff --name-status ${integrationBase}..${inspectionRangeHead}, then inspect scoped per-file diffs with git diff ${integrationBase}..${inspectionRangeHead} -- <path>. Do not dump the full range into context. This is the final source review: no further source correction follows. Only this reviewer completion may resolve or narrow a finding. Assess every outstanding ID exactly once against the complete current contribution, preserving the reviewed candidate behavior and the integrated target behavior. A resolved ID cannot reopen solely because target history entered candidate ancestry. Add a new causal regression only when the correction mode is changed and its canonical correction range caused it; an unchanged correction has no regression delta. Treat blocked verification as uncertainty, not a failed check. Inspect for redundant tests, helpers, and residue rather than creating another work package. Put every non-causal concern in observations. Do not edit files, change Git state, install dependencies, or run write-producing commands.\n\n## Ordered contracts\n\n${packet.contracts.map((task, index) => `### ${index + 1}. ${task.id}: ${task.title}\nObjective: ${task.compiledContract.objective}\nAcceptance: ${task.compiledContract.acceptanceCriteria.join("; ")}`).join("\n\n")}\n\n## Embedded source material\n\n${packet.sourceMaterial.map((material) => `### ${material.path}\n\n${material.content}`).join("\n\n") || "No additional source material."}\n\n## Complete frozen source corpus\n\n${packet.corpus.map((material) => `### ${material.path}\n\n${material.content}`).join("\n\n")}\n\n## Execution schedule\n\n${JSON.stringify(packet.schedule, null, 2)}\n\nUse the complete frozen corpus and schedule as context for interpretation, dependency compatibility, and candidate-caused architectural effects.\n\n## Outstanding findings\n\n${formatFindings(packet.outstandingFindings)}\n\nReturn one resolved or unresolved assessment for each supplied ID, direct causal regressions only, and optional observations.`;
}

export function buildInitialOverallReviewPrompt(args: {
  planContext: string;
  candidateContext: string;
  baseSha: string;
  currentSha: string;
  worktreePath?: string;
}): string {
  return `You are the independent whole-plan reviewer for a completed Pipkin Implement run. Review read-only in ${args.worktreePath ?? "the target checkout"}.\n\nBase SHA: ${args.baseSha}\nCurrent SHA: ${args.currentSha}\n\nStart by running git diff --stat ${args.baseSha}..${args.currentSha} and git diff --name-status ${args.baseSha}..${args.currentSha}, then inspect scoped per-file diffs with git diff ${args.baseSha}..${args.currentSha} -- <path>. Do not dump the full range into context. Assess the complete immutable source corpus and execution plan against the published target changes. Do not edit files, change Git state, install dependencies, or run write-producing commands.\n\n## Immutable plan and corpus\n\n${args.planContext}\n\n## Published candidate context\n\n${args.candidateContext}\n\nFinalize the complete findings array before authoring the handoff draft. Return an empty findings array only when the complete run is correct and satisfies the source corpus. Otherwise return the complete known set of direct material findings. The scheduler gives every reported material finding one initial repair opportunity; do not return an approval verdict. Each finding needs current evidence, the minimum observable correction, and concrete acceptance criteria. An economy finding must identify an unnecessary construct, a concrete sufficient replacement, the behavior and risk controls it preserves, and meaningful maintenance burden. Omit minor, uncertain, or non-material simplifications from this typed result. Check for materially burdensome duplicate mechanisms introduced independently across workstreams, but do not redesign a valid architecture merely for uniformity. Exclude style nits, speculative improvements, unrelated audits, and broader redesigns when a narrow correction satisfies the plan.\n\nReturn a complete concise replacement Markdown handoff draft of roughly 150–300 words with these headings: Summary; Material changes; Verification; Residual findings. The handoff transfers the entire Implement run, not this whole-plan review invocation: frame every section around the cumulative delivered state from the run base through the current target, including all workstreams and any repairs. In Summary, state the cumulative final outcome without replaying the source plan or requirement inventory. Under Material changes, use concise bullets to include every behavior, UI, interface, architecture, schema, migration, safety property, or refactor worth knowing from the complete run; combine related facts, omit routine mechanics, and do not impose an item count. Under Verification, report cumulative verification evidence for the delivered run, including retained implementation or repair checks and independent review checks, while distinguishing reported evidence from checks this reviewer independently confirmed. Use concise bullets labeled \`Passed:\` and, when applicable, \`Not verified:\`. Include \`Not verified:\` only for material run-level checks that lack valid retained evidence; do not add a gap solely because this read-only reviewer did not rerun an already evidenced check. A verification gap is not itself a residual finding. Plan projection, protected-artifact hashes, and publication-transaction integrity are orchestrator-enforced preconditions outside this semantic review. Do not infer residual findings from their internal bookkeeping or expected differences between original, projected, and publication-time hashes; report such a finding only when the candidate context explicitly reports an integrity failure. Under Residual findings, use one concise bullet per known open material problem in the cumulative result, or state \`None.\` when there are none. Do not expose raw finding IDs, review chronology, worker bookkeeping, or invented severity or outcome labels. The draft is opaque durable evidence, not a patch or a verdict.`;
}

export function buildOverallReworkPrompt(packet: OverallRepairPacket): string {
  return `You are the Pipkin Implement overall repair implementer. Address only the supplied whole-plan review findings in this assigned worktree:\n\n  ${packet.workspace.path}\n\n${packet.workspace.mutationBoundary}\n\nDo not access or mutate the target checkout, source plan, or checkbox state. The plan path and retained artifacts are orchestrator provenance, not required worker input. You may repair the candidate, run appropriate checks, and commit tracked changes. Leave no active Git operation or uncommitted work.\n\nRun: ${packet.runId}\nBase SHA: ${packet.runBaseSha}\nCurrent candidate SHA: ${packet.baseline.commitSha}\n\nStart by running git diff --stat ${packet.runBaseSha}..${packet.baseline.commitSha} and git diff --name-status ${packet.runBaseSha}..${packet.baseline.commitSha}, then inspect scoped per-file diffs with git diff ${packet.runBaseSha}..${packet.baseline.commitSha} -- <path>. Do not dump the full range into context.\n\n## Complete compiled contracts\n\n${JSON.stringify(packet.requirements.contracts, null, 2)}\n\n## Complete frozen source corpus\n\n${packet.requirements.corpus.map((material) => `### ${material.path}\n\n${material.content}`).join("\n\n")}\n\n## Worker-safe execution schedule\n\n${JSON.stringify(packet.requirements.schedule, null, 2)}\n\nUse the frozen corpus and schedule to interpret the exact findings and preserve dependency compatibility.\n\n## Complete current required corrections\n\n${formatFindings(packet.findings)}\n\nSubmit the typed completion with a concise summary, optional uncertainty, and at least one concise verification statement describing what you checked and the outcome. Verification may use tests, static analysis, direct inspection, or other appropriate evidence; it does not require a shell command.`;
}

export function buildAnchoredOverallReviewPrompt(args: {
  planContext: string;
  candidateContext: string;
  baseSha: string;
  outstandingFindings: Finding[];
  completeFindings?: Finding[];
  previousCandidate: string;
  currentCandidate: string;
  worktreePath?: string;
  authorPublicationCommitSubject?: boolean;
  latestHandoffDraft: string;
}): string {
  const publicationSubject = args.authorPublicationCommitSubject
    ? " When returning the initial repair assessment, also author one concise Conventional Commit subject describing the complete repair delta. This is publication metadata, not an additional review pass."
    : "";
  return `You are the independent reviewer for an anchored whole-plan repair. Review read-only in ${args.worktreePath ?? "the repair worktree"}.\n\nComparison base SHA: ${args.baseSha}\nPrevious candidate SHA: ${args.previousCandidate}\nCurrent candidate SHA: ${args.currentCandidate}\n\nStart by running git diff --stat ${args.baseSha}..${args.currentCandidate} and git diff --name-status ${args.baseSha}..${args.currentCandidate}, then inspect scoped per-file diffs with git diff ${args.baseSha}..${args.currentCandidate} -- <path>. Do not dump the full range into context.\n\nPlan context:\n${args.planContext}\n\nCandidate context:\n${args.candidateContext}\n\n## Latest handoff draft\n\n${args.latestHandoffDraft}\n\n## Complete prior findings\n\n${formatFindings(args.completeFindings ?? []) || "None."}\n\nAssess every outstanding finding exactly once against the complete current contribution, preserving both the previous candidate and the integrated target behavior. A resolved finding cannot reopen solely because target history entered candidate ancestry. Add a causal regression only when the canonical comparison range caused it. Place every non-causal concern in observations.\n\n## Outstanding findings\n\n${formatFindings(args.outstandingFindings)}\n\nDo not edit files, change Git state, install dependencies, or run write-producing commands.${publicationSubject}\n\nReturn a complete concise replacement Markdown handoff draft, not a patch or review chronology. The handoff transfers the entire Implement run, not the latest repair or this review invocation: frame every section around the cumulative delivered state from the run base through the current candidate. Preserve unaffected facts from the latest draft where they remain accurate, including facts from earlier workstreams and verification, and revise only what the repair or current assessment changed. Organize it with these headings: Summary; Material changes; Verification; Residual findings. In Summary, state the cumulative final outcome without replaying the source plan or requirement inventory; mention the latest repair only when it is material to understanding that outcome. Under Material changes, use concise bullets to include every behavior, UI, interface, architecture, schema, migration, safety property, or refactor worth knowing from the complete run; combine related facts, omit routine mechanics, and do not impose an item count. Under Verification, report cumulative verification evidence for the delivered run, including retained implementation or repair checks and independent review checks, while distinguishing reported evidence from checks this reviewer independently confirmed. Use concise bullets labeled \`Passed:\` and, when applicable, \`Not verified:\`. Include \`Not verified:\` only for material run-level checks that lack valid retained evidence; do not add a gap solely because this read-only reviewer did not rerun an already evidenced check. A verification gap is not itself a residual finding. Plan projection, protected-artifact hashes, and publication-transaction integrity are orchestrator-enforced preconditions outside this semantic review. Do not infer residual findings from their internal bookkeeping or expected differences between original, projected, and publication-time hashes; report such a finding only when the candidate context explicitly reports an integrity failure. Under Residual findings, use one concise bullet per known open material problem in the cumulative result, or state \`None.\` when there are none. Do not expose raw finding IDs, worker bookkeeping, or invented severity or outcome labels.`;
}

export function buildReconciliationPrompt(
  packet: ReconciliationPacket,
): string {
  const scopedPaths = packet.replay.relevantPaths.join(", ") || "none retained";
  return `You are the Pipkin Implement semantic reconciliation worker for one exact failed replay. Work only in this assigned Git candidate worktree:

  ${packet.workspace.path}

${packet.workspace.mutationBoundary}

The scheduler fixed this assignment. This is not a generic retry, workspace recreation, safety action, or publication step. Do not access the sibling target worktree, publication staging, protected source corpus, or any other worktree. Do not push, fetch, reset, rebase, amend, rewrite candidate history, bypass hooks, or change refs. Use only the retained immutable commit identities available through this worktree's Git object database.

Prior candidate: ${packet.candidate.id} @ ${packet.candidate.commitSha}
Historical workstream base: ${packet.candidate.baseSha}
Prior integration base: ${packet.priorIntegrationBase}
Failed replay target: ${packet.failedTarget.commitSha}
Failed target tree: ${packet.failedTarget.treeSha}
Replay disposition: ${packet.replay.disposition}
Semantic attempt: ${packet.semanticAttempt}
Candidate paths: ${packet.replay.candidatePaths.join(", ") || "none"}
Target paths: ${packet.replay.targetPaths.join(", ") || "none"}
Exact relevant paths: ${scopedPaths}

First inspect only scoped immutable ranges: git diff --stat ${packet.priorIntegrationBase}..${packet.candidate.commitSha}, git diff --name-status ${packet.priorIntegrationBase}..${packet.candidate.commitSha}, git diff --stat ${packet.priorIntegrationBase}..${packet.failedTarget.commitSha}, and git diff --name-status ${packet.priorIntegrationBase}..${packet.failedTarget.commitSha}. Inspect per-file diffs only for the retained paths; do not dump full ranges into context. Then merge ${packet.failedTarget.commitSha} into the current candidate branch with a normal merge commit, preserving both the reviewed candidate behavior and the failed target behavior. Resolve textual conflicts and clean semantic overlaps deliberately. Run proportionate verification, inspect the target-relative result with git diff --stat ${packet.failedTarget.commitSha}..HEAD and scoped per-file diffs, commit through ordinary hooks, and leave the assigned worktree clean with no active Git operation.

## Failed replay evidence

${packet.replay.evidence}
${packet.replay.hookEvidence ? `\nHook evidence:\n${packet.replay.hookEvidence}` : ""}

## Prior review evidence

${packet.priorEvidence.map((evidence) => `- ${evidence}`).join("\n") || "None."}

Cumulative publication subject: ${packet.publicationCommitSubject ?? "retained by the scheduler; do not author or change it"}

Submit only a concise semantic summary, at least one verification statement, and uncertainty when applicable. Do not report commit IDs, branch names, trees, paths, or Git operation output: the orchestrator observes those directly.`;
}

export function buildRevisionPrompt(packet: RevisionPacket): string {
  const assignmentAuthority =
    packet.authority.kind === "review_findings"
      ? `review findings: ${packet.pendingCorrectionIds.join(", ")}`
      : `delivery gate ${packet.authority.category}/${packet.authority.gate}, attempt ${packet.authority.attempt}`;
  const settlement =
    packet.authority.kind === "review_findings"
      ? "Both outcomes receive one final read-only review."
      : "A changed outcome receives one final read-only review before publication retries. An unchanged outcome does not retry publication; its evidence returns to bounded delivery-gate remediation.";
  return `You are the Pipkin Implement revision worker for one exact reviewed candidate. Work only in this assigned Git worktree:\n\n  ${packet.workspace.path}\n\n${packet.workspace.mutationBoundary}\n\nThe scheduler fixed this assignment. Do not select a retry, workspace recreation, reconciliation phase, or repository-safety action. Do not access or mutate the target checkout, rewrite history, bypass hooks, modify protected source artifacts, or leave an active Git operation or uncommitted work. If you cannot produce a candidate-changing correction, describe what you attempted and what remains uncertain without changing the candidate.\n\nCandidate: ${packet.candidate.id} @ ${packet.candidate.commitSha}\nComparison base: ${packet.comparisonBase}\nFinding epoch: ${packet.findingEpoch}\nAssignment authority: ${assignmentAuthority}\n\nStart by running git diff --stat ${packet.comparisonBase}..HEAD and git diff --name-status ${packet.comparisonBase}..HEAD, then inspect scoped per-file diffs with git diff ${packet.comparisonBase}..HEAD -- <path>. Do not dump the full range into context.\n\n## Exact assigned contracts\n\n${JSON.stringify(packet.requirements.contracts, null, 2)}\n\n## Complete frozen source corpus\n\n${packet.requirements.corpus.map((material) => `### ${material.path}\n\n${material.content}`).join("\n\n")}\n\n## Worker-safe execution schedule\n\n${JSON.stringify(packet.requirements.schedule, null, 2)}\n\nUse the frozen corpus and schedule to interpret the findings and preserve dependency compatibility.\n\n## Required corrections\n\n${formatFindings(packet.findings) || "Apply the retained scheduler evidence to the candidate."}\n\n## Retained evidence\n\n${packet.evidence.map((evidence) => `- ${evidence}`).join("\n") || "None."}\n\nCommit any completed correction and return outcome \`changed\`. If you cannot produce a candidate-changing correction, return outcome \`unchanged\` with the attempted evidence, summary, verification, and uncertainty. ${settlement} Do not make unrelated changes merely to produce a changed tree. Submit only typed semantic evidence; do not report commit IDs, checkpoints, or changed paths because the orchestrator observes those from Git.`;
}

function formatFindings(findings: Finding[]): string {
  return findings
    .map(
      (finding) =>
        `### ${finding.id}: ${finding.summary}${finding.status ? `\nCanonical status: ${finding.status}` : ""}\nEvidence: ${finding.evidence}\nRequired change: ${finding.requiredChange}\nAcceptance criteria:\n${finding.acceptanceCriteria.map((criterion) => `- ${criterion}`).join("\n")}`,
    )
    .join("\n\n");
}
