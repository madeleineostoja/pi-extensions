import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

export type ImplementGraphNode = {
  id: string;
  planIndex: number;
  title: string;
  taskHash: string;
  dependsOn: string[];
  /** @deprecated Compatibility input ignored by the execution graph. */
  mode?: "serial" | "parallel";
  affectedAreas: string[];
  conflictHints: string[];
  /**
   * Advisory evidence only — the strategy/graph module never executes these.
   * The integration validator must also ignore them; they are persisted for
   * human reference and future tooling.
   */
  validationCommands: string[];
  confidence: "high" | "medium" | "low";
  reasons: string[];
  evidencePaths: string[];
};

export type ImplementGraph = {
  version: 1;
  runId: string;
  baseSha: string;
  planPath: string;
  planHash: string;
  nodes: ImplementGraphNode[];
};

export type StrategyDecision = {
  mode: "serial" | "parallel";
  reason: string;
  confidence: "high" | "medium" | "low";
  maxConcurrency?: number;
  graph?: ImplementGraph;
};

export type GraphValidationResult =
  | { ok: true }
  | { ok: false; reason: string };

/** @deprecated Planner decisions are superseded by execution manifests. */
export function parseStrategyDecision(
  text: string,
): { ok: true; value: StrategyDecision } | { ok: false; reason: string } {
  const candidate = extractJsonObject(text);
  if (!candidate.ok) {
    return candidate;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate.text);
  } catch {
    return { ok: false, reason: "Planner output is not valid JSON." };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: "Planner JSON must be an object." };
  }
  const value = parsed as Record<string, unknown>;
  if (value.mode !== "serial" && value.mode !== "parallel") {
    return {
      ok: false,
      reason: "Planner JSON mode must be serial or parallel.",
    };
  }
  if (!["high", "medium", "low"].includes(String(value.confidence))) {
    return { ok: false, reason: "Planner JSON confidence is invalid." };
  }
  if (typeof value.reason !== "string" || !value.reason.trim()) {
    return {
      ok: false,
      reason: "Planner JSON must include a non-empty reason string.",
    };
  }
  const decision: StrategyDecision = {
    mode: value.mode,
    reason: value.reason.trim(),
    confidence: value.confidence as StrategyDecision["confidence"],
  };
  if (value.maxConcurrency !== undefined) {
    if (
      typeof value.maxConcurrency !== "number" ||
      !Number.isInteger(value.maxConcurrency) ||
      value.maxConcurrency <= 0
    ) {
      return {
        ok: false,
        reason: "Planner JSON maxConcurrency must be a positive integer.",
      };
    }
    decision.maxConcurrency = value.maxConcurrency;
  }
  if (value.graph !== undefined) {
    const graph = parseLegacyGraph(value.graph);
    if (!graph.ok) {
      return graph;
    }
    decision.graph = graph.value;
  }
  return { ok: true, value: decision };
}

export function extractJsonObject(
  text: string,
): { ok: true; text: string } | { ok: false; reason: string } {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}") && isJson(trimmed)) {
    return { ok: true, text: trimmed };
  }

  const candidates: string[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "{") {
      continue;
    }
    const end = findMatchingBrace(text, i);
    if (end === undefined) {
      continue;
    }
    const candidate = text.slice(i, end + 1).trim();
    if (isJson(candidate)) {
      candidates.push(candidate);
      i = end;
    }
  }

  if (candidates.length === 1) {
    return { ok: true, text: candidates[0] };
  }
  if (candidates.length > 1) {
    return {
      ok: false,
      reason: "Planner output contains multiple JSON objects.",
    };
  }
  return { ok: true, text: trimmed };
}

