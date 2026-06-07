import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { isAbsolute, join as joinPath, relative } from "node:path";
import { promisify } from "node:util";
import type { ParsedPlan, PlanTask } from "./plan.js";
import type { PlanBundleManifest } from "./manifest.js";
import { formatBundleMaterial, PlanMaterialSizeError } from "./manifest.js";
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
  manifest?: PlanBundleManifest;
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

  // Auto mode: run cheap triage call
  const triageResult = await runTriage(req, unchecked);
  if (triageResult.decision === "serial") {
    return {
      mode: "serial",
      reason: triageResult.reason,
      maxConcurrency,
      ...outcomeMeta,
    };
  }

  return runGraphPlanner(req, unchecked, maxConcurrency);
}

export function extractSurfaceAreas(taskText: string): string[] {
  const areas = new Set<string>();

  const pathLike = taskText.match(
    /(?:^|[\s`(])((?:packages|src|docs|lib|test|tests)\/[\w./-]+|[a-zA-Z][\w/-]*\/[\w./-]+\.\w+)(?=[\s`),\n]|$)/g,
  );
  if (pathLike) {
    for (const match of pathLike) {
      const cleaned = match
        .trim()
        .replace(/^[`(]/, "")
        .replace(/[`),$]$/, "");
      if (cleaned) {
        areas.add(normalizeArea(cleaned));
      }
    }
  }

  const backticked = taskText.match(/`([^`]+)`/g);
  if (backticked) {
    for (const match of backticked) {
      const inner = match.slice(1, -1).trim();
      if (
        inner &&
        (inner.includes("/") ||
          /\.\w+$/.test(inner) ||
          inner.startsWith("@") ||
          inner.includes("-"))
      ) {
        areas.add(normalizeArea(inner));
      }
    }
  }

  const surfaceNounTrailer =
    /\b(\w[\w/-]*)\s+(?:model|route|component|document|command|endpoint|test)s?\b/gi;
  for (const m of taskText.matchAll(surfaceNounTrailer)) {
    const noun = m[1];
    if (noun && noun.length > 1) {
      areas.add(normalizeArea(noun));
    }
  }

  return [...areas];
}

function normalizeArea(value: string): string {
  return value.toLowerCase().replaceAll("\\", "/").replace(/\/$/, "");
}

type TriageResult =
  | { decision: "serial"; reason: string }
  | { decision: "escalate-to-planner"; reason: string };

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

async function runTriage(
  req: StrategyRequest,
  unchecked: PlanTask[],
): Promise<TriageResult> {
  const prompt = buildTriagePrompt(req.plan, unchecked, req.manifest);
  let rawResult: string;
  try {
    const id = await req.subagents.spawn({
      type: req.roles.planner.type,
      prompt,
      description: "strategy triage: serial vs escalate-to-planner",
      model: req.roles.planner.model,
    });
    const triageRef: AgentDisplayRef = {
      id,
      role: "triage",
      label: "Triage \u00b7 Analyze plan dependencies",
      startedAt: new Date().toISOString(),
    };
    req.updateState((prev) => addStrategyAgentPatch(prev, triageRef));
    const result = await req.subagents.waitFor(id, req.signal);
    req.updateState((prev) => removeStrategyAgentPatch(prev, id));
    if (result.status !== "completed") {
      return {
        decision: "serial",
        reason: `Triage subagent ${result.status}: ${result.error}; defaulting to serial.`,
      };
    }
    rawResult = result.result;
  } catch (err) {
    req.updateState({ activeSubagentIds: [], activeAgentRefs: [] });
    const message = err instanceof Error ? err.message : String(err);
    return {
      decision: "serial",
      reason: `Triage subagent error: ${message}; defaulting to serial.`,
    };
  }

  return parseTriageOutput(rawResult);
}

export function buildTriagePrompt(
  plan: ParsedPlan,
  unchecked: PlanTask[],
  manifest?: PlanBundleManifest,
): string {
  const taskLines = unchecked
    .map((t) => `- [planIndex=${t.index}] ${t.text}`)
    .join("\n");
  const bundleMaterial = manifest ? formatBundleMaterial(manifest) : "";
  const bundleSection = bundleMaterial
    ? `\n\n## Referenced Plan Material\n\n${bundleMaterial}`
    : "";

  return `You are a strategy triage agent for a code implementation pipeline.

Analyze the following plan tasks and decide whether they should be executed serially (one at a time) or escalated to a graph planner for potential parallel execution.

## Plan

${plan.content}${bundleSection}

## Unchecked Tasks (${unchecked.length})

${taskLines}

## Instructions

Respond with strict JSON only (no prose, no markdown fences) matching exactly:
{"decision":"serial","reason":"..."}
or
{"decision":"escalate-to-planner","reason":"..."}

Choose "serial" if:
- Tasks appear to be tightly coupled or sequential by nature
- Tasks likely touch the same files or systems
- There is insufficient evidence of independent work streams

Choose "escalate-to-planner" only if:
- There are clearly distinct, independent areas of work
- Tasks could reasonably run in parallel without conflict

When in doubt, choose "serial".`;
}

