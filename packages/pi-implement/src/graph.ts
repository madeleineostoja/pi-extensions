import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

export type GraphNodeMode = "serial" | "parallel";

export type TaskReviewDirective = {
  mode: "skip" | "suggest" | "require";
  reason?: string;
};

export type ScoutDirective = {
  mode: "skip" | "suggest" | "require";
  reason?: string;
  prompt?: string;
  breadth?: "quick" | "medium" | "very thorough";
};

export type ImplementGraphNode = {
  id: string;
  planIndex: number;
  title: string;
  taskHash: string;
  dependsOn: string[];
  mode: GraphNodeMode;
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
  review?: TaskReviewDirective;
  scout?: ScoutDirective;
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
    return {
      ok: false,
      reason: "Planner output is not valid JSON.",
    };
  }
  try {
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return { ok: false, reason: "Planner JSON must be an object." };
    }
    const obj = parsed as Record<string, unknown>;

    if (obj.mode !== "serial" && obj.mode !== "parallel") {
      return {
        ok: false,
        reason: `Planner JSON mode must be "serial" or "parallel", got: ${String(obj.mode)}.`,
      };
    }
    if (
      obj.confidence !== "high" &&
      obj.confidence !== "medium" &&
      obj.confidence !== "low"
    ) {
      return {
        ok: false,
        reason: `Planner JSON confidence must be "high", "medium", or "low", got: ${String(obj.confidence)}.`,
      };
    }
    if (typeof obj.reason !== "string" || obj.reason.trim().length === 0) {
      return {
        ok: false,
        reason: "Planner JSON must include a non-empty reason string.",
      };
    }
    if (
      obj.maxConcurrency !== undefined &&
      !(
        typeof obj.maxConcurrency === "number" &&
        Number.isInteger(obj.maxConcurrency) &&
        obj.maxConcurrency > 0
      )
    ) {
      return {
        ok: false,
        reason: "Planner JSON maxConcurrency must be a positive integer.",
      };
    }

    const decision: StrategyDecision = {
      mode: obj.mode,
      reason: obj.reason.trim(),
      confidence: obj.confidence,
    };
    if (typeof obj.maxConcurrency === "number") {
      decision.maxConcurrency = obj.maxConcurrency;
    }
    if (obj.graph !== undefined) {
      const graphResult = parseImplementGraph(obj.graph);
      if (!graphResult.ok) {
        return graphResult;
      }
      decision.graph = graphResult.value;
    }
    return { ok: true, value: decision };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      reason: `Could not parse planner JSON: ${message}`,
    };
  }
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

function parseImplementGraph(
  value: unknown,
): { ok: true; value: ImplementGraph } | { ok: false; reason: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, reason: "Planner graph must be an object." };
  }
  const obj = value as Record<string, unknown>;
  if (obj.version !== 1) {
    return {
      ok: false,
      reason: `Graph version must be 1, got: ${String(obj.version)}.`,
    };
  }
  if (!Array.isArray(obj.nodes)) {
    return { ok: false, reason: "Graph must include a nodes array." };
  }
  const nodes: ImplementGraphNode[] = [];
  for (const rawNode of obj.nodes) {
    const nodeResult = parseGraphNode(rawNode);
    if (!nodeResult.ok) {
      return nodeResult;
    }
    nodes.push(nodeResult.value);
  }
  return {
    ok: true,
    value: {
      version: 1,
      runId: typeof obj.runId === "string" ? obj.runId : "",
      baseSha: typeof obj.baseSha === "string" ? obj.baseSha : "",
      planPath: typeof obj.planPath === "string" ? obj.planPath : "",
      planHash: typeof obj.planHash === "string" ? obj.planHash : "",
      nodes,
    },
  };
}

function parseGraphNode(
  value: unknown,
): { ok: true; value: ImplementGraphNode } | { ok: false; reason: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, reason: "Graph node must be an object." };
  }
  const obj = value as Record<string, unknown>;
  if (typeof obj.id !== "string" || obj.id.trim().length === 0) {
    return { ok: false, reason: "Graph node must have a non-empty string id." };
  }
  if (
    typeof obj.planIndex !== "number" ||
    !Number.isInteger(obj.planIndex) ||
    obj.planIndex < 1
  ) {
    return {
      ok: false,
      reason: `Graph node "${obj.id}" must have a positive integer planIndex.`,
    };
  }
  if (typeof obj.title !== "string") {
    return {
      ok: false,
      reason: `Graph node "${obj.id}" must have a string title.`,
    };
  }
  if (typeof obj.taskHash !== "string") {
    return {
      ok: false,
      reason: `Graph node "${obj.id}" must have a string taskHash.`,
    };
  }
  if (obj.mode !== "serial" && obj.mode !== "parallel") {
    return {
      ok: false,
      reason: `Graph node "${obj.id}" mode must be "serial" or "parallel".`,
    };
  }
  if (
    obj.confidence !== "high" &&
    obj.confidence !== "medium" &&
    obj.confidence !== "low"
  ) {
    return {
      ok: false,
      reason: `Graph node "${obj.id}" confidence must be "high", "medium", or "low".`,
    };
  }
  const dependsOn = parseStringArray(obj.dependsOn);
  if (dependsOn === undefined) {
    return {
      ok: false,
      reason: `Graph node "${obj.id}" dependsOn must be an array of strings.`,
    };
  }
  const affectedAreas = parseStringArray(obj.affectedAreas) ?? [];
  const conflictHints = parseStringArray(obj.conflictHints) ?? [];
  const validationCommands = parseStringArray(obj.validationCommands) ?? [];
  const reasons = parseStringArray(obj.reasons) ?? [];
  const evidencePaths = parseStringArray(obj.evidencePaths) ?? [];
  const review = parseTaskReviewDirective(obj.review);
  if (review !== undefined && !review.ok) {
    return { ok: false, reason: review.reason };
  }
  const scout = parseScoutDirective(obj.scout);
  if (scout !== undefined && !scout.ok) {
    return { ok: false, reason: scout.reason };
  }

  return {
    ok: true,
    value: {
      id: obj.id.trim(),
      planIndex: obj.planIndex,
      title: obj.title,
      taskHash: obj.taskHash,
      dependsOn,
      mode: obj.mode,
      affectedAreas,
      conflictHints,
      validationCommands,
      confidence: obj.confidence,
      reasons,
      evidencePaths,
      review: review?.value,
      scout: scout?.value,
    },
  };
}

