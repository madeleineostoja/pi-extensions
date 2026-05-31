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
  it("includes the absolute assigned worktree path", () => {
    const prompt = buildImplementerPrompt({
      taskPacket: TASK_PACKET,
      worktreePath: WORKTREE_PATH,
    });
    expect(prompt).toContain(WORKTREE_PATH);
  });

  it("includes the selected task packet", () => {
    const prompt = buildImplementerPrompt({
      taskPacket: TASK_PACKET,
      worktreePath: WORKTREE_PATH,
    });
    expect(prompt).toContain(TASK_PACKET.trim());
  });

  it("instructs to read/write only inside the assigned worktree", () => {
    const prompt = buildImplementerPrompt({
      taskPacket: TASK_PACKET,
      worktreePath: WORKTREE_PATH,
    });
    expect(prompt).toContain(
      "Read and write only inside the assigned worktree",
    );
  });

  it("instructs not to edit source plan files or checklist state", () => {
    const prompt = buildImplementerPrompt({
      taskPacket: TASK_PACKET,
      worktreePath: WORKTREE_PATH,
    });
    expect(prompt).toContain(
      "Do not edit source plan files or checklist state",
    );
  });

  it("instructs not to stage, commit, reset, checkout, rebase, merge, tag, push, clean, or force-add ignored files", () => {
    const prompt = buildImplementerPrompt({
      taskPacket: TASK_PACKET,
      worktreePath: WORKTREE_PATH,
    });
    expect(prompt).toContain("stage");
    expect(prompt).toContain("commit");
    expect(prompt).toContain("reset");
    expect(prompt).toContain("checkout");
    expect(prompt).toContain("rebase");
    expect(prompt).toContain("merge");
    expect(prompt).toContain("tag");
    expect(prompt).toContain("push");
    expect(prompt).toContain("clean");
    expect(prompt).toContain("force-add ignored files");
  });

  it("instructs that shell commands touching project files must run from or target the assigned worktree", () => {
    const prompt = buildImplementerPrompt({
      taskPacket: TASK_PACKET,
      worktreePath: WORKTREE_PATH,
    });
    expect(prompt).toContain("assigned worktree");
  });

  it("includes feedback and prior summary on retry", () => {
    const prompt = buildImplementerPrompt({
      taskPacket: TASK_PACKET,
      worktreePath: WORKTREE_PATH,
      feedback: "fix the bug",
      priorSummary: "tried but failed",
    });
    expect(prompt).toContain("fix the bug");
    expect(prompt).toContain("tried but failed");
  });

  it("omits retry section when no feedback given", () => {
    const prompt = buildImplementerPrompt({
      taskPacket: TASK_PACKET,
      worktreePath: WORKTREE_PATH,
    });
    expect(prompt).not.toContain("Retry Context");
  });
});

describe("buildReviewerPrompt", () => {
  it("includes the absolute assigned worktree path", () => {
    const prompt = buildReviewerPrompt({
      taskPacket: TASK_PACKET,
      worktreePath: WORKTREE_PATH,
      implementer: IMPLEMENTER_RESULT,
    });
    expect(prompt).toContain(WORKTREE_PATH);
  });

  it("includes the selected task packet", () => {
    const prompt = buildReviewerPrompt({
      taskPacket: TASK_PACKET,
      worktreePath: WORKTREE_PATH,
      implementer: IMPLEMENTER_RESULT,
    });
    expect(prompt).toContain(TASK_PACKET.trim());
  });

  it("instructs to inspect the staged candidate diff in the assigned worktree", () => {
    const prompt = buildReviewerPrompt({
      taskPacket: TASK_PACKET,
      worktreePath: WORKTREE_PATH,
      implementer: IMPLEMENTER_RESULT,
    });
    expect(prompt).toContain("staged candidate diff");
    expect(prompt).toContain("assigned worktree");
  });

  it("includes example using git diff --cached HEAD", () => {
    const prompt = buildReviewerPrompt({
      taskPacket: TASK_PACKET,
      worktreePath: WORKTREE_PATH,
      implementer: IMPLEMENTER_RESULT,
    });
    expect(prompt).toContain("git diff --cached HEAD");
  });

  it("includes example using git diff --cached --stat HEAD", () => {
    const prompt = buildReviewerPrompt({
      taskPacket: TASK_PACKET,
      worktreePath: WORKTREE_PATH,
      implementer: IMPLEMENTER_RESULT,
    });
    expect(prompt).toContain("git diff --cached --stat HEAD");
  });

  it("includes example using git diff --cached --name-status HEAD", () => {
    const prompt = buildReviewerPrompt({
      taskPacket: TASK_PACKET,
      worktreePath: WORKTREE_PATH,
      implementer: IMPLEMENTER_RESULT,
    });
    expect(prompt).toContain("git diff --cached --name-status HEAD");
  });

  it("includes example using git show :path/to/file", () => {
    const prompt = buildReviewerPrompt({
      taskPacket: TASK_PACKET,
      worktreePath: WORKTREE_PATH,
      implementer: IMPLEMENTER_RESULT,
    });
    expect(prompt).toContain("git show :path/to/file");
  });

  it("instructs not to edit files, stage, reset, commit, or change HEAD", () => {
    const prompt = buildReviewerPrompt({
      taskPacket: TASK_PACKET,
      worktreePath: WORKTREE_PATH,
      implementer: IMPLEMENTER_RESULT,
    });
    expect(prompt).toContain("Do not edit files");
    expect(prompt).toContain("stage");
    expect(prompt).toContain("reset");
    expect(prompt).toContain("commit");
    expect(prompt).toContain("change HEAD");
  });
});
