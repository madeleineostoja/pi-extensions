import { describe, expect, it } from "vitest";
import {
  checkpointPatch,
  formatFooterStatus,
  formatRunStatus,
  makeAgentLabel,
  formatWidgetLines,
  type RunState,
} from "./status.js";

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

  it("formats pretty agent labels for implementer/reviewer/task roles", () => {
    const implementer = makeAgentLabel({
      id: "a1",
      role: "implementer",
      label: "foo",
      startedAt: "2024-01-01T00:00:00Z",
      taskIndex: 3,
      taskTotal: 7,
      taskTitle: "Add retry handling",
    });
    expect(implementer).toBe("Task 3/7 implementer \u00b7 Add retry handling");

    const reviewer = makeAgentLabel({
      id: "a2",
      role: "reviewer",
      label: "bar",
      startedAt: "2024-01-01T00:00:00Z",
      taskIndex: 3,
      taskTotal: 7,
      taskTitle: "Add retry handling",
    });
    expect(reviewer).toBe("Task 3/7 reviewer \u00b7 Add retry handling");

    const planner = makeAgentLabel({
      id: "a3",
      role: "planner",
      label: "baz",
      startedAt: "2024-01-01T00:00:00Z",
    });
    expect(planner).toBe("Planner \u00b7 Select implementation strategy");

    const triage = makeAgentLabel({
      id: "a4",
      role: "triage",
      label: "qux",
      startedAt: "2024-01-01T00:00:00Z",
    });
    expect(triage).toBe("Triage \u00b7 Analyze plan dependencies");
  });

  it("formats widget lines compactly for active run state", () => {
    const now = new Date("2024-01-01T00:10:00Z").getTime();
    const lines = formatWidgetLines(
      {
        phase: "coding",
        landedCount: 2,
        totalTasks: 7,
        taskIndex: 3,
        totalCount: 7,
        activeSubagentIds: ["a1", "a2"],
        activeAgentRefs: [
          {
            id: "a1",
            role: "implementer",
            label: "Task 3/7 implementer \u00b7 Add retry handling",
            startedAt: "2024-01-01T00:04:00Z",
            taskIndex: 3,
            taskTotal: 7,
            taskTitle: "Add retry handling",
          },
          {
            id: "a2",
            role: "reviewer",
            label: "Task 4/7 reviewer \u00b7 Add tests",
            startedAt: "2024-01-01T00:08:00Z",
            taskIndex: 4,
            taskTotal: 7,
            taskTitle: "Add tests",
          },
        ],
      },
      now,
    );

    expect(lines[0]).toContain("pi-implement");
    expect(lines[0]).toContain("2/7");
    expect(lines[0]).toContain("coding");
    expect(lines[1]).toContain("Task 3/7 implementer");
    expect(lines[1]).toContain("6m");
    expect(lines[2]).toContain("Task 4/7 reviewer");
    expect(lines[2]).toContain("2m");
  });

  it("omits widget lines for terminal states", () => {
    expect(formatWidgetLines({ phase: "done" })).toEqual([]);
    expect(formatWidgetLines({ phase: "blocked" })).toEqual([]);
    expect(formatWidgetLines({ phase: "stopped" })).toEqual([]);
    expect(formatWidgetLines({ phase: "idle" })).toEqual([]);
  });

  it("shows raw active subagent ids when display refs are unavailable", () => {
    const status = formatRunStatus({
      phase: "coding",
      activeSubagentIds: ["raw-1"],
    });
    expect(status).toContain("Active subagents: raw-1");

    const widget = formatWidgetLines({
      phase: "coding",
      activeSubagentIds: ["raw-1"],
    });
    expect(widget).toEqual(
      expect.arrayContaining([expect.stringContaining("raw-1")]),
    );
  });

  it("shows active agents in run status with pretty labels", () => {
    const status = formatRunStatus({
      phase: "coding",
      activeAgentRefs: [
        {
          id: "a1",
          role: "implementer",
          label: "Task 3/7 implementer \u00b7 Add retry handling",
          startedAt: "2024-01-01T00:00:00Z",
          taskIndex: 3,
          taskTotal: 7,
          taskTitle: "Add retry handling",
        },
      ],
    });
    expect(status).toContain("Active agents:");
    expect(status).toContain("Task 3/7 implementer \u00b7 Add retry handling");
    expect(status).toContain("agent id: a1");
  });

  it("keeps checkpoint history bounded while preserving emission sequence", () => {
    let state: RunState = { phase: "coding" };
    for (let i = 1; i <= 30; i++) {
      Object.assign(state, checkpointPatch(state, `checkpoint ${i}`));
    }
    expect(state.checkpointSequence).toBe(30);
    expect(state.checkpointQueue).toHaveLength(25);
    expect(state.checkpointQueue?.[0]).toBe("checkpoint 6");
    expect(state.checkpointQueue?.at(-1)).toBe("checkpoint 30");
  });
});
