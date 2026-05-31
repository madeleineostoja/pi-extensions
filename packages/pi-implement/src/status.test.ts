import { describe, expect, it } from "vitest";
import { formatFooterStatus, formatRunStatus } from "./status.js";

describe("status formatting", () => {
  it("formats idle", () => {
    expect(formatRunStatus({ phase: "idle" })).toBe("pi-implement: idle");
    expect(formatFooterStatus({ phase: "idle" })).toBe("");
  });

  it("formats active details", () => {
    expect(
      formatRunStatus({
        phase: "coding",
        planPath: "/plan.md",
        taskIndex: 2,
        totalTasks: 7,
        attempt: 1,
        activeSubagentId: "agent-1",
      }),
    ).toContain("Task: 2/7");
    expect(
      formatFooterStatus({
        phase: "coding",
        taskIndex: 2,
        totalTasks: 7,
        attempt: 1,
      }),
    ).toBe("implement 2/7 · coding · attempt 1");
  });

  it("formats parallel active footer", () => {
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
    ).toBe("implement 1/3 landed · scheduling");
  });

  it("formats parallel run status with tasks", () => {
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
        {
          id: "t3",
          planIndex: 3,
          title: "Task 3",
          status: "pending",
          blockedReason: "waiting for t2",
        },
      ],
      landedCount: 1,
      totalCount: 3,
    });
    expect(status).toContain("pi-implement: scheduling");
    expect(status).toContain("Run ID: r1");
    expect(status).toContain("Plan: /plan.md");
    expect(status).toContain("Mode: parallel (auto)");
    expect(status).toContain("Base SHA: abc1234");
    expect(status).toContain("Main HEAD: def5678");
    expect(status).toContain("Max concurrency: 3");
    expect(status).toContain("Tasks:");
    expect(status).toContain("t1 Task 1: landed @ aaa1111");
    expect(status).toContain("t2 Task 2: coding [/wt/t2]");
    expect(status).toContain("t3 Task 3: pending (waiting for t2)");
  });

  it("formats blocked", () => {
    expect(
      formatFooterStatus({
        phase: "blocked",
        lastReason: "something bad happened",
      }),
    ).toBe("implement blocked · something bad happened");
  });

  it("formats stopped", () => {
    expect(formatFooterStatus({ phase: "stopped" })).toBe("implement stopped");
    expect(formatRunStatus({ phase: "stopped" })).toBe("pi-implement: stopped");
  });

  it("formats done", () => {
    expect(formatFooterStatus({ phase: "done" })).toBe("implement done");
    expect(formatRunStatus({ phase: "done" })).toBe("pi-implement: done");
  });

  it("formats active subagents list", () => {
    const status = formatRunStatus({
      phase: "coding",
      activeSubagentIds: ["agent-1", "agent-2"],
    });
    expect(status).toContain("Active subagents: agent-1, agent-2");
  });
});
