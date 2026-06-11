import { describe, expect, it } from "vitest";
import {
  buildAlreadySatisfiedReviewerPrompt,
  buildImplementerPrompt,
  buildOverallReviewerPrompt,
  buildReviewerPrompt,
} from "./prompts.js";

const WORKTREE_PATH = "/repo/.pi/implement/worktrees/r1/t001-my-task";

const TASK_PACKET = `# Task Packet

## Selected Task

- [ ] My task
`;

const REFERENCED_TASK_PACKET = `# Task Packet

## Selected Task

- [ ] My task

## Referenced Plan Material

### auth.md

# Auth Plan

Raw auth requirement.
`;

const IMPLEMENTER_RESULT = {
  outcome: "changed" as const,
  summary: "Did the thing",
  verification: [
    { command: "npm test", result: "passed", rationale: "covers change" },
  ],
  commitMessage: "feat: my task",
};

describe("buildImplementerPrompt", () => {
  it("carries the task packet and assigned worktree contract", () => {
    const prompt = buildImplementerPrompt({
      taskPacket: TASK_PACKET,
      worktreePath: WORKTREE_PATH,
    });

    expect(prompt).toContain(TASK_PACKET.trim());
    expect(prompt).toContain(WORKTREE_PATH);
    expect(prompt).toContain(
      "Read and write only inside the assigned worktree",
    );
    expect(prompt).toContain(
      "Do not edit source plan files or checklist state",
    );
  });

  it("states the required implementation scope is only the selected task", () => {
    const prompt = buildImplementerPrompt({
      taskPacket: TASK_PACKET,
      worktreePath: WORKTREE_PATH,
    });

    expect(prompt).toContain(
      "**Required implementation scope:** Only the selected task line plus its indented block",
    );
    expect(prompt).toContain(
      "Do not implement sibling tasks or unrelated cleanup, even when global plan context mentions them",
    );
  });

  it("does not invite the implementer to read the full plan as a general scope expansion", () => {
    const prompt = buildImplementerPrompt({
      taskPacket: TASK_PACKET,
      worktreePath: WORKTREE_PATH,
    });

    expect(prompt).not.toContain(
      'read the full plan file at the "Source Plan" path yourself',
    );
    expect(prompt).not.toContain("read the full plan file");
    expect(prompt).toContain(
      "The task packet below is the complete, authoritative plan context for this task",
    );
  });

  it("does not suggest reading the source plan file for background context", () => {
    const prompt = buildImplementerPrompt({
      taskPacket: TASK_PACKET,
      worktreePath: WORKTREE_PATH,
    });

    expect(prompt).not.toContain("you may read the source plan file");
    expect(prompt).not.toContain("source plan file is not an extension of it");
  });

  it("tells the implementer to stop and narrow when implementing an unselected sibling task", () => {
    const prompt = buildImplementerPrompt({
      taskPacket: TASK_PACKET,
      worktreePath: WORKTREE_PATH,
    });

    expect(prompt).toContain(
      "If you notice you are implementing an unselected sibling task, stop and narrow the change",
    );
    expect(prompt).toContain("do only the minimal prerequisite");
    expect(prompt).toContain(
      "Do not complete the sibling task's own deliverable",
    );
  });

  it("tells the implementer to use referenced material only for selected-task context", () => {
    const prompt = buildImplementerPrompt({
      taskPacket: TASK_PACKET,
      worktreePath: WORKTREE_PATH,
    });

    expect(prompt).toContain(
      "The packet may contain referenced plan material that is broader than the selected task",
    );
    expect(prompt).toContain(
      "Use that material only for context directly relevant to the selected task",
    );
    expect(prompt).toContain(
      "Do not implement unrelated requirements merely because they appear in referenced material",
    );
  });

  it("includes referenced material without adding sibling task scope", () => {
    const prompt = buildImplementerPrompt({
      taskPacket: REFERENCED_TASK_PACKET,
      worktreePath: WORKTREE_PATH,
    });

    expect(prompt).toContain("## Referenced Plan Material");
    expect(prompt).toContain("### auth.md");
    expect(prompt).toContain("Raw auth requirement.");
    expect(prompt).not.toContain("## Out-of-Scope Sibling Tasks");
    expect(prompt).not.toContain("Sibling task A");
  });

  it("documents both outcome values in the result schema", () => {
    const prompt = buildImplementerPrompt({
      taskPacket: TASK_PACKET,
      worktreePath: WORKTREE_PATH,
    });

    expect(prompt).toContain('outcome: "changed"');
    expect(prompt).toContain('outcome: "already_satisfied"');
    expect(prompt).toContain(
      "when the current repository state already satisfies the selected task and no file changes are necessary",
    );
    expect(prompt).toContain(
      "You must verify the selected task against current files and tests before claiming",
    );
  });

  it("includes retry context when reviewer feedback is supplied", () => {
    const prompt = buildImplementerPrompt({
      taskPacket: TASK_PACKET,
      worktreePath: WORKTREE_PATH,
      feedback: "fix the bug",
      priorSummary: "tried but failed",
    });

    expect(prompt).toContain("fix the bug");
    expect(prompt).toContain("tried but failed");
  });

  it("omits Scout Context when no scoutContext is provided", () => {
    const prompt = buildImplementerPrompt({
      taskPacket: TASK_PACKET,
      worktreePath: WORKTREE_PATH,
    });

    expect(prompt).not.toContain("## Scout Context");
    expect(prompt).not.toContain("read-only Scout");
  });

  it("includes Scout Context before Task Packet when scoutContext is provided", () => {
    const prompt = buildImplementerPrompt({
      taskPacket: TASK_PACKET,
      worktreePath: WORKTREE_PATH,
      scoutContext: "Relevant file: src/foo.ts",
    });

    expect(prompt).toContain("## Scout Context");
    expect(prompt).toContain("Relevant file: src/foo.ts");
    const scoutIndex = prompt.indexOf("## Scout Context");
    const packetIndex = prompt.indexOf("## Task Packet");
    expect(scoutIndex).toBeGreaterThan(0);
    expect(packetIndex).toBeGreaterThan(0);
    expect(scoutIndex).toBeLessThan(packetIndex);
  });

  it("tells the implementer to treat Scout as a map, not truth", () => {
    const prompt = buildImplementerPrompt({
      taskPacket: TASK_PACKET,
      worktreePath: WORKTREE_PATH,
      scoutContext: "some context",
    });

    expect(prompt).toContain("starting map, not authoritative truth");
    expect(prompt).toContain(
      "Treat Scout findings as hints, not facts. Read relevant files yourself before editing.",
    );
  });

  it("tells the implementer to avoid expanding scope based on Scout discoveries", () => {
    const prompt = buildImplementerPrompt({
      taskPacket: TASK_PACKET,
      worktreePath: WORKTREE_PATH,
      scoutContext: "some context",
    });

    expect(prompt).toContain(
      "Do not expand your implementation scope based on Scout discoveries. Stick to the selected task packet.",
    );
  });

  it("tells the implementer to avoid broad repo search unless Scout is clearly insufficient", () => {
    const prompt = buildImplementerPrompt({
      taskPacket: TASK_PACKET,
      worktreePath: WORKTREE_PATH,
      scoutContext: "some context",
    });

    expect(prompt).toContain(
      "Avoid broad repository searches unless the Scout context is clearly insufficient for the task.",
    );
  });

  it("places Scout Context after Retry Context when both are present", () => {
    const prompt = buildImplementerPrompt({
      taskPacket: TASK_PACKET,
      worktreePath: WORKTREE_PATH,
      feedback: "fix the bug",
      priorSummary: "tried but failed",
      scoutContext: "Relevant file: src/foo.ts",
    });

    const retryIndex = prompt.indexOf("## Retry Context");
    const scoutIndex = prompt.indexOf("## Scout Context");
    const packetIndex = prompt.indexOf("## Task Packet");
    expect(retryIndex).toBeLessThan(scoutIndex);
    expect(scoutIndex).toBeLessThan(packetIndex);
  });
});

