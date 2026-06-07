import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { isAbsolute, relative } from "node:path";
import { promisify } from "node:util";
import type { ParsedPlan, PlanTask } from "./plan.js";
import type { ImplementConfig } from "./config.js";
import { resolveMaxParallel } from "./config.js";
import type { SubagentClient } from "./subagents.js";
import type { EffectiveRoles } from "./config.js";
import type { StatePaths } from "./state.js";
import type { AgentDisplayRef, RunState, StatePatch } from "./status.js";
import {
  parseStrategyDecision,
  validateGraph,
  writeGraphJson,
} from "./graph.js";
import type { ImplementGraph } from "./graph.js";

const execFileAsync = promisify(execFile);

export type StrategyOutcome =
  | {
      mode: "serial";
      reason: string;
      maxConcurrency: number;
      requestedMode: "auto" | "serial" | "parallel";
      requestedConcurrency: number | undefined;
    }
  | {
      mode: "parallel";
      reason: string;
      maxConcurrency: number;
      requestedMode: "auto" | "serial" | "parallel";
      requestedConcurrency: number | undefined;
      graph: ImplementGraph;
    };

export type StrategyRequest = {
  plan: ParsedPlan;
  planContent: string;
  planHash: string;
  repoRoot: string;
  baseSha: string;
  config: ImplementConfig;
  roles: EffectiveRoles;
  subagents: SubagentClient;
  paths: StatePaths;
  runId: string;
  requestedMode: "auto" | "serial" | "parallel";
  requestedConcurrency?: number;
  signal?: AbortSignal;
  updateState(state: StatePatch): void;
};

export async function selectStrategy(
  req: StrategyRequest,
): Promise<StrategyOutcome> {
  const unchecked = req.plan.tasks.filter((t) => !t.checked);
  const maxConcurrency = resolveMaxParallel(
    req.config,
    req.requestedConcurrency,
  );

  const outcomeMeta = {
    requestedMode: req.requestedMode,
    requestedConcurrency: req.requestedConcurrency,
  };

  if (req.requestedMode === "serial") {
    return {
      mode: "serial",
      reason: "Serial mode requested via --serial.",
      maxConcurrency,
      ...outcomeMeta,
    };
  }

  if (unchecked.length === 0) {
    return {
      mode: "serial",
      reason: "No unchecked tasks; nothing to run.",
      maxConcurrency,
      ...outcomeMeta,
    };
  }

  if (unchecked.length === 1) {
    return {
      mode: "serial",
      reason: "Only one unchecked task; no parallelism needed.",
      maxConcurrency,
      ...outcomeMeta,
    };
  }

  if (req.requestedMode === "parallel") {
    return runGraphPlanner(req, unchecked, maxConcurrency);
  }

  // Auto mode with two or more unchecked tasks: use the graph planner directly
  return runGraphPlanner(req, unchecked, maxConcurrency);
}

function addStrategyAgentPatch(
  prev: RunState,
  ref: AgentDisplayRef,
): Partial<RunState> {
  return {
    activeSubagentId: ref.id,
    activeSubagentIds: [
      ...(prev.activeSubagentIds ?? []).filter((id) => id !== ref.id),
      ref.id,
    ],
    activeAgentRefs: [
      ...(prev.activeAgentRefs ?? []).filter(
        (existing) => existing.id !== ref.id,
      ),
      ref,
    ],
  };
}

function removeStrategyAgentPatch(
  prev: RunState,
  id: string,
): Partial<RunState> {
  const activeSubagentIds = (prev.activeSubagentIds ?? []).filter(
    (existing) => existing !== id,
  );
  return {
    activeSubagentId:
      prev.activeSubagentId === id
        ? activeSubagentIds.at(-1)
        : prev.activeSubagentId,
    activeSubagentIds,
    activeAgentRefs: (prev.activeAgentRefs ?? []).filter(
      (ref) => ref.id !== id,
    ),
  };
}

