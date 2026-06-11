import { describe, expect, it } from "vitest";
import {
  checkpointPatch,
  formatFooterStatus,
  formatFooterStatusParts,
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
    const footerState: RunState = {
      phase: "coding",
      taskIndex: 2,
      totalTasks: 7,
      attempt: 1,
    };
    expect(formatFooterStatus(footerState)).toBe("󰚩 implement 2/7");
    expect(formatFooterStatusParts(footerState)).toMatchObject({
      glyph: "󰚩",
      text: "implement 2/7",
      tone: "active",
    });
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
        {
          id: "t3",
          planIndex: 3,
          title: "Task 3",
          status: "satisfied",
        },
      ],
      landedCount: 1,
      totalCount: 3,
    });

    expect(status).toContain("pi-implement: scheduling");
    expect(status).toContain("Mode: parallel (auto)");
    expect(status).toContain("t1 Task 1: landed @ aaa1111");
    expect(status).toContain("t2 Task 2: coding [/wt/t2]");
    expect(status).toContain("t3 Task 3: satisfied");
    expect(status).not.toContain("t3 Task 3: satisfied @");
    expect(
      formatFooterStatus({
        phase: "scheduling",
        tasks: [
          { id: "a", planIndex: 1, title: "A", status: "landed" },
          { id: "b", planIndex: 2, title: "B", status: "satisfied" },
          { id: "c", planIndex: 3, title: "C", status: "approved" },
        ],
        landedCount: 1,
        satisfiedCount: 1,
        totalCount: 3,
      }),
    ).toBe("󰚩 implement 2/3");
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
    expect(widget).toEqual(
      expect.arrayContaining([expect.stringContaining("/agents")]),
    );
  });

  it("serial widget progress shows currently active task", () => {
    const lines = formatWidgetLines({
      phase: "coding",
      taskIndex: 3,
      totalTasks: 7,
    });
    expect(lines[0]).toContain("3/7");
    expect(lines[0]).toContain("current");
  });

  it("parallel widget progress shows landed tasks", () => {
    const lines = formatWidgetLines({
      phase: "coding",
      tasks: [
        { id: "t1", planIndex: 0, title: "T1", status: "landed" },
        { id: "t2", planIndex: 1, title: "T2", status: "coding" },
      ],
      landedCount: 2,
      totalCount: 7,
    });
    expect(lines[0]).toContain("1/7");
    expect(lines[0]).toContain("landed");
  });

  it("parallel footer and widget expose failed tasks", () => {
    const state: RunState = {
      phase: "integrating",
      tasks: [
        { id: "t1", planIndex: 0, title: "T1", status: "landed" },
        { id: "t2", planIndex: 1, title: "T2", status: "failed" },
        { id: "t3", planIndex: 2, title: "T3", status: "coding" },
      ],
      landedCount: 0,
      totalCount: 3,
    };

    expect(formatFooterStatus(state)).toBe("󰚩 implement 1/3 · 1 failed");
    expect(formatFooterStatusParts(state)).toMatchObject({ tone: "warning" });
    expect(formatWidgetLines(state)[0]).toContain("1/3 landed · 1 failed");
  });

  it("parallel widget progress includes satisfied tasks without landed wording", () => {
    const lines = formatWidgetLines({
      phase: "coding",
      tasks: [
        { id: "t1", planIndex: 1, title: "T1", status: "landed" },
        { id: "t2", planIndex: 2, title: "T2", status: "satisfied" },
      ],
      landedCount: 1,
      satisfiedCount: 1,
      totalCount: 7,
    });
    expect(lines[0]).toContain("2/7");
    expect(lines[0]).toContain("complete");
    expect(lines[0]).not.toContain("landed");
  });

  it("widget active-agent entries include label, short id, and /agents hint", () => {
    const now = new Date("2024-01-01T00:10:00Z").getTime();
    const lines = formatWidgetLines(
      {
        phase: "coding",
        taskIndex: 3,
        totalTasks: 7,
        activeSubagentIds: ["agent-123456789"],
        activeAgentRefs: [
          {
            id: "agent-123456789",
            role: "implementer",
            label: "Task 3/7 implementer \u00b7 Add retry handling",
            startedAt: "2024-01-01T00:04:00Z",
            taskIndex: 3,
            taskTotal: 7,
            taskTitle: "Add retry handling",
          },
        ],
      },
      now,
    );
    const agentLine = lines.find((l) => l.includes("Task 3/7 implementer"));
    expect(agentLine).toBeDefined();
    expect(agentLine).toContain("agent-12");
    expect(agentLine).toContain("/agents");
  });

  it("includes runtime snapshot details in widget lines", () => {
    const now = new Date("2024-01-01T00:10:00Z").getTime();
    const lines = formatWidgetLines(
      {
        phase: "coding",
        taskIndex: 3,
        totalTasks: 7,
        activeSubagentIds: ["agent-123456789"],
        activeAgentRefs: [
          {
            id: "agent-123456789",
            role: "implementer",
            label: "Task 3/7 implementer \u00b7 Add retry handling",
            startedAt: "2024-01-01T00:04:00Z",
            taskIndex: 3,
            taskTotal: 7,
            taskTitle: "Add retry handling",
          },
        ],
      },
      now,
      [
        {
          id: "agent-123456789",
          status: "running",
          toolUses: 4,
          tokensTotal: 12300,
          compactionCount: 2,
        },
      ],
    );
    const agentLine = lines.find((l) => l.includes("Task 3/7 implementer"));
    expect(agentLine).toBeDefined();
    expect(agentLine).toContain("running");
    expect(agentLine).toContain("4 tool");
    expect(agentLine).toContain("12.3k");
    expect(agentLine).toContain("\u21ca2");
    expect(agentLine).toContain("/agents");
    expect(agentLine).toContain("agent-12");
  });

  it("does not throw when runtime snapshots are absent", () => {
    expect(() =>
      formatWidgetLines({
        phase: "coding",
        taskIndex: 1,
        totalTasks: 2,
      }),
    ).not.toThrow();
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

  it("formats followup_required footer and status", () => {
    const footerState: RunState = {
      phase: "followup_required",
      lastReason: "missing tests",
    };
    expect(formatFooterStatus(footerState)).toBe(
      "󰚩 implement follow-up required · missing tests",
    );
    expect(formatFooterStatusParts(footerState)).toMatchObject({
      glyph: "󰚩",
      text: "implement follow-up required · missing tests",
      tone: "warning",
    });

    const status = formatRunStatus({
      phase: "followup_required",
      lastReason: "missing tests",
      planPath: "/plan.md",
    });
    expect(status).toContain("pi-implement: followup_required");
    expect(status).toContain("Follow-up: missing tests");
    expect(status).toContain("Plan: /plan.md");
  });

  it("formats footer for final_review and final_rework phases", () => {
    expect(formatFooterStatus({ phase: "final_review" })).toBe(
      "󰚩 implement final review",
    );
    expect(formatFooterStatus({ phase: "final_rework" })).toBe(
      "󰚩 implement final rework",
    );
  });

  it("formats overall review and rework agent labels", () => {
    const overallReviewer = makeAgentLabel({
      id: "a1",
      role: "reviewer",
      label: "Reviewer · Overall review",
      startedAt: "2024-01-01T00:00:00Z",
    });
    expect(overallReviewer).toBe("Reviewer · Overall review");

    const overallReworker = makeAgentLabel({
      id: "a2",
      role: "implementer",
      label: "Overall rework · attempt 1",
      startedAt: "2024-01-01T00:00:00Z",
    });
    expect(overallReworker).toBe("Overall rework · attempt 1");
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

  it("shows elapsed duration and recent checkpoints in status", () => {
    const now = new Date("2024-01-01T00:10:00Z").getTime();
    const status = formatRunStatus(
      {
        phase: "coding",
        taskIndex: 2,
        totalTasks: 5,
        startedAt: new Date("2024-01-01T00:00:00Z").toISOString(),
        checkpointQueue: [
          "▶ Task 1/5 started: A",
          "✓ Task 1/5 landed",
          "▶ Task 2/5 started: B",
        ],
      },
      now,
    );
    expect(status).toContain("Elapsed: 10m");
    expect(status).toContain("Recent checkpoints:");
    expect(status).toContain("  ▶ Task 1/5 started: A");
    expect(status).toContain("  ✓ Task 1/5 landed");
    expect(status).toContain("  ▶ Task 2/5 started: B");
  });

  it("shows active agent elapsed durations in status", () => {
    const now = new Date("2024-01-01T00:05:00Z").getTime();
    const status = formatRunStatus(
      {
        phase: "coding",
        activeSubagentIds: ["a1"],
        activeAgentRefs: [
          {
            id: "a1",
            role: "implementer",
            label: "Task 2/5 implementer · Add retry",
            startedAt: new Date("2024-01-01T00:02:00Z").toISOString(),
            taskIndex: 2,
            taskTotal: 5,
            taskTitle: "Add retry",
          },
        ],
      },
      now,
    );
    expect(status).toContain("Active agents:");
    expect(status).toContain("  Task 2/5 implementer · Add retry · 3m");
    expect(status).toContain("    agent id: a1");
  });

  it("caps recent checkpoints at 5 entries", () => {
    const now = new Date("2024-01-01T00:10:00Z").getTime();
    const status = formatRunStatus(
      {
        phase: "coding",
        checkpointQueue: Array.from(
          { length: 10 },
          (_, i) => `checkpoint ${i + 1}`,
        ),
      },
      now,
    );
    expect(status).toContain("Recent checkpoints:");
    expect(status).not.toContain("  checkpoint 1\n");
    expect(status).toContain("  checkpoint 6\n");
    expect(status).toContain("  checkpoint 10");
    const lines = status
      .split("\n")
      .filter((l) => l.startsWith("  checkpoint"));
    expect(lines).toHaveLength(5);
  });
});