describe("buildReviewerPrompt", () => {
  it("carries the task packet, assigned worktree, and staged-diff contract", () => {
    const prompt = buildReviewerPrompt({
      taskPacket: TASK_PACKET,
      worktreePath: WORKTREE_PATH,
      implementer: IMPLEMENTER_RESULT,
    });

    expect(prompt).toContain(TASK_PACKET.trim());
    expect(prompt).toContain(WORKTREE_PATH);
    expect(prompt).toContain("staged candidate diff");
    expect(prompt).toContain("Do not edit files");
    expect(prompt).toContain("change HEAD");
  });

  it("includes out-of-scope sibling tasks when provided", () => {
    const prompt = buildReviewerPrompt({
      taskPacket: TASK_PACKET,
      worktreePath: WORKTREE_PATH,
      implementer: IMPLEMENTER_RESULT,
      outOfScopeTasks: ["- [ ] Sibling task A", "- [ ] Sibling task B"],
    });

    expect(prompt).toContain("## Out-of-Scope Sibling Tasks");
    expect(prompt).toContain("- [ ] Sibling task A");
    expect(prompt).toContain("- [ ] Sibling task B");
  });

  it("omits the sibling section when no out-of-scope tasks are provided", () => {
    const prompt = buildReviewerPrompt({
      taskPacket: TASK_PACKET,
      worktreePath: WORKTREE_PATH,
      implementer: IMPLEMENTER_RESULT,
    });

    expect(prompt).not.toContain("## Out-of-Scope Sibling Tasks");
  });

  it("tells reviewers to request changes for substantial sibling-task implementation", () => {
    const prompt = buildReviewerPrompt({
      taskPacket: TASK_PACKET,
      worktreePath: WORKTREE_PATH,
      implementer: IMPLEMENTER_RESULT,
      outOfScopeTasks: ["- [ ] Sibling task"],
    });

    expect(prompt).toContain(
      "Request changes if the staged diff substantially implements an unselected sibling task",
    );
    expect(prompt).toContain(
      "Completing a sibling task's own deliverable is scope creep",
    );
    expect(prompt).toContain(
      "Small prerequisite changes needed for the selected task may be approved",
    );
  });

  it("uses the target sibling-task wording in the out-of-scope section", () => {
    const prompt = buildReviewerPrompt({
      taskPacket: TASK_PACKET,
      worktreePath: WORKTREE_PATH,
      implementer: IMPLEMENTER_RESULT,
      outOfScopeTasks: ["- [ ] Sibling task"],
    });

    expect(prompt).toContain(
      "The following tasks are not selected. Use them only to identify scope creep in the candidate diff.",
    );
  });

  it("retains referenced material and reviewer-only sibling context together", () => {
    const prompt = buildReviewerPrompt({
      taskPacket: REFERENCED_TASK_PACKET,
      worktreePath: WORKTREE_PATH,
      implementer: IMPLEMENTER_RESULT,
      outOfScopeTasks: ["- [ ] Sibling task A"],
    });

    expect(prompt).toContain("## Referenced Plan Material");
    expect(prompt).toContain("### auth.md");
    expect(prompt).toContain("Raw auth requirement.");
    expect(prompt).toContain("## Out-of-Scope Sibling Tasks");
    expect(prompt).toContain("- [ ] Sibling task A");
  });

  it("contains the initial material-blocking-set contract when no prior required changes are given", () => {
    const prompt = buildReviewerPrompt({
      taskPacket: TASK_PACKET,
      worktreePath: WORKTREE_PATH,
      implementer: IMPLEMENTER_RESULT,
    });

    expect(prompt).toContain("## Review Mode: Initial Material Review");
    expect(prompt).toContain(
      "Perform one complete pass for material task-level blockers",
    );
    expect(prompt).toContain(
      "List every blocking issue that must be fixed before this task can be committed",
    );
  });

  it("allows meaningful material quality cleanup in initial review", () => {
    const prompt = buildReviewerPrompt({
      taskPacket: TASK_PACKET,
      worktreePath: WORKTREE_PATH,
      implementer: IMPLEMENTER_RESULT,
    });

    expect(prompt).toContain(
      "You may request meaningful cleanup or code-quality fixes when they materially affect maintainability or are naturally coupled to larger required changes",
    );
  });

  it("does not invite nit-only blocking in initial review", () => {
    const prompt = buildReviewerPrompt({
      taskPacket: TASK_PACKET,
      worktreePath: WORKTREE_PATH,
      implementer: IMPLEMENTER_RESULT,
    });

    expect(prompt).toContain(
      "Do not block solely for personal style preferences, trivial nits, speculative improvements, unrelated existing problems, or optional refactors",
    );
    expect(prompt).toContain(
      "Non-blocking observations should not be included in `requiredChanges`",
    );
    expect(prompt).toContain(
      "leave broader concerns for the final overall review",
    );
  });

  it("contains reviewer validation-limitation handoff instructions", () => {
    const prompt = buildReviewerPrompt({
      taskPacket: TASK_PACKET,
      worktreePath: WORKTREE_PATH,
      implementer: IMPLEMENTER_RESULT,
    });

    expect(prompt).toContain(
      "You are a read-only reviewer and may be unable to install dependencies, run write-producing setup, or execute unavailable commands",
    );
    expect(prompt).toContain(
      "request a concrete implementer action such as running the missing verification command, adding or adjusting objective tests, or reporting verification output in the next implementer result",
    );
    expect(prompt).toContain(
      "Treat this as a normal `changes_requested` result, not a subagent or system failure",
    );
  });

  it("contains the anchored re-review mode and prior required changes list", () => {
    const prompt = buildReviewerPrompt({
      taskPacket: TASK_PACKET,
      worktreePath: WORKTREE_PATH,
      implementer: IMPLEMENTER_RESULT,
      priorRequiredChanges: [
        "Fix the off-by-one error",
        "Add a test for the edge case",
      ],
    });

    expect(prompt).toContain("## Review Mode: Anchored Re-review");
    expect(prompt).toContain("## Prior Required Changes");
    expect(prompt).toContain("1. Fix the off-by-one error");
    expect(prompt).toContain("2. Add a test for the edge case");
  });

  it("requires exact copies of unresolved prior items only in anchored re-review", () => {
    const prompt = buildReviewerPrompt({
      taskPacket: TASK_PACKET,
      worktreePath: WORKTREE_PATH,
      implementer: IMPLEMENTER_RESULT,
      priorRequiredChanges: ["Fix the off-by-one error"],
    });

    expect(prompt).toContain(
      "`requiredChanges` must contain exact copies of unresolved prior item text only",
    );
  });

  it("forbids introducing new issues in anchored re-review", () => {
    const prompt = buildReviewerPrompt({
      taskPacket: TASK_PACKET,
      worktreePath: WORKTREE_PATH,
      implementer: IMPLEMENTER_RESULT,
      priorRequiredChanges: ["Fix the off-by-one error"],
    });

    expect(prompt).toContain(
      "Do not restate, broaden, or introduce new issues, even if you notice one during re-review",
    );
    expect(prompt).toContain(
      "New or broader concerns belong to the final overall review/rework loop",
    );
  });

  it("does not include critical-issue escape wording in anchored re-review", () => {
    const prompt = buildReviewerPrompt({
      taskPacket: TASK_PACKET,
      worktreePath: WORKTREE_PATH,
      implementer: IMPLEMENTER_RESULT,
      priorRequiredChanges: ["Fix the off-by-one error"],
    });

    expect(prompt).not.toContain("critical");
    expect(prompt).not.toContain("escape");
  });
});

