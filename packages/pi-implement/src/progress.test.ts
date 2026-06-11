import { describe, expect, it } from "vitest";
import { diffProgress } from "./progress.js";
import type { RunState } from "./status.js";

describe("diffProgress", () => {
  it("emits checkpoint messages when checkpointQueue grows", () => {
    const prev: RunState = {
      phase: "coding",
      taskIndex: 2,
      totalTasks: 5,
      checkpointQueue: [
        "\u00b7 Task 2/5 implementer started",
        "\u00b7 Task 2/5 implementation finished: added retry guard",
      ],
    };
    const next: RunState = {
      ...prev,
      checkpointQueue: [
        ...(prev.checkpointQueue ?? []),
        "\u00b7 Task 2/5 verification: npm test: passed; npm run typecheck: passed",
        "\u2713 Task 2/5 review approved",
      ],
    };
    const lines = diffProgress(prev, next, ["Task 1", "Task 2"]);
    expect(lines).toContain(
      "\u00b7 Task 2/5 verification: npm test: passed; npm run typecheck: passed",
    );
    expect(lines).toContain("\u2713 Task 2/5 review approved");
  });

  it("emits serial phase and task transitions", () => {
    const prev: RunState = { phase: "preflight" };
    const next: RunState = { phase: "coding", taskIndex: 1, totalTasks: 3 };
    const lines = diffProgress(prev, next, ["A", "B", "C"]);
    expect(lines).toContain("\u25b6 Task 1/3 started: A");
  });

  it("emits serial start when the task index was prefilled", () => {
    const prev: RunState = { phase: "preflight", taskIndex: 3, totalTasks: 5 };
    const next: RunState = {
      phase: "coding",
      taskIndex: 3,
      totalTasks: 5,
      attempt: 1,
    };
    const lines = diffProgress(prev, next, ["A", "B", "C", "D", "E"]);
    expect(lines).toContain("\u25b6 Task 3/5 started: C");
    expect(lines).not.toContain("↻ Task 3/5 retry (attempt 1)");
  });

  it("emits run-level done notice", () => {
    const prev: RunState = { phase: "integrating" };
    const next: RunState = { phase: "done" };
    const lines = diffProgress(prev, next, []);
    expect(lines).toContain("\u2713 pi-implement complete");
  });

  it("uses completed wording for serial task and run completion", () => {
    const prev: RunState = { phase: "reviewing", taskIndex: 1, totalTasks: 2 };
    const next: RunState = { phase: "coding", taskIndex: 2, totalTasks: 2 };
    expect(diffProgress(prev, next, ["A", "B"])).toContain(
      "\u2713 Task 1/2 completed",
    );

    const doneLines = diffProgress(
      { phase: "reviewing" },
      { phase: "done", totalTasks: 2 },
      [],
    );
    expect(doneLines).toContain(
      "\u2713 pi-implement complete: 2 task(s) completed",
    );
  });

  it("emits run-level blocked notice with reason", () => {
    const prev: RunState = { phase: "coding" };
    const next: RunState = { phase: "blocked", lastReason: "dirty worktree" };
    const lines = diffProgress(prev, next, []);
    expect(lines).toContain("\u2717 pi-implement blocked: dirty worktree");
  });

  it("emits run-level stopped notice", () => {
    const prev: RunState = { phase: "coding" };
    const next: RunState = { phase: "stopped" };
    const lines = diffProgress(prev, next, []);
    expect(lines).toContain("\u23f9 pi-implement stopped");
  });

  it("includes parallel satisfied summary lines", () => {
    const prev: RunState = {
      phase: "reviewing",
      tasks: [{ id: "t1", planIndex: 0, title: "A", status: "reviewing" }],
      totalCount: 1,
    };
    const next: RunState = {
      ...prev,
      tasks: [{ id: "t1", planIndex: 0, title: "A", status: "satisfied" }],
    };
    expect(diffProgress(prev, next, [])).toContain(
      "\u2713 Task 1/1 satisfied: A",
    );
  });

  it("includes parallel landed summary lines", () => {
    const prev: RunState = {
      phase: "scheduling",
      tasks: [
        {
          id: "t1",
          planIndex: 0,
          title: "A",
          status: "landed",
          landedCommitSha: "aaa",
        },
        { id: "t2", planIndex: 1, title: "B", status: "coding" },
      ],
      landedCount: 1,
      totalCount: 3,
    };
    const next: RunState = {
      ...prev,
      tasks: [
        {
          id: "t1",
          planIndex: 0,
          title: "A",
          status: "landed",
          landedCommitSha: "aaa",
        },
        {
          id: "t2",
          planIndex: 1,
          title: "B",
          status: "landed",
          landedCommitSha: "bbb",
        },
      ],
      landedCount: 2,
    };
    const lines = diffProgress(prev, next, []);
    expect(lines).toContain("✓ Task 2/3 landed: B @ bbb");
  });

  it("uses the plan task number for parallel status notes", () => {
    const prev: RunState = {
      phase: "coding",
      totalCount: 5,
      tasks: [{ id: "t1", planIndex: 0, title: "A", status: "coding" }],
    };
    const next: RunState = {
      ...prev,
      tasks: [{ id: "t1", planIndex: 0, title: "A", status: "approved" }],
    };

    expect(diffProgress(prev, next, [])).toContain("✓ Task 1/5 approved: A");
  });

  it("includes checkpoint notes alongside existing run-level notes", () => {
    const prev: RunState = { phase: "coding", checkpointQueue: [] };
    const next: RunState = {
      phase: "committing",
      checkpointQueue: ["\u00b7 Task 1/1 committing: feat: do thing"],
    };
    const lines = diffProgress(prev, next, ["Do thing"]);
    expect(lines).toContain("\u00b7 Task 1/1 committing: feat: do thing");
  });

  it("emits run-level followup_required notice with reason", () => {
    const prev: RunState = { phase: "final_review" };
    const next: RunState = {
      phase: "followup_required",
      lastReason: "missing edge-case tests",
    };
    const lines = diffProgress(prev, next, []);
    expect(lines).toContain(
      "⚠ pi-implement follow-up required: missing edge-case tests",
    );
  });

  it("emits final_rework phase label", () => {
    const prev: RunState = { phase: "final_review" };
    const next: RunState = { phase: "final_rework" };
    const lines = diffProgress(prev, next, []);
    expect(lines).toContain("· reworking overall");
  });

  it("uses checkpointSequence when bounded history drops older entries", () => {
    const prev: RunState = {
      phase: "coding",
      checkpointSequence: 29,
      checkpointQueue: ["checkpoint 5", "checkpoint 6"],
    };
    const next: RunState = {
      phase: "coding",
      checkpointSequence: 31,
      checkpointQueue: ["checkpoint 7", "checkpoint 30", "checkpoint 31"],
    };
    expect(diffProgress(prev, next, [])).toEqual([
      "checkpoint 30",
      "checkpoint 31",
    ]);
  });

  it("emits strategy selection note for serial mode", () => {
    const prev: RunState = { phase: "strategy" };
    const next: RunState = {
      phase: "preflight",
      mode: "serial",
      lastReason: "Only one unchecked task; no parallelism needed.",
    };
    const lines = diffProgress(prev, next, ["A"]);
    expect(lines).toContain(
      "✓ selected serial implementation: Only one unchecked task; no parallelism needed.",
    );
  });

  it("emits strategy selection note for parallel mode with concurrency", () => {
    const prev: RunState = { phase: "strategy" };
    const next: RunState = {
      phase: "preflight",
      mode: "parallel",
      maxConcurrency: 3,
      lastReason: "Planner recommended parallel: independent task groups",
    };
    const lines = diffProgress(prev, next, ["A"]);
    expect(lines).toContain(
      "✓ selected parallel implementation (max 3): Planner recommended parallel: independent task groups",
    );
  });
});
