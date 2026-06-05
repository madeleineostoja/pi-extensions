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
    expect(prompt).toContain(
      "Do not require a new commit solely because the satisfying changes came from an earlier pi-implement task",
    );
    expect(prompt).toContain(TASK_PACKET.trim());
    expect(prompt).toContain(WORKTREE_PATH);
    expect(prompt).toContain("Do not edit files");
    expect(prompt).toContain("change HEAD");
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
});