describe("buildAlreadySatisfiedReviewerPrompt", () => {
  it("tells the reviewer there is no staged diff and the task is claimed already satisfied", () => {
    const prompt = buildAlreadySatisfiedReviewerPrompt({
      taskPacket: TASK_PACKET,
      worktreePath: WORKTREE_PATH,
      implementer: IMPLEMENTER_RESULT,
      headSha: "abc1234",
    });

    expect(prompt).toContain("There is no staged candidate diff for this task");
    expect(prompt).toContain(
      "The implementer claims the selected task is already satisfied by the current repository state",
    );
    expect(prompt).toContain(TASK_PACKET.trim());
    expect(prompt).toContain(WORKTREE_PATH);
    expect(prompt).toContain("Do not edit files");
    expect(prompt).toContain("change HEAD");
  });

  it("restores the already-satisfied acceptance contract", () => {
    const prompt = buildAlreadySatisfiedReviewerPrompt({
      taskPacket: TASK_PACKET,
      worktreePath: WORKTREE_PATH,
      implementer: IMPLEMENTER_RESULT,
      headSha: "abc1234",
    });

    expect(prompt).toContain(
      "The selected task's required scope is the selected task line plus its indented block",
    );
    expect(prompt).toContain(
      "Approve when that selected task line and indented block are satisfied now",
    );
    expect(prompt).toContain(
      "Do not require a new commit solely because the satisfying changes came from an earlier pi-implement task",
    );
  });

  it("includes the accumulated diff when provided", () => {
    const prompt = buildAlreadySatisfiedReviewerPrompt({
      taskPacket: TASK_PACKET,
      worktreePath: WORKTREE_PATH,
      implementer: IMPLEMENTER_RESULT,
      headSha: "abc1234",
      accumulatedDiff: "diff --git a/file.ts b/file.ts\n",
    });

    expect(prompt).toContain("diff --git a/file.ts b/file.ts");
    expect(prompt).toContain("Accumulated Run Diff");
  });

  it("includes an available empty accumulated diff", () => {
    const prompt = buildAlreadySatisfiedReviewerPrompt({
      taskPacket: TASK_PACKET,
      worktreePath: WORKTREE_PATH,
      implementer: IMPLEMENTER_RESULT,
      headSha: "abc1234",
      accumulatedDiff: "",
    });

    expect(prompt).toContain("Accumulated Run Diff");
    expect(prompt).toContain("```diff\n\n```");
    expect(prompt).not.toContain("too large to include or was not available");
  });

  it("omits the accumulated diff and instructs direct inspection when not provided", () => {
    const prompt = buildAlreadySatisfiedReviewerPrompt({
      taskPacket: TASK_PACKET,
      worktreePath: WORKTREE_PATH,
      implementer: IMPLEMENTER_RESULT,
      headSha: "abc1234",
    });

    expect(prompt).toContain(
      "Inspect the current repository state directly using read-only git and file commands",
    );
  });

  it("includes out-of-scope sibling tasks when provided", () => {
    const prompt = buildAlreadySatisfiedReviewerPrompt({
      taskPacket: TASK_PACKET,
      worktreePath: WORKTREE_PATH,
      implementer: IMPLEMENTER_RESULT,
      headSha: "abc1234",
      outOfScopeTasks: ["- [ ] Sibling task A", "- [ ] Sibling task B"],
    });

    expect(prompt).toContain("## Out-of-Scope Sibling Tasks");
    expect(prompt).toContain("- [ ] Sibling task A");
    expect(prompt).toContain("- [ ] Sibling task B");
    expect(prompt).toContain(
      "The following tasks are not selected. Use them only to identify scope creep in the candidate diff.",
    );
  });

  it("omits the sibling section when no out-of-scope tasks are provided", () => {
    const prompt = buildAlreadySatisfiedReviewerPrompt({
      taskPacket: TASK_PACKET,
      worktreePath: WORKTREE_PATH,
      implementer: IMPLEMENTER_RESULT,
      headSha: "abc1234",
    });

    expect(prompt).not.toContain("## Out-of-Scope Sibling Tasks");
  });

  it("retains referenced material and reviewer-only sibling context together", () => {
    const prompt = buildAlreadySatisfiedReviewerPrompt({
      taskPacket: REFERENCED_TASK_PACKET,
      worktreePath: WORKTREE_PATH,
      implementer: IMPLEMENTER_RESULT,
      headSha: "abc1234",
      outOfScopeTasks: ["- [ ] Sibling task A"],
    });

    expect(prompt).toContain("## Referenced Plan Material");
    expect(prompt).toContain("### auth.md");
    expect(prompt).toContain("Raw auth requirement.");
    expect(prompt).toContain("## Out-of-Scope Sibling Tasks");
    expect(prompt).toContain("- [ ] Sibling task A");
  });

  it("contains the initial material-blocking-set contract when no prior required changes are given", () => {
    const prompt = buildAlreadySatisfiedReviewerPrompt({
      taskPacket: TASK_PACKET,
      worktreePath: WORKTREE_PATH,
      implementer: IMPLEMENTER_RESULT,
      headSha: "abc1234",
    });

    expect(prompt).toContain("## Review Mode: Initial Material Review");
    expect(prompt).toContain(
      "Perform one complete pass for material task-level blockers",
    );
    expect(prompt).toContain(
      "List every blocking issue that must be fixed before this task can be accepted as already satisfied",
    );
  });

  it("allows meaningful material quality cleanup in initial review", () => {
    const prompt = buildAlreadySatisfiedReviewerPrompt({
      taskPacket: TASK_PACKET,
      worktreePath: WORKTREE_PATH,
      implementer: IMPLEMENTER_RESULT,
      headSha: "abc1234",
    });

    expect(prompt).toContain(
      "You may request meaningful cleanup or code-quality fixes when they materially affect maintainability or are naturally coupled to larger required changes",
    );
  });

  it("does not invite nit-only blocking in initial review", () => {
    const prompt = buildAlreadySatisfiedReviewerPrompt({
      taskPacket: TASK_PACKET,
      worktreePath: WORKTREE_PATH,
      implementer: IMPLEMENTER_RESULT,
      headSha: "abc1234",
    });

    expect(prompt).toContain(
      "Do not block solely for personal style preferences, trivial nits, speculative improvements, unrelated existing problems, or optional refactors",
    );
    expect(prompt).toContain(
      "Non-blocking observations should not be included in `requiredChanges`",
    );
    expect(prompt).toContain(
      "leave broader concerns for the final overall review",
    );
  });

  it("contains reviewer validation-limitation handoff instructions", () => {
    const prompt = buildAlreadySatisfiedReviewerPrompt({
      taskPacket: TASK_PACKET,
      worktreePath: WORKTREE_PATH,
      implementer: IMPLEMENTER_RESULT,
      headSha: "abc1234",
    });

    expect(prompt).toContain(
      "You are a read-only reviewer and may be unable to install dependencies, run write-producing setup, or execute unavailable commands",
    );
    expect(prompt).toContain(
      "request a concrete implementer action such as running the missing verification command, adding or adjusting objective tests, or reporting verification output in the next implementer result",
    );
    expect(prompt).toContain(
      "Treat this as a normal `changes_requested` result, not a subagent or system failure",
    );
  });

  it("contains the anchored re-review mode and prior required changes list", () => {
    const prompt = buildAlreadySatisfiedReviewerPrompt({
      taskPacket: TASK_PACKET,
      worktreePath: WORKTREE_PATH,
      implementer: IMPLEMENTER_RESULT,
      headSha: "abc1234",
      priorRequiredChanges: [
        "Fix the off-by-one error",
        "Add a test for the edge case",
      ],
    });

    expect(prompt).toContain("## Review Mode: Anchored Re-review");
    expect(prompt).toContain("## Prior Required Changes");
    expect(prompt).toContain("1. Fix the off-by-one error");
    expect(prompt).toContain("2. Add a test for the edge case");
  });

  it("requires exact copies of unresolved prior items only in anchored re-review", () => {
    const prompt = buildAlreadySatisfiedReviewerPrompt({
      taskPacket: TASK_PACKET,
      worktreePath: WORKTREE_PATH,
      implementer: IMPLEMENTER_RESULT,
      headSha: "abc1234",
      priorRequiredChanges: ["Fix the off-by-one error"],
    });

    expect(prompt).toContain(
      "`requiredChanges` must contain exact copies of unresolved prior item text only",
    );
  });

  it("forbids introducing new issues in anchored re-review", () => {
    const prompt = buildAlreadySatisfiedReviewerPrompt({
      taskPacket: TASK_PACKET,
      worktreePath: WORKTREE_PATH,
      implementer: IMPLEMENTER_RESULT,
      headSha: "abc1234",
      priorRequiredChanges: ["Fix the off-by-one error"],
    });

    expect(prompt).toContain(
      "Do not restate, broaden, or introduce new issues, even if you notice one during re-review",
    );
    expect(prompt).toContain(
      "New or broader concerns belong to the final overall review/rework loop",
    );
  });

  it("does not include critical-issue escape wording in anchored re-review", () => {
    const prompt = buildAlreadySatisfiedReviewerPrompt({
      taskPacket: TASK_PACKET,
      worktreePath: WORKTREE_PATH,
      implementer: IMPLEMENTER_RESULT,
      headSha: "abc1234",
      priorRequiredChanges: ["Fix the off-by-one error"],
    });

    expect(prompt).not.toContain("critical");
    expect(prompt).not.toContain("escape");
  });
});

