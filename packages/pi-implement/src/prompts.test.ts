import { describe, expect, it } from "vitest";
import {
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