function parseTaskReviewDirective(
  value: unknown,
):
  | { ok: true; value: TaskReviewDirective }
  | { ok: false; reason: string }
  | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, reason: "Graph node review must be an object." };
  }
  const obj = value as Record<string, unknown>;
  if (obj.mode !== "skip" && obj.mode !== "suggest" && obj.mode !== "require") {
    return {
      ok: false,
      reason: `Graph node review mode must be "skip", "suggest", or "require", got: ${String(obj.mode)}.`,
    };
  }
  const directive: TaskReviewDirective = { mode: obj.mode };
  if (obj.reason !== undefined) {
    if (typeof obj.reason !== "string") {
      return {
        ok: false,
        reason: "Graph node review reason must be a string.",
      };
    }
    const trimmed = obj.reason.trim();
    if (trimmed.length > 0) {
      directive.reason = trimmed;
    }
  }
  return { ok: true, value: directive };
}

function parseScoutDirective(
  value: unknown,
):
  | { ok: true; value: ScoutDirective }
  | { ok: false; reason: string }
  | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, reason: "Graph node scout must be an object." };
  }
  const obj = value as Record<string, unknown>;
  if (obj.mode !== "skip" && obj.mode !== "suggest" && obj.mode !== "require") {
    return {
      ok: false,
      reason: `Graph node scout mode must be "skip", "suggest", or "require", got: ${String(obj.mode)}.`,
    };
  }
  const directive: ScoutDirective = { mode: obj.mode };
  if (obj.reason !== undefined) {
    if (typeof obj.reason !== "string") {
      return {
        ok: false,
        reason: "Graph node scout reason must be a string.",
      };
    }
    const trimmed = obj.reason.trim();
    if (trimmed.length > 0) {
      directive.reason = trimmed;
    }
  }
  if (obj.prompt !== undefined) {
    if (typeof obj.prompt !== "string") {
      return {
        ok: false,
        reason: "Graph node scout prompt must be a string.",
      };
    }
    const trimmed = obj.prompt.trim();
    if (trimmed.length > 0) {
      directive.prompt = trimmed;
    }
  }
  if (obj.breadth !== undefined) {
    if (
      obj.breadth !== "quick" &&
      obj.breadth !== "medium" &&
      obj.breadth !== "very thorough"
    ) {
      return {
        ok: false,
        reason: `Graph node scout breadth must be "quick", "medium", or "very thorough", got: ${String(obj.breadth)}.`,
      };
    }
    directive.breadth = obj.breadth;
  }
  return { ok: true, value: directive };
}

function parseStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  if (!value.every((item) => typeof item === "string")) {
    return undefined;
  }
  return value as string[];
}

export function validateGraph(
  graph: ImplementGraph,
  uncheckedPlanIndexes: number[],
): GraphValidationResult {
  if (graph.version !== 1) {
    return {
      ok: false,
      reason: `Graph version must be 1, got ${graph.version}.`,
    };
  }

  if (graph.nodes.length !== uncheckedPlanIndexes.length) {
    return {
      ok: false,
      reason: `Graph has ${graph.nodes.length} node(s) but plan has ${uncheckedPlanIndexes.length} unchecked task(s).`,
    };
  }

  const seenIds = new Set<string>();
  const seenIndexes = new Set<number>();
  const uncheckedSet = new Set(uncheckedPlanIndexes);
  const nodeById = new Map<string, ImplementGraphNode>();

  for (const node of graph.nodes) {
    if (seenIds.has(node.id)) {
      return { ok: false, reason: `Duplicate node id: "${node.id}".` };
    }
    seenIds.add(node.id);

    if (seenIndexes.has(node.planIndex)) {
      return {
        ok: false,
        reason: `Duplicate planIndex: ${node.planIndex}.`,
      };
    }
    seenIndexes.add(node.planIndex);

    if (!uncheckedSet.has(node.planIndex)) {
      return {
        ok: false,
        reason: `Node "${node.id}" planIndex ${node.planIndex} does not match any unchecked task.`,
      };
    }

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
      const dep = nodeById.get(depId);
      if (dep && dep.planIndex >= node.planIndex) {
        return {
          ok: false,
          reason: `Node "${node.id}" (planIndex ${node.planIndex}) depends on "${depId}" (planIndex ${dep.planIndex}) which is not earlier in plan order.`,
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
  writeFileSync(tmp, JSON.stringify(graph, null, 2), "utf-8");
  renameSync(tmp, graphPath);
}

export function readGraphJson(runDir: string): ImplementGraph | undefined {
  const graphPath = join(runDir, "graph.json");
  if (!existsSync(graphPath)) {
    return undefined;
  }
  try {
    return JSON.parse(readFileSync(graphPath, "utf-8")) as ImplementGraph;
  } catch {
    return undefined;
  }
}