describe("buildOverallReviewerPrompt", () => {
  it("includes plan, diff, base/head SHAs, run ID, and landed tasks", () => {
    const prompt = buildOverallReviewerPrompt({
      planContent: "# Plan\n\n- [ ] Task 1\n",
      planPath: "/repo/plans/feature.md",
      baseSha: "abc1234",
      headSha: "def5678",
      diff: "diff --git a/file.ts b/file.ts\n",
      runId: "r20240115-120000",
      landedTasks: [{ id: "t001-task", title: "Task 1", commitSha: "aaa1111" }],
    });

    expect(prompt).toContain("# Plan\n\n- [ ] Task 1");
    expect(prompt).toContain("/repo/plans/feature.md");
    expect(prompt).toContain("abc1234");
    expect(prompt).toContain("def5678");
    expect(prompt).toContain("r20240115-120000");
    expect(prompt).toContain("t001-task");
    expect(prompt).toContain("aaa1111");
    expect(prompt).toContain("diff --git a/file.ts b/file.ts");
    expect(prompt).toContain("<pi-overall-review-result>");
    expect(prompt).toContain("approved");
    expect(prompt).toContain("changes_requested");
  });

  it("omits run ID and landed tasks when not provided", () => {
    const prompt = buildOverallReviewerPrompt({
      planContent: "# Plan\n",
      planPath: "/repo/plans/feature.md",
      baseSha: "abc1234",
      headSha: "def5678",
      diff: "diff --git a/file.ts b/file.ts\n",
    });

    expect(prompt).not.toContain("Run ID:");
    expect(prompt).not.toContain("Landed Tasks");
  });

  it("does not include a bundle material section when not provided", () => {
    const prompt = buildOverallReviewerPrompt({
      planContent: "# Plan\n",
      planPath: "/repo/plans/feature.md",
      baseSha: "abc1234",
      headSha: "def5678",
      diff: "diff --git a/file.ts b/file.ts\n",
    });

    expect(prompt).not.toContain("## Referenced Plan Material");
  });

  it("includes bundle material when provided", () => {
    const prompt = buildOverallReviewerPrompt({
      planContent: "# Plan\n",
      planPath: "/repo/plans/feature.md",
      baseSha: "abc1234",
      headSha: "def5678",
      diff: "diff --git a/file.ts b/file.ts\n",
      bundleMaterial: "### auth.md\n\n# Auth\n",
    });

    expect(prompt).toContain("## Referenced Plan Material");
    expect(prompt).toContain("### auth.md");
    expect(prompt).toContain("# Auth");
  });
});
