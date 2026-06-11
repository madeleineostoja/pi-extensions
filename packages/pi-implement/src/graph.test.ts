import { describe, expect, it } from "vitest";
import { detectCycle, parseStrategyDecision, validateGraph } from "./graph.js";
import type { ImplementGraph, ImplementGraphNode } from "./graph.js";

function makeNode(
  overrides: Partial<ImplementGraphNode> & { id: string; planIndex: number },
): ImplementGraphNode {
  return {
    title: "Task title",
    taskHash: "abc123",
    dependsOn: [],
    mode: "parallel",
    affectedAreas: [],
    conflictHints: [],
    validationCommands: [],
    confidence: "high",
    reasons: [],
    evidencePaths: [],
    ...overrides,
  };
}

function makeGraph(
  nodes: ImplementGraphNode[],
  meta: Partial<ImplementGraph> = {},
): ImplementGraph {
  return {
    version: 1,
    runId: "r20250101-000000",
    baseSha: "abc",
    planPath: "/repo/plan.md",
    planHash: "def",
    nodes,
    ...meta,
  };
}

describe("parseStrategyDecision", () => {
  it("parses a valid serial decision", () => {
    const result = parseStrategyDecision(
      JSON.stringify({
        mode: "serial",
        reason: "Too coupled",
        confidence: "high",
      }),
    );
    expect(result).toEqual({
      ok: true,
      value: { mode: "serial", reason: "Too coupled", confidence: "high" },
    });
  });

  it("parses a valid parallel decision with graph", () => {
    const graph: ImplementGraph = makeGraph([
      makeNode({ id: "t1", planIndex: 1 }),
      makeNode({ id: "t2", planIndex: 2, dependsOn: ["t1"] }),
    ]);
    const decision = {
      mode: "parallel",
      reason: "Independent areas",
      confidence: "medium",
      maxConcurrency: 2,
      graph,
    };
    const result = parseStrategyDecision(JSON.stringify(decision));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.mode).toBe("parallel");
      expect(result.value.maxConcurrency).toBe(2);
      expect(result.value.graph?.nodes).toHaveLength(2);
    }
  });

  it("rejects unknown mode", () => {
    const result = parseStrategyDecision(
      JSON.stringify({ mode: "turbo", reason: "fast", confidence: "high" }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("mode");
    }
  });

  it("rejects unknown confidence", () => {
    const result = parseStrategyDecision(
      JSON.stringify({ mode: "serial", reason: "ok", confidence: "certain" }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("confidence");
    }
  });

  it("rejects missing reason", () => {
    const result = parseStrategyDecision(
      JSON.stringify({ mode: "serial", confidence: "high" }),
    );
    expect(result.ok).toBe(false);
  });

  it("rejects empty reason", () => {
    const result = parseStrategyDecision(
      JSON.stringify({ mode: "serial", reason: "   ", confidence: "high" }),
    );
    expect(result.ok).toBe(false);
  });

  it("rejects non-integer maxConcurrency", () => {
    const result = parseStrategyDecision(
      JSON.stringify({
        mode: "serial",
        reason: "ok",
        confidence: "high",
        maxConcurrency: 1.5,
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("maxConcurrency");
    }
  });

  it("rejects non-positive maxConcurrency", () => {
    const result = parseStrategyDecision(
      JSON.stringify({
        mode: "serial",
        reason: "ok",
        confidence: "high",
        maxConcurrency: 0,
      }),
    );
    expect(result.ok).toBe(false);
  });

  it("rejects non-object input", () => {
    const result = parseStrategyDecision("[1, 2, 3]");
    expect(result.ok).toBe(false);
  });

  it("rejects empty text", () => {
    const result = parseStrategyDecision("no json here");
    expect(result.ok).toBe(false);
  });

  it("rejects graph with wrong version", () => {
    const decision = {
      mode: "parallel",
      reason: "ok",
      confidence: "high",
      graph: { version: 2, nodes: [] },
    };
    const result = parseStrategyDecision(JSON.stringify(decision));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("version");
    }
  });

  it("accepts a single decision embedded in prose or a markdown fence", () => {
    const decision = {
      mode: "serial",
      reason: "too coupled",
      confidence: "high",
    };
    for (const text of [
      `Here is my analysis.\n\n${JSON.stringify(decision)}\n\nDone.`,
      `\`\`\`json\n${JSON.stringify(decision)}\n\`\`\``,
    ]) {
      expect(parseStrategyDecision(text)).toEqual({
        ok: true,
        value: decision,
      });
    }
  });

  it("rejects ambiguous multiple JSON objects", () => {
    const first = { mode: "serial", reason: "first", confidence: "high" };
    const second = { mode: "serial", reason: "second", confidence: "low" };
    const result = parseStrategyDecision(
      `${JSON.stringify(first)}\n${JSON.stringify(second)}`,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("multiple JSON objects");
    }
  });
});

describe("validateGraph", () => {
  it("accepts a valid single-node graph", () => {
    const graph = makeGraph([makeNode({ id: "t1", planIndex: 1 })]);
    expect(validateGraph(graph, [1])).toEqual({ ok: true });
  });

  it("accepts a valid two-node graph with dependency", () => {
    const graph = makeGraph([
      makeNode({ id: "t1", planIndex: 1 }),
      makeNode({ id: "t2", planIndex: 2, dependsOn: ["t1"] }),
    ]);
    expect(validateGraph(graph, [1, 2])).toEqual({ ok: true });
  });

  it("rejects graph version not 1", () => {
    const graph = makeGraph([], { version: 2 as 1 });
    const result = validateGraph(graph, []);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("version");
    }
  });

  it("rejects when node count differs from unchecked task count", () => {
    const graph = makeGraph([makeNode({ id: "t1", planIndex: 1 })]);
    const result = validateGraph(graph, [1, 2]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("node");
    }
  });

  it("rejects duplicate node id", () => {
    const graph = makeGraph([
      makeNode({ id: "t1", planIndex: 1 }),
      makeNode({ id: "t1", planIndex: 2 }),
    ]);
    const result = validateGraph(graph, [1, 2]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("Duplicate node id");
    }
  });

  it("rejects duplicate planIndex", () => {
    const graph = makeGraph([
      makeNode({ id: "t1", planIndex: 1 }),
      makeNode({ id: "t2", planIndex: 1 }),
    ]);
    const result = validateGraph(graph, [1, 2]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("Duplicate planIndex");
    }
  });

  it("rejects planIndex not in unchecked list", () => {
    const graph = makeGraph([makeNode({ id: "t1", planIndex: 5 })]);
    const result = validateGraph(graph, [1]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("planIndex");
    }
  });

  it("rejects dependsOn referencing unknown node", () => {
    const graph = makeGraph([
      makeNode({ id: "t1", planIndex: 1, dependsOn: ["unknown"] }),
    ]);
    const result = validateGraph(graph, [1]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("unknown");
    }
  });

  it("rejects cycle among nodes where earlier depends on later (caught by plan-order check)", () => {
    const graph = makeGraph([
      makeNode({ id: "t1", planIndex: 1, dependsOn: ["t2"] }),
      makeNode({ id: "t2", planIndex: 2 }),
    ]);
    const result = validateGraph(graph, [1, 2]);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBeTruthy();
  });

  it("rejects dependency pointing to a later planIndex", () => {
    const graph = makeGraph([
      makeNode({ id: "t1", planIndex: 1, dependsOn: ["t2"] }),
      makeNode({ id: "t2", planIndex: 2 }),
    ]);
    const result = validateGraph(graph, [1, 2]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("not earlier");
    }
  });

  it("allows two nodes with the same affectedAreas to remain independent", () => {
    const graph = makeGraph([
      makeNode({ id: "t1", planIndex: 1, affectedAreas: ["packages/foo"] }),
      makeNode({ id: "t2", planIndex: 2, affectedAreas: ["packages/foo"] }),
    ]);
    expect(validateGraph(graph, [1, 2])).toEqual({ ok: true });
  });

  it("rejects three-node dependency pointing to later planIndex (caught by plan-order check, not DFS)", () => {
    const graph = makeGraph([
      makeNode({ id: "t1", planIndex: 1, dependsOn: ["t3"] }),
      makeNode({ id: "t2", planIndex: 2, dependsOn: ["t3"] }),
      makeNode({ id: "t3", planIndex: 3 }),
    ]);
    const result = validateGraph(graph, [1, 2, 3]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("not earlier");
    }
  });

  it("rejects self-referencing dependsOn", () => {
    const graph = makeGraph([
      makeNode({ id: "t1", planIndex: 1, dependsOn: ["t1"] }),
    ]);
    const result = validateGraph(graph, [1]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("itself");
    }
  });
});