async function runGraphPlanner(
  req: StrategyRequest,
  unchecked: PlanTask[],
  maxConcurrency: number,
): Promise<StrategyOutcome> {
  const outcomeMeta = {
    requestedMode: req.requestedMode,
    requestedConcurrency: req.requestedConcurrency,
  };

  let prompt: string;
  try {
    prompt = await buildGraphPlannerPrompt(req, unchecked);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      mode: "serial",
      reason: `Could not build graph planner prompt: ${message}; defaulting to serial.`,
      maxConcurrency,
      ...outcomeMeta,
    };
  }

  let rawResult: string;
  try {
    const id = await req.subagents.spawn({
      type: req.roles.planner.type,
      prompt,
      description: "graph planner: build task dependency graph",
      model: req.roles.planner.model,
    });
    const plannerRef: AgentDisplayRef = {
      id,
      role: "planner",
      label: "Planner \u00b7 Select implementation strategy",
      startedAt: new Date().toISOString(),
    };
    req.updateState((prev) => addStrategyAgentPatch(prev, plannerRef));
    const result = await req.subagents.waitFor(id, req.signal);
    req.updateState((prev) => removeStrategyAgentPatch(prev, id));
    if (result.status !== "completed") {
      return {
        mode: "serial",
        reason: `Graph planner subagent ${result.status}: ${result.error}; defaulting to serial.`,
        maxConcurrency,
        ...outcomeMeta,
      };
    }
    rawResult = result.result;
  } catch (err) {
    req.updateState({ activeSubagentIds: [], activeAgentRefs: [] });
    const message = err instanceof Error ? err.message : String(err);
    return {
      mode: "serial",
      reason: `Graph planner subagent error: ${message}; defaulting to serial.`,
      maxConcurrency,
      ...outcomeMeta,
    };
  }

  return processGraphPlannerResult(rawResult, req, unchecked, maxConcurrency);
}

function processGraphPlannerResult(
  rawResult: string,
  req: StrategyRequest,
  unchecked: PlanTask[],
  maxConcurrency: number,
): StrategyOutcome {
  const outcomeMeta = {
    requestedMode: req.requestedMode,
    requestedConcurrency: req.requestedConcurrency,
  };

  const parsed = parseStrategyDecision(rawResult);
  if (!parsed.ok) {
    return {
      mode: "serial",
      reason: `Planner output invalid: ${parsed.reason}; defaulting to serial.`,
      maxConcurrency,
      ...outcomeMeta,
    };
  }

  const decision = parsed.value;

  if (decision.mode === "serial") {
    return {
      mode: "serial",
      reason: `Planner recommended serial: ${decision.reason}`,
      maxConcurrency,
      ...outcomeMeta,
    };
  }

  if (!decision.graph) {
    return {
      mode: "serial",
      reason:
        "Planner recommended parallel but provided no graph; defaulting to serial.",
      maxConcurrency,
      ...outcomeMeta,
    };
  }

  const uncheckedIndexes = unchecked.map((t) => t.index);
  const validation = validateGraph(decision.graph, uncheckedIndexes);
  if (!validation.ok) {
    return {
      mode: "serial",
      reason: `Graph validation failed: ${validation.reason}; defaulting to serial.`,
      maxConcurrency,
      ...outcomeMeta,
    };
  }

  const effectiveConcurrency = clampConcurrency(
    decision.maxConcurrency,
    req.requestedConcurrency,
    req.config,
  );

  const graph: ImplementGraph = {
    ...decision.graph,
    runId: req.runId,
    baseSha: req.baseSha,
    planPath: req.plan.path,
    planHash: req.planHash,
  };

  writeGraphJson(req.paths.runDir, graph);

  return {
    mode: "parallel",
    reason: `Planner recommended parallel: ${decision.reason}`,
    maxConcurrency: effectiveConcurrency,
    graph,
    ...outcomeMeta,
  };
}

function clampConcurrency(
  plannerProposed: number | undefined,
  requested: number | undefined,
  config: ImplementConfig,
): number {
  const HARD_MAX = 8;
  const fromConfig = config.maxParallel ?? 3;
  const base = Math.min(fromConfig, HARD_MAX);
  if (plannerProposed !== undefined) {
    return Math.min(plannerProposed, base, requested ?? base);
  }
  if (requested !== undefined) {
    return Math.min(requested, base);
  }
  return base;
}

