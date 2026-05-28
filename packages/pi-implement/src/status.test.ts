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
});
