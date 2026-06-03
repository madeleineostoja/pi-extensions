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

  it("emits run-level done notice", () => {
    const prev: RunState = { phase: "integrating" };
    const next: RunState = { phase: "done" };
    const lines = diffProgress(prev, next, []);
    expect(lines).toContain("\u2713 pi-implement complete");
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

  it("includes parallel landed summary lines", () => {
    const prev: RunState = {
      phase: "scheduling",
      tasks: [
        {
          id: "t1",
          planIndex: 1,
          title: "A",
          status: "landed",
          landedCommitSha: "aaa",
        },
        { id: "t2", planIndex: 2, title: "B", status: "coding" },
      ],
      landedCount: 1,
      totalCount: 3,
    };
    const next: RunState = {
      ...prev,
      tasks: [
        {
          id: "t1",
          planIndex: 1,
          title: "A",
          status: "landed",
          landedCommitSha: "aaa",
        },
        {
          id: "t2",
          planIndex: 2,
          title: "B",
          status: "landed",
          landedCommitSha: "bbb",
        },
      ],
      landedCount: 2,
    };
    const lines = diffProgress(prev, next, []);
    expect(lines.some((l) => l.includes("landed"))).toBe(true);
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
});