async function buildGraphPlannerPrompt(
  req: StrategyRequest,
  unchecked: PlanTask[],
): Promise<string> {
  const taskLines = unchecked
    .map((t) => `- [planIndex=${t.index}] ${t.text}`)
    .join("\n");

  const gitStatus = await getFilteredGitStatus(req.repoRoot, req.plan.path);

  const taskHashes = unchecked
    .map(
      (t) =>
        `${t.index}:${createHash("sha256").update(t.text).digest("hex").slice(0, 8)}`,
    )
    .join(" ");

  return `You are a progressive graph planning agent for a parallel code implementation pipeline.

Your job is to analyze the plan and decide whether to run tasks serially or in parallel, and only build a dependency graph when useful independent work exists.

## Plan

${req.planContent}

## Unchecked Tasks (${unchecked.length})

${taskLines}

Task hashes: ${taskHashes}

## Context

Repo root: ${req.repoRoot}
Base SHA: ${req.baseSha}
Plan path: ${req.plan.path}
Plan hash: ${req.planHash}

Current Git Status (excluding .pi/** and plan artifacts):
${gitStatus}

## Progressive Decision Process

1. First, analyze ONLY the plan and unchecked task list. If the tasks clearly form a concrete semantic sequence where each task requires the output of the previous one, return "serial" immediately. Do not explore the repository and do not construct a graph.

2. If serial is not clear, perform minimal targeted exploration using available repository search and read tools to identify likely task surface areas. Use only a few targeted searches or reads per task unless the ambiguity materially affects the strategy decision.

3. Build a dependency graph only if at least two tasks can make independent progress.

## Dependency Rules

- Use \`dependsOn\` only for concrete semantic or business dependencies where a later task genuinely requires an earlier task's output. Each dependency MUST point to a node with a LOWER planIndex.
- Do NOT add dependency edges merely because tasks share files, packages, subsystems, test suites, or infrastructure. Shared surface areas are not automatic dependencies. Record those as \`conflictHints\`, \`affectedAreas\`, or integration risk in \`reasons\` and \`evidencePaths\` instead.
- Do not choose serial because of insufficient evidence, possible file conflicts, or shared systems. If uncertainty remains after bounded exploration, prefer the least restrictive graph supported by concrete dependencies, lower confidence, and explain the risk.

## Response Format

Respond with strict JSON only (no prose, no markdown fences) matching:
{
  "mode": "serial" | "parallel",
  "reason": "...",
  "confidence": "high" | "medium" | "low",
  "maxConcurrency": <optional positive integer>,
  "graph": {
    "version": 1,
    "runId": "",
    "baseSha": "",
    "planPath": "",
    "planHash": "",
    "nodes": [
      {
        "id": "unique-node-id",
        "planIndex": <integer matching task planIndex>,
        "title": "task title",
        "taskHash": "short hash",
        "dependsOn": ["other-node-id"],
        "mode": "parallel",
        "affectedAreas": ["packages/foo"],
        "conflictHints": [],
        "validationCommands": [],
        "confidence": "high",
        "reasons": ["why this can run in parallel"],
        "evidencePaths": []
      }
    ]
  }
}

If the correct strategy is serial, set mode to "serial" and omit the graph.`;
}

async function getFilteredGitStatus(
  repoRoot: string,
  planPath?: string,
): Promise<string> {
  const repoPlanPath = planPath
    ? repoRelativePath(repoRoot, planPath)
    : undefined;
  try {
    const result = await execFileAsync(
      "git",
      ["status", "--porcelain", "--", ":/"],
      { cwd: repoRoot, maxBuffer: 1 * 1024 * 1024 },
    );
    const lines = result.stdout.split("\n").filter((line) => {
      if (!line.trim()) {
        return false;
      }
      const filePath = line.slice(3);
      if (filePath.startsWith(".pi/")) {
        return false;
      }
      if (repoPlanPath && filePath === repoPlanPath) {
        return false;
      }
      return true;
    });
    return lines.length > 0 ? lines.join("\n") : "(clean)";
  } catch {
    return "(could not get git status)";
  }
}

function repoRelativePath(repoRoot: string, path: string): string | undefined {
  const candidate = isAbsolute(path) ? relative(repoRoot, path) : path;
  if (!candidate || candidate.startsWith("..") || isAbsolute(candidate)) {
    return undefined;
  }
  return candidate.replaceAll("\\", "/");
}
