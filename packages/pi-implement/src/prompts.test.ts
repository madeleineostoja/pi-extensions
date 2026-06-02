import { describe, expect, it } from "vitest";
import { buildImplementerPrompt, buildReviewerPrompt } from "./prompts.js";

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
