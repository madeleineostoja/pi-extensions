import { describe, expect, it } from "vitest";
import type { ImplementGraph } from "./graph.js";
import {
  createSchedulerRun,
  computeReadyTasks,
  canStartTask,
  startTask,
  nextTaskToLand,
  countActiveCodingReviewing,
  anyActiveSerialTask,
  allTasksTerminal,
  anyTaskFailedBlockedStopped,
  getBlockedReason,
} from "./scheduler.js";

function makeGraph(nodes: ImplementGraph["nodes"]): ImplementGraph {
  return {
    version: 1,
    runId: "r1",
    baseSha: "abc",
    planPath: "/plan.md",
    planHash: "hash",
    nodes,
  };
}

function makeNode(
  id: string,
  planIndex: number,
  dependsOn: string[] = [],
  mode: "serial" | "parallel" = "parallel",
): ImplementGraph["nodes"][number] {
  return {
    id,
    planIndex,
    title: `Task ${id}`,
    taskHash: "h",
    dependsOn,
    mode,
    affectedAreas: [],
    conflictHints: [],
    validationCommands: [],
    confidence: "high",
    reasons: [],
    evidencePaths: [],
  };
}

describe("scheduler readiness", () => {
  it("pending task with all dependencies landed becomes ready", () => {
    const graph = makeGraph([makeNode("a", 1), makeNode("b", 2, ["a"])]);
    const run = createSchedulerRun(graph, 2);
    run.tasks.get("a")!.status = "landed";
    expect(computeReadyTasks(run)).toEqual(["b"]);
    expect(canStartTask(run, "b")).toBe(true);
  });

  it("pending task with unlanded dependency remains blocked", () => {
    const graph = makeGraph([makeNode("a", 1), makeNode("b", 2, ["a"])]);
    const run = createSchedulerRun(graph, 2);
    expect(computeReadyTasks(run)).toEqual(["a"]);
    expect(canStartTask(run, "b")).toBe(false);
    expect(getBlockedReason(run.tasks.get("b")!, run)).toBe("waiting for a");
  });

  it("no more than maxConcurrency tasks are coding/reviewing", () => {
    const graph = makeGraph([
      makeNode("a", 1),
      makeNode("b", 2),
      makeNode("c", 3),
    ]);
    const run = createSchedulerRun(graph, 2);
    startTask(run, "a");
    startTask(run, "b");
    expect(countActiveCodingReviewing(run)).toBe(2);
    expect(canStartTask(run, "c")).toBe(false);
    expect(getBlockedReason(run.tasks.get("c")!, run)).toBe(
      "concurrency limit",
    );
  });

  it("serial tasks do not run concurrently with other active tasks", () => {
    const graph = makeGraph([makeNode("a", 1, [], "serial"), makeNode("b", 2)]);
    const run = createSchedulerRun(graph, 3);
    startTask(run, "a");
    expect(anyActiveSerialTask(run)).toBe(true);
    expect(canStartTask(run, "b")).toBe(false);
    expect(getBlockedReason(run.tasks.get("b")!, run)).toBe(
      "waiting for serial task",
    );
  });

  it("parallel tasks wait when a serial task is active", () => {
    const graph = makeGraph([
      makeNode("a", 1, [], "parallel"),
      makeNode("b", 2, [], "serial"),
    ]);
    const run = createSchedulerRun(graph, 3);
    startTask(run, "a");
    expect(canStartTask(run, "b")).toBe(false);
  });

  it("ready tasks sorted by plan index", () => {
    const graph = makeGraph([
      makeNode("c", 3),
      makeNode("a", 1),
      makeNode("b", 2),
    ]);
    const run = createSchedulerRun(graph, 3);
    expect(computeReadyTasks(run)).toEqual(["a", "b", "c"]);
  });
});

describe("landing queue", () => {
  it("offers approved tasks in plan order", () => {
    const graph = makeGraph([
      makeNode("a", 1),
      makeNode("b", 2),
      makeNode("c", 3),
    ]);
    const run = createSchedulerRun(graph, 3);
    run.tasks.get("a")!.status = "approved";
    run.tasks.get("b")!.status = "approved";
    expect(nextTaskToLand(run)).toBe("a");
  });

  it("lands an approved task when its dependencies are landed even if an earlier-index task is not", () => {
    const graph = makeGraph([makeNode("a", 1), makeNode("b", 2)]);
    const run = createSchedulerRun(graph, 3);
    run.tasks.get("b")!.status = "approved";
    expect(nextTaskToLand(run)).toBe("b");
  });

  it("waits when an approved task's own dependency is unlanded", () => {
    const graph = makeGraph([makeNode("a", 1), makeNode("b", 2, ["a"])]);
    const run = createSchedulerRun(graph, 3);
    run.tasks.get("b")!.status = "approved";
    expect(nextTaskToLand(run)).toBe(undefined);
  });

  it("returns undefined when no approved tasks", () => {
    const graph = makeGraph([makeNode("a", 1)]);
    const run = createSchedulerRun(graph, 3);
    expect(nextTaskToLand(run)).toBe(undefined);
  });

  it("skips already integrating task and returns next approved", () => {
    const graph = makeGraph([makeNode("a", 1), makeNode("b", 2)]);
    const run = createSchedulerRun(graph, 3);
    run.tasks.get("a")!.status = "integrating";
    run.tasks.get("b")!.status = "approved";
    expect(nextTaskToLand(run)).toBe(undefined);
  });
});

describe("terminal detection", () => {
  it("allTasksTerminal true when all landed", () => {
    const graph = makeGraph([makeNode("a", 1), makeNode("b", 2)]);
    const run = createSchedulerRun(graph, 3);
    run.tasks.get("a")!.status = "landed";
    run.tasks.get("b")!.status = "landed";
    expect(allTasksTerminal(run)).toBe(true);
  });

  it("allTasksTerminal false when coding in progress", () => {
    const graph = makeGraph([makeNode("a", 1)]);
    const run = createSchedulerRun(graph, 3);
    run.tasks.get("a")!.status = "coding";
    expect(allTasksTerminal(run)).toBe(false);
  });

  it("anyTaskFailedBlockedStopped detects failures", () => {
    const graph = makeGraph([makeNode("a", 1), makeNode("b", 2)]);
    const run = createSchedulerRun(graph, 3);
    run.tasks.get("a")!.status = "failed";
    run.tasks.get("b")!.status = "landed";
    expect(anyTaskFailedBlockedStopped(run)).toBe(true);
  });

  it("anyTaskFailedBlockedStopped false for clean completion", () => {
    const graph = makeGraph([makeNode("a", 1)]);
    const run = createSchedulerRun(graph, 3);
    run.tasks.get("a")!.status = "landed";
    expect(anyTaskFailedBlockedStopped(run)).toBe(false);
  });
});