function parseLegacyGraph(
  value: unknown,
): { ok: true; value: ImplementGraph } | { ok: false; reason: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, reason: "Planner graph must be an object." };
  }
  const graph = value as Record<string, unknown>;
  if (graph.version !== 1) {
    return {
      ok: false,
      reason: `Graph version must be 1, got: ${String(graph.version)}.`,
    };
  }
  if (!Array.isArray(graph.nodes)) {
    return { ok: false, reason: "Graph must include a nodes array." };
  }
  return {
    ok: true,
    value: stripGraphReview(graph as unknown as ImplementGraph),
  };
}

function isJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

function findMatchingBrace(text: string, start: number): number | undefined {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const char = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{") {
      depth++;
    } else if (char === "}") {
      depth--;
      if (depth === 0) {
        return i;
      }
    }
  }

  return undefined;
}

export function validateGraph(
  graph: ImplementGraph,
  _uncheckedPlanIndexes: number[],
): GraphValidationResult {
  if (graph.version !== 1) {
    return {
      ok: false,
      reason: `Graph version must be 1, got ${graph.version}.`,
    };
  }

  const seenIds = new Set<string>();
  const nodeById = new Map<string, ImplementGraphNode>();

  for (const node of graph.nodes) {
    if (seenIds.has(node.id)) {
      return { ok: false, reason: `Duplicate node id: "${node.id}".` };
    }
    seenIds.add(node.id);

    nodeById.set(node.id, node);
  }

  for (const node of graph.nodes) {
    for (const depId of node.dependsOn) {
      if (depId === node.id) {
        return {
          ok: false,
          reason: `Node "${node.id}" depends on itself.`,
        };
      }
      if (!nodeById.has(depId)) {
        return {
          ok: false,
          reason: `Node "${node.id}" dependsOn unknown id "${depId}".`,
        };
      }
    }
  }

  const cycleResult = detectCycle(graph.nodes);
  if (!cycleResult.ok) {
    return cycleResult;
  }

  return { ok: true };
}

export type CycleNode = { id: string; dependsOn: string[] };

export function detectCycle<T extends CycleNode>(
  nodes: T[],
): GraphValidationResult {
  const nodeById = new Map<string, T>(nodes.map((n) => [n.id, n]));
  const WHITE = 0,
    GRAY = 1,
    BLACK = 2;
  const color = new Map<string, number>(nodes.map((n) => [n.id, WHITE]));

  function dfs(id: string): string | undefined {
    color.set(id, GRAY);
    const node = nodeById.get(id);
    if (node) {
      for (const depId of node.dependsOn) {
        const depColor = color.get(depId);
        if (depColor === GRAY) {
          return id;
        }
        if (depColor === WHITE) {
          const result = dfs(depId);
          if (result !== undefined) {
            return result;
          }
        }
      }
    }
    color.set(id, BLACK);
    return undefined;
  }

  for (const node of nodes) {
    if (color.get(node.id) === WHITE) {
      const cycleNode = dfs(node.id);
      if (cycleNode !== undefined) {
        return {
          ok: false,
          reason: `Cycle detected involving node "${cycleNode}".`,
        };
      }
    }
  }

  return { ok: true };
}

export function writeGraphJson(runDir: string, graph: ImplementGraph): void {
  const graphPath = join(runDir, "graph.json");
  mkdirSync(dirname(graphPath), { recursive: true });
  const tmp = `${graphPath}.tmp.${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(stripGraphReview(graph), null, 2), "utf-8");
  renameSync(tmp, graphPath);
}

export function readGraphJson(runDir: string): ImplementGraph | undefined {
  const graphPath = join(runDir, "graph.json");
  if (!existsSync(graphPath)) {
    return undefined;
  }
  try {
    return stripGraphReview(
      JSON.parse(readFileSync(graphPath, "utf-8")) as ImplementGraph,
    );
  } catch {
    return undefined;
  }
}

function stripGraphReview(graph: ImplementGraph): ImplementGraph {
  return {
    ...graph,
    nodes: graph.nodes.map((node) => {
      const { review: _review, ...rest } = node as ImplementGraphNode & {
        review?: unknown;
      };
      return rest;
    }),
  };
}