describe("parseStrategyDecision with review directives", () => {
  it("parses a graph node with review directive", () => {
    const graph = makeGraph([
      makeNode({
        id: "t1",
        planIndex: 1,
        review: { mode: "skip", reason: "docs only" },
      }),
    ]);
    const result = parseStrategyDecision(
      JSON.stringify({
        mode: "parallel",
        reason: "ok",
        confidence: "high",
        graph,
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.graph?.nodes[0].review).toEqual({
        mode: "skip",
        reason: "docs only",
      });
    }
  });

  it("parses a graph node with review mode suggest and no reason", () => {
    const graph = makeGraph([
      makeNode({ id: "t1", planIndex: 1, review: { mode: "suggest" } }),
    ]);
    const result = parseStrategyDecision(
      JSON.stringify({
        mode: "parallel",
        reason: "ok",
        confidence: "high",
        graph,
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.graph?.nodes[0].review).toEqual({ mode: "suggest" });
    }
  });

  it("parses a graph node without review directive", () => {
    const graph = makeGraph([makeNode({ id: "t1", planIndex: 1 })]);
    const result = parseStrategyDecision(
      JSON.stringify({
        mode: "parallel",
        reason: "ok",
        confidence: "high",
        graph,
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.graph?.nodes[0].review).toBeUndefined();
    }
  });

  it("rejects invalid review mode", () => {
    const graph = makeGraph([
      makeNode({
        id: "t1",
        planIndex: 1,
        review: { mode: "maybe" } as never,
      }),
    ]);
    const result = parseStrategyDecision(
      JSON.stringify({
        mode: "parallel",
        reason: "ok",
        confidence: "high",
        graph,
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("review mode");
    }
  });

  it("rejects non-object review directive", () => {
    const graph = makeGraph([
      makeNode({ id: "t1", planIndex: 1, review: "skip" as never }),
    ]);
    const result = parseStrategyDecision(
      JSON.stringify({
        mode: "parallel",
        reason: "ok",
        confidence: "high",
        graph,
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("review must be an object");
    }
  });

  it("rejects non-string review reason", () => {
    const graph = makeGraph([
      makeNode({
        id: "t1",
        planIndex: 1,
        review: { mode: "skip", reason: 123 } as never,
      }),
    ]);
    const result = parseStrategyDecision(
      JSON.stringify({
        mode: "parallel",
        reason: "ok",
        confidence: "high",
        graph,
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("review reason");
    }
  });

  it("trims empty review reason and omits it", () => {
    const graph = makeGraph([
      makeNode({
        id: "t1",
        planIndex: 1,
        review: { mode: "require", reason: "   " },
      }),
    ]);
    const result = parseStrategyDecision(
      JSON.stringify({
        mode: "parallel",
        reason: "ok",
        confidence: "high",
        graph,
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.graph?.nodes[0].review).toEqual({ mode: "require" });
    }
  });
});

describe("parseStrategyDecision with scout directives", () => {
  it("parses a graph node with a full scout directive", () => {
    const graph = makeGraph([
      makeNode({
        id: "t1",
        planIndex: 1,
        scout: {
          mode: "require",
          reason: "broad change",
          prompt: "Find auth patterns",
          breadth: "medium",
        },
      }),
    ]);
    const result = parseStrategyDecision(
      JSON.stringify({
        mode: "parallel",
        reason: "ok",
        confidence: "high",
        graph,
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.graph?.nodes[0].scout).toEqual({
        mode: "require",
        reason: "broad change",
        prompt: "Find auth patterns",
        breadth: "medium",
      });
    }
  });

  it("parses a graph node with scout mode suggest and minimal fields", () => {
    const graph = makeGraph([
      makeNode({ id: "t1", planIndex: 1, scout: { mode: "suggest" } }),
    ]);
    const result = parseStrategyDecision(
      JSON.stringify({
        mode: "parallel",
        reason: "ok",
        confidence: "high",
        graph,
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.graph?.nodes[0].scout).toEqual({ mode: "suggest" });
    }
  });

  it("parses a graph node without scout directive", () => {
    const graph = makeGraph([makeNode({ id: "t1", planIndex: 1 })]);
    const result = parseStrategyDecision(
      JSON.stringify({
        mode: "parallel",
        reason: "ok",
        confidence: "high",
        graph,
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.graph?.nodes[0].scout).toBeUndefined();
    }
  });

  it("rejects invalid scout mode", () => {
    const graph = makeGraph([
      makeNode({
        id: "t1",
        planIndex: 1,
        scout: { mode: "maybe" } as never,
      }),
    ]);
    const result = parseStrategyDecision(
      JSON.stringify({
        mode: "parallel",
        reason: "ok",
        confidence: "high",
        graph,
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("scout mode");
    }
  });

  it("rejects non-object scout directive", () => {
    const graph = makeGraph([
      makeNode({ id: "t1", planIndex: 1, scout: "skip" as never }),
    ]);
    const result = parseStrategyDecision(
      JSON.stringify({
        mode: "parallel",
        reason: "ok",
        confidence: "high",
        graph,
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("scout must be an object");
    }
  });

  it("rejects invalid scout breadth", () => {
    const graph = makeGraph([
      makeNode({
        id: "t1",
        planIndex: 1,
        scout: { mode: "require", breadth: "deep" } as never,
      }),
    ]);
    const result = parseStrategyDecision(
      JSON.stringify({
        mode: "parallel",
        reason: "ok",
        confidence: "high",
        graph,
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("scout breadth");
    }
  });

  it("trims empty scout string fields and omits them", () => {
    const graph = makeGraph([
      makeNode({
        id: "t1",
        planIndex: 1,
        scout: {
          mode: "skip",
          reason: "   ",
          prompt: "   ",
        },
      }),
    ]);
    const result = parseStrategyDecision(
      JSON.stringify({
        mode: "parallel",
        reason: "ok",
        confidence: "high",
        graph,
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.graph?.nodes[0].scout).toEqual({ mode: "skip" });
    }
  });

  it("serializes scout directive through parseStrategyDecision round-trip", () => {
    const graph = makeGraph([
      makeNode({
        id: "t1",
        planIndex: 1,
        scout: { mode: "require", reason: "needs context", breadth: "quick" },
      }),
      makeNode({
        id: "t2",
        planIndex: 2,
        scout: { mode: "skip", reason: "trivial fix" },
      }),
    ]);
    const decision = {
      mode: "parallel" as const,
      reason: "ok",
      confidence: "high" as const,
      graph,
    };
    const result = parseStrategyDecision(JSON.stringify(decision));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.graph?.nodes[0].scout).toEqual({
        mode: "require",
        reason: "needs context",
        breadth: "quick",
      });
      expect(result.value.graph?.nodes[1].scout).toEqual({
        mode: "skip",
        reason: "trivial fix",
      });
    }
  });
});

describe("detectCycle", () => {
  it("returns ok for a graph with no cycles", () => {
    const nodes: ImplementGraphNode[] = [
      makeNode({ id: "a", planIndex: 1 }),
      makeNode({ id: "b", planIndex: 2, dependsOn: ["a"] }),
      makeNode({ id: "c", planIndex: 3, dependsOn: ["b"] }),
    ];
    expect(detectCycle(nodes)).toEqual({ ok: true });
  });

  it("detects a direct cycle between two nodes", () => {
    const nodes: ImplementGraphNode[] = [
      makeNode({ id: "a", planIndex: 1, dependsOn: ["b"] }),
      makeNode({ id: "b", planIndex: 2, dependsOn: ["a"] }),
    ];
    const result = detectCycle(nodes);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("Cycle");
    }
  });

  it("detects a three-node cycle", () => {
    const nodes: ImplementGraphNode[] = [
      makeNode({ id: "a", planIndex: 1, dependsOn: ["c"] }),
      makeNode({ id: "b", planIndex: 2, dependsOn: ["a"] }),
      makeNode({ id: "c", planIndex: 3, dependsOn: ["b"] }),
    ];
    const result = detectCycle(nodes);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("Cycle");
    }
  });
});