export function parseTriageOutput(text: string): TriageResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.trim());
  } catch {
    return {
      decision: "serial",
      reason: "Triage output is not valid JSON; defaulting to serial.",
    };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {
      decision: "serial",
      reason: "Triage JSON must be an object; defaulting to serial.",
    };
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.decision !== "serial" && obj.decision !== "escalate-to-planner") {
    return {
      decision: "serial",
      reason: `Triage JSON decision must be "serial" or "escalate-to-planner"; defaulting to serial.`,
    };
  }
  const reason =
    typeof obj.reason === "string" && obj.reason.trim()
      ? obj.reason.trim()
      : "Triage selected this strategy.";
  return { decision: obj.decision, reason };
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
    if (err instanceof PlanMaterialSizeError) {
      throw err;
    }
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

  const fileTree = await getFileTreeSummary(req.repoRoot);
  const manifests = await getManifestContents(req.repoRoot);
  const gitStatus = await getFilteredGitStatus(
    req.repoRoot,
    req.manifest?.allArtifactPaths ?? [req.plan.path],
  );
  const evidence = await getTargetedEvidence(req.repoRoot, unchecked);

  const taskHashes = unchecked
    .map(
      (t) =>
        `${t.index}:${createHash("sha256").update(t.text).digest("hex").slice(0, 8)}`,
    )
    .join(" ");

  let bundleSection = "";
  if (req.manifest) {
    const bundle = formatBundleMaterial(req.manifest);
    if (bundle) {
      bundleSection = `\n\n## Referenced Plan Material\n\n${bundle}`;
    }
  }

  return `You are a graph planning agent for a parallel code implementation pipeline.

Your job is to analyze the plan and produce a task dependency graph that enables safe parallel execution.

## Plan

${req.planContent}${bundleSection}

## Unchecked Tasks (${unchecked.length})

${taskLines}

Task hashes: ${taskHashes}

## Repository Info

Repo root: ${req.repoRoot}
Base SHA: ${req.baseSha}

## File Tree (capped at 2000 paths)

${fileTree}

## Package Manifests and Config Files

${manifests}

## Current Git Status (excluding .pi/** and plan artifacts)

${gitStatus}

## Targeted Evidence for Task Areas

${evidence}

## Instructions

Analyze which tasks can run in parallel and which have dependencies.

Dependencies are semantic/business dependencies only — shared files do NOT automatically create dependencies. Use \`conflictHints\` and \`affectedAreas\` to note file overlap without forcing a dependency edge.

For each dependency, it MUST point to a task with a LOWER planIndex (earlier in plan order).

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

If you are not confident in parallel execution, set mode to "serial" and omit the graph.

When in doubt, choose "serial".`;
}

async function getFileTreeSummary(repoRoot: string): Promise<string> {
  const CAP = 2000;
  try {
    const result = await execFileAsync("git", ["ls-files"], {
      cwd: repoRoot,
      maxBuffer: 10 * 1024 * 1024,
    });
    const paths = result.stdout.split("\n").filter(Boolean);
    if (paths.length <= CAP) {
      return paths.join("\n");
    }
    const shown = paths.slice(0, CAP);
    const omitted = paths.length - CAP;
    return `${shown.join("\n")}\n... (${omitted} more paths omitted)`;
  } catch {
    return "(could not list files)";
  }
}

