import { describe, expect, it } from "vitest";
import { formatFooterStatus, formatRunStatus } from "./status.js";

describe("status formatting", () => {
  it("reports idle state without footer noise", () => {
    expect(formatRunStatus({ phase: "idle" })).toBe("pi-implement: idle");
    expect(formatFooterStatus({ phase: "idle" })).toBe("");
  });

  it("summarizes active task progress for command output and footer", () => {
    const runStatus = formatRunStatus({
      phase: "coding",
      planPath: "/plan.md",
      taskIndex: 2,
      totalTasks: 7,
      attempt: 1,
      activeSubagentIds: ["agent-1", "agent-2"],
    });

    expect(runStatus).toContain("Task: 2/7");
    expect(runStatus).toContain("Plan: /plan.md");
    expect(runStatus).toContain("Active subagents: agent-1, agent-2");
    expect(
      formatFooterStatus({
        phase: "coding",
        taskIndex: 2,
        totalTasks: 7,
        attempt: 1,
      }),
    ).toBe("󰚩 implement 2/7");
  });

  it("summarizes parallel task state without depending on every line", () => {
    const status = formatRunStatus({
      phase: "scheduling",
      runId: "r1",
      planPath: "/plan.md",
      mode: "parallel",
      modeSource: "auto",
      baseSha: "abc1234",
      currentMainHead: "def5678",
      maxConcurrency: 3,
      tasks: [
        {
          id: "t1",
          planIndex: 1,
          title: "Task 1",
          status: "landed",
          landedCommitSha: "aaa1111",
        },
        {
          id: "t2",
          planIndex: 2,
          title: "Task 2",
          status: "coding",
          worktreePath: "/wt/t2",
        },
      ],
      landedCount: 1,
      totalCount: 3,
    });

    expect(status).toContain("pi-implement: scheduling");
    expect(status).toContain("Mode: parallel (auto)");
    expect(status).toContain("t1 Task 1: landed @ aaa1111");
    expect(status).toContain("t2 Task 2: coding [/wt/t2]");
    expect(
      formatFooterStatus({
        phase: "scheduling",
        tasks: [
          { id: "a", planIndex: 1, title: "A", status: "coding" },
          { id: "b", planIndex: 2, title: "B", status: "approved" },
        ],
        landedCount: 1,
        totalCount: 3,
      }),
    ).toBe("󰚩 implement 1/3");
  });
});
