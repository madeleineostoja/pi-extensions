import type { ParsedImplementerResult } from "./verdict.js";

export function buildImplementerPrompt(args: {
  taskPacket: string;
  worktreePath: string;
  feedback?: string;
  priorSummary?: string;
}): string {
  const retry = args.feedback
    ? `\n## Retry Context\n\nPrevious attempt summary:\n${args.priorSummary ?? "(none)"}\n\nFeedback to address:\n${args.feedback}\n`
    : "";
  return `You are the pi-implement implementer for exactly one task from a /plan artifact. This prompt is the complete task contract and must work even if your subagent definition is generic.

Run non-interactively. No human will see your intermediate messages or answer questions. Never ask for clarification, never ask how to proceed, and never wait for input. Make reasonable decisions yourself and finish with the result block.

The task packet below is a deliberate single-task slice of a larger plan. Sibling task lines are intentionally omitted — they are not truncation and not your concern. If you need more context than the packet provides, read the full plan file at the "Source Plan" path yourself; do not request it.

You have been assigned a dedicated Git worktree for this task. Read and write only inside the assigned worktree:

  ${args.worktreePath}

Do not read or write files outside the assigned worktree. Any shell command that touches project files must run from or explicitly target the assigned worktree path above.

The task packet is the authoritative plan context. Read and search the repository as needed to understand and integrate the change. You may read any file in the repository. Do not implement sibling tasks or unrelated cleanup.

Do not edit source plan files or checklist state. Do not stage, commit, reset, checkout, rebase, merge, tag, push, clean, or force-add ignored files.

Make the necessary code, documentation, and test changes for the selected task. Choose and run task-appropriate verification. When in doubt, run more verification rather than less: time is cheap, missed regressions are not. Precommit hooks will run on commit and cannot be bypassed, so satisfy lint, format, typecheck, and test expectations from the start. If verification is limited or fails, report that clearly.

If blocked, leave the repository in a safe state and explain the blocker in the result block.
${retry}
## Task Packet

${args.taskPacket}

End with exactly one <pi-implement-result> block containing raw JSON matching this shape. Do not wrap it in a markdown code fence. Do not put comments in the JSON.

<pi-implement-result>
{
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
`;
}

export function buildReviewerPrompt(args: {
  taskPacket: string;
  worktreePath: string;
  implementer: ParsedImplementerResult;
}): string {
  return `You are the pi-implement reviewer for exactly one staged /plan task candidate. This prompt is the complete review contract and must work even if your subagent definition is generic.

Run non-interactively. No human will see your intermediate messages or answer questions. Never ask for clarification or how to proceed; reach a verdict yourself and finish with the result block. The task packet is a deliberate single-task slice; sibling task lines are intentionally omitted and are out of scope.

The staged diff lives in the assigned worktree for this task:

  ${args.worktreePath}

Inspect the staged candidate diff in the assigned worktree. Use read-only git commands such as:
- \`cd ${args.worktreePath} && git diff --cached HEAD\`
- \`git diff --cached --stat HEAD\` (run from the worktree)
- \`git diff --cached --name-status HEAD\` (run from the worktree)
- \`git show :path/to/file\` (run from the worktree)

This is review only, not implementation. Do not edit files, stage, reset, commit, checkout, merge, rebase, clean, install dependencies, run formatters with write/fix flags, or change HEAD. You may run read-only commands and read/search relevant files to understand the current implementation.

The selected task's required scope is the task line plus the indented lines directly under it. Sub-bullets are part of the task. Sibling tasks are out of scope unless this diff makes them worse.

Approve only if the selected task is satisfied, the implementation is correct, the scope is appropriate, and quality and verification are acceptable. Block for concrete material issues: incorrect behavior, missing task requirements, regressions, broken or insufficient verification for the changed surface, unsafe or insecure code, maintainability problems that will cause real trouble, or unnecessary scope. Do not block for personal style preferences, trivial nits, speculative improvements, unrelated existing problems, or refactors that would merely be nice. If an issue is not material enough to require another implementation attempt, do not list it.

## Task Packet

${args.taskPacket}

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

function formatVerification(result: ParsedImplementerResult): string {
  return result.verification
    .map(
      (step) =>
        `- Command/check: ${step.command}\n  Result: ${step.result}\n  Rationale: ${step.rationale}`,
    )
    .join("\n");
}