const MANIFEST_PATTERNS = [
  "package.json",
  "tsconfig*.json",
  "vitest.config.*",
  ".eslintrc*",
  ".prettierrc*",
  "eslint.config.*",
  "prettier.config.*",
  "oxlint*",
  ".oxlintrc*",
];

async function getManifestContents(repoRoot: string): Promise<string> {
  try {
    const result = await execFileAsync(
      "git",
      ["ls-files", ...MANIFEST_PATTERNS],
      {
        cwd: repoRoot,
        maxBuffer: 1 * 1024 * 1024,
      },
    );
    const files = result.stdout.split("\n").filter(Boolean).slice(0, 20);
    const contents = files.map((file) => {
      try {
        const content = readFileSync(joinPath(repoRoot, file), "utf-8");
        return `### ${file}\n\`\`\`\n${content.trim()}\n\`\`\``;
      } catch {
        return null;
      }
    });
    const parts = contents.filter((c): c is string => c !== null);
    return parts.length ? parts.join("\n\n") : "(no manifest files found)";
  } catch {
    return "(no manifest files found)";
  }
}

async function getFilteredGitStatus(
  repoRoot: string,
  planArtifacts: string[] = [],
): Promise<string> {
  const repoPlanArtifacts = new Set(
    planArtifacts
      .map((path) => repoRelativePath(repoRoot, path))
      .filter((path): path is string => path !== undefined),
  );
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
      if (repoPlanArtifacts.has(filePath)) {
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

async function getTargetedEvidence(
  repoRoot: string,
  unchecked: PlanTask[],
): Promise<string> {
  const areas = new Set<string>();
  for (const task of unchecked) {
    for (const area of extractSurfaceAreas(task.text)) {
      areas.add(area);
    }
  }

  if (areas.size === 0) {
    return "(no distinct surface areas identified)";
  }

  const areaList = [...areas].slice(0, 10);
  const areaResults = await Promise.all(
    areaList.map((area) => getAreaEvidence(repoRoot, area)),
  );
  const parts = areaResults.filter((p): p is string => p !== null);
  return parts.length
    ? parts.join("\n\n")
    : "(no evidence found for identified areas)";
}

async function getAreaEvidence(
  repoRoot: string,
  area: string,
): Promise<string | null> {
  try {
    const result = await execFileAsync("git", ["ls-files", "--", `*${area}*`], {
      cwd: repoRoot,
      maxBuffer: 256 * 1024,
    });
    const paths = result.stdout.split("\n").filter(Boolean).slice(0, 20);
    if (!paths.length) {
      return null;
    }
    const header = `### Area: ${area}\nMatching paths:\n${paths.map((p) => `  ${p}`).join("\n")}`;
    const excerptPaths = paths.slice(0, 5).filter(shouldIncludeExcerpt);
    const excerpts = await Promise.all(
      excerptPaths.map((filePath) => getFileExcerpt(repoRoot, filePath)),
    );
    const excerptParts = excerpts.filter((e): e is string => e !== null);
    return [header, ...excerptParts].join("\n\n");
  } catch {
    return null;
  }
}

async function getFileExcerpt(
  repoRoot: string,
  filePath: string,
): Promise<string | null> {
  try {
    const content = await execFileAsync("git", ["show", `HEAD:${filePath}`], {
      cwd: repoRoot,
      maxBuffer: 32 * 1024,
    });
    const excerpt = content.stdout.split("\n").slice(0, 30).join("\n").trim();
    return excerpt
      ? `#### Excerpt: ${filePath}\n\`\`\`\n${excerpt}\n\`\`\``
      : null;
  } catch {
    return null;
  }
}

function shouldIncludeExcerpt(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return (
    lower.endsWith(".ts") ||
    lower.endsWith(".js") ||
    lower.endsWith(".json") ||
    lower.endsWith(".md")
  );
}
