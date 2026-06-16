import { execFile } from "node:child_process";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { promisify } from "node:util";
import type { ParsedPlan, PlanTask } from "./plan.js";
import type { PlanBundleManifest } from "./manifest.js";
import { formatBundleMaterial, PlanMaterialSizeError } from "./manifest.js";
import type { PlanCorpus } from "./corpus.js";
import { formatCorpusMaterial } from "./corpus.js";
import type { ImplementConfig } from "./config.js";
import { resolveMaxParallel } from "./config.js";
import type { SubagentClient } from "./subagents.js";
import type { EffectiveRoles } from "./config.js";
import type { StatePaths } from "./state.js";
import type { AgentDisplayRef, RunState, StatePatch } from "./status.js";
import { validateGraph, writeGraphJson } from "./graph.js";
import type { ImplementGraph } from "./graph.js";
import {
  buildDeterministicSourceMaterialRefs,
  parseExecutionPlan,
  generateMinimalExecutionManifest,
  validateExecutionManifest,
  writeExecutionManifest,
  type CompiledContract,
  type ExecutionManifest,
  type ExecutionTask,
  type SourceMaterialRef,
} from "./execution-plan.js";

const execFileAsync = promisify(execFile);

export type StrategyOutcome =
  | {
      mode: "serial";
      reason: string;
      maxConcurrency: number;
    }
  | {
      mode: "parallel";
      reason: string;
      maxConcurrency: number;
      graph: ImplementGraph;
    }
  | {
      mode: "blocked";
      reason: string;
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
  signal?: AbortSignal;
  manifest?: PlanBundleManifest;
  corpus?: PlanCorpus;
  forceSerial?: boolean;
  updateState(state: StatePatch): void;
};

export async function selectStrategy(
  req: StrategyRequest,
): Promise<StrategyOutcome> {
  const unchecked = req.plan.tasks.filter((t) => !t.checked);
  const maxConcurrency = resolveMaxParallel(req.config);

  if (unchecked.length === 0) {
    return {
      mode: "serial",
      reason: "No unchecked tasks; nothing to run.",
      maxConcurrency,
    };
  }

  return runExecutionPlanner(req, unchecked, maxConcurrency);
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

async function runExecutionPlanner(
  req: StrategyRequest,
  unchecked: PlanTask[],
  maxConcurrency: number,
): Promise<StrategyOutcome> {
  let prompt: string;
  try {
    prompt = await buildExecutionPlannerPrompt(req, unchecked);
  } catch (err) {
    if (err instanceof PlanMaterialSizeError) {
      throw err;
    }
    const message = err instanceof Error ? err.message : String(err);
    return {
      mode: "blocked",
      reason: `Could not build execution planner prompt: ${message}.`,
    };
  }

  let rawResult: string;
  try {
    const id = await req.subagents.spawn({
      type: req.roles.planner.type,
      prompt,
      description:
        "execution planner: build task contracts and dependency graph",
      model: req.roles.planner.model,
      thinking: req.roles.planner.thinking,
      role: "planner",
      readOnly: true,
      cwd: req.repoRoot,
    });
    const plannerRef: AgentDisplayRef = {
      id,
      role: "planner",
      label: "Planner \u00b7 Build execution manifest",
      startedAt: new Date().toISOString(),
    };
    req.updateState((prev) => addStrategyAgentPatch(prev, plannerRef));
    const result = await req.subagents.waitFor(id, req.signal);
    req.updateState((prev) => removeStrategyAgentPatch(prev, id));
    if (result.status !== "completed") {
      return {
        mode: "blocked",
        reason: `Execution planner subagent ${result.status}: ${result.error}.`,
      };
    }
    rawResult = result.result;
  } catch (err) {
    req.updateState({ activeSubagentIds: [], activeAgentRefs: [] });
    const message = err instanceof Error ? err.message : String(err);
    return {
      mode: "blocked",
      reason: `Execution planner subagent error: ${message}.`,
    };
  }

  const initialParse = parseExecutionPlan(rawResult);
  if (!initialParse.ok && isMalformedPlannerJsonReason(initialParse.reason)) {
    rawResult = await tryRepairExecutionPlannerOutput(req, rawResult);
  }

  return processExecutionPlannerResult(
    rawResult,
    req,
    unchecked,
    maxConcurrency,
  );
}

function validateExactMaterialRequirements(
  manifest: ExecutionManifest,
): { ok: true } | { ok: false; reason: string } {
  for (const task of manifest.tasks) {
    if (
      requiresExactMaterial(task.compiledContract) &&
      !hasUsableMaterialBeyondTaskAnchor(task)
    ) {
      return {
        ok: false,
        reason: `Execution task "${task.id}" requires exact source material, but no usable rendered material beyond the selected task anchor was resolved.`,
      };
    }
  }
  return { ok: true };
}

function isMalformedPlannerJsonReason(reason: string): boolean {
  return (
    reason.includes("valid JSON") ||
    reason.includes("multiple JSON objects") ||
    reason.includes("No JSON object")
  );
}

async function tryRepairExecutionPlannerOutput(
  req: StrategyRequest,
  rawResult: string,
): Promise<string> {
  const prompt = `The execution planner returned output that could not be parsed as the required JSON manifest.

Repair the formatting only. Preserve the intended tasks, ids, titles, dependencies, contracts, review hints, and source references. Do not add implementation work. Return strict JSON only, beginning with { and ending with }.

Original output:

${rawResult}`;
  let repairId: string | undefined;
  try {
    const id = await req.subagents.spawn({
      type: req.roles.planner.type,
      prompt,
      description: "execution planner: repair manifest JSON",
      model: req.roles.planner.model,
      thinking: req.roles.planner.thinking,
      role: "planner",
      readOnly: true,
      cwd: req.repoRoot,
    });
    repairId = id;
    const plannerRef: AgentDisplayRef = {
      id,
      role: "planner",
      label: "Planner · Repair execution manifest JSON",
      startedAt: new Date().toISOString(),
    };
    req.updateState((prev) => addStrategyAgentPatch(prev, plannerRef));
    const result = await req.subagents.waitFor(id, req.signal);
    req.updateState((prev) => removeStrategyAgentPatch(prev, id));
    if (result.status === "completed" && parseExecutionPlan(result.result).ok) {
      return result.result;
    }
  } catch {
    const id = repairId;
    if (id) {
      req.updateState((prev) => removeStrategyAgentPatch(prev, id));
    }
  }
  return rawResult;
}

function processExecutionPlannerResult(
  rawResult: string,
  req: StrategyRequest,
  unchecked: PlanTask[],
  _maxConcurrency: number,
): StrategyOutcome {
  const parsed = parseExecutionPlan(rawResult);
  let manifest = parsed.ok
    ? normalizePlannerManifest(parsed.value, unchecked, req)
    : fallbackPlannerManifest(
        unchecked,
        req,
        `Planner output invalid: ${parsed.reason}`,
      );

  const groundingValidation = validateManifestGrounding(manifest, req);
  if (!groundingValidation.ok) {
    manifest = fallbackPlannerManifest(
      unchecked,
      req,
      `Execution manifest grounding failed: ${groundingValidation.reason}`,
    );
  }

  const exactMaterialValidation = validateExactMaterialRequirements(manifest);
  if (!exactMaterialValidation.ok) {
    return {
      mode: "blocked",
      reason: exactMaterialValidation.reason,
    };
  }

  let structuralValidation = validateExecutionManifest(manifest);
  if (!structuralValidation.ok) {
    manifest = fallbackPlannerManifest(
      unchecked,
      req,
      `Execution manifest validation failed: ${structuralValidation.reason}`,
    );
    structuralValidation = validateExecutionManifest(manifest);
    if (!structuralValidation.ok) {
      return {
        mode: "blocked",
        reason: `Fallback execution manifest invalid: ${structuralValidation.reason}.`,
      };
    }
  }

  const fallbackGroundingValidation = validateManifestGrounding(manifest, req);
  if (!fallbackGroundingValidation.ok) {
    return {
      mode: "blocked",
      reason: `Execution manifest grounding failed: ${fallbackGroundingValidation.reason}.`,
    };
  }

  const effectiveConcurrency = req.forceSerial
    ? 1
    : clampConcurrency(manifest.maxConcurrency, req.config);

  const graph: ImplementGraph = {
    version: 1,
    runId: req.runId,
    baseSha: req.baseSha,
    planPath: req.plan.path,
    planHash: req.planHash,
    nodes: manifest.tasks.map((task) => ({
      id: task.id,
      planIndex: task.planIndex,
      title: task.title,
      taskHash: task.taskHash,
      dependsOn: task.dependsOn,
      mode: task.mode ?? "parallel",
      affectedAreas: task.affectedAreas,
      conflictHints: task.conflictHints,
      validationCommands: task.validationCommands ?? [],
      confidence: "medium",
      reasons: task.reasons ?? [],
      evidencePaths: task.evidencePaths ?? [],
      review: task.review,
    })),
  };

  const uncheckedIndexes = unchecked.map((t) => t.index);
  let graphValidation = validateGraph(graph, uncheckedIndexes);
  if (!graphValidation.ok) {
    const graphValidationReason = graphValidation.reason;
    manifest = serialManifest(manifest, graphValidationReason);
    graph.nodes = manifest.tasks.map((task) => ({
      id: task.id,
      planIndex: task.planIndex,
      title: task.title,
      taskHash: task.taskHash,
      dependsOn: task.dependsOn,
      mode: "serial",
      affectedAreas: task.affectedAreas,
      conflictHints: task.conflictHints,
      validationCommands: task.validationCommands ?? [],
      confidence: "low",
      reasons: [...(task.reasons ?? []), graphValidationReason],
      evidencePaths: task.evidencePaths ?? [],
      review: task.review,
    }));
    graphValidation = validateGraph(graph, uncheckedIndexes);
    if (!graphValidation.ok) {
      return {
        mode: "blocked",
        reason: `Dependency graph validation failed after serial fallback: ${graphValidation.reason}.`,
      };
    }
  }

  writeExecutionManifest(req.paths.runDir, manifest);
  writeGraphJson(req.paths.runDir, graph);

  const mode: "serial" | "parallel" =
    req.forceSerial || effectiveConcurrency === 1 || isSerialChain(manifest)
      ? "serial"
      : "parallel";
  const reason = `Planner built execution manifest: ${manifest.plannerReason ?? "(no reason given)"}${
    req.forceSerial ? "; serial execution was forced" : ""
  }`;

  return {
    mode,
    reason,
    maxConcurrency: effectiveConcurrency,
    graph,
  };
}

function fallbackPlannerManifest(
  unchecked: PlanTask[],
  req: StrategyRequest,
  reason: string,
): ExecutionManifest {
  return {
    ...generateMinimalExecutionManifest(unchecked, req.plan.path, req.manifest),
    sourcePlanHash: req.planHash,
    sourcePlanPath: req.plan.path,
    sourceCorpusHash: req.corpus?.corpusHash,
    plannerReason: `${reason}; using conservative serial fallback.`,
    plannerConfidence: "low",
    maxConcurrency: 1,
  };
}

function normalizeSourceMaterialRefs(
  task: ExecutionTask,
  planTask: PlanTask,
  planPath: string,
  manifest: PlanBundleManifest | undefined,
): SourceMaterialRef[] {
  return [
    ...buildDeterministicSourceMaterialRefs(planTask, planPath, manifest),
    ...(task.sourceMaterialRefs ?? []).map((ref) => ({
      ...ref,
      origin: "planner" as const,
    })),
  ];
}

function contractText(contract: CompiledContract): string {
  return [
    contract.objective,
    ...contract.inScope,
    ...contract.acceptanceCriteria,
    contract.supportingDesignContext,
    contract.implementationNotes,
    ...contract.outOfScope,
    contract.verificationGuidance,
  ]
    .filter((part): part is string => typeof part === "string")
    .join("\n");
}

function requiresExactMaterial(contract: CompiledContract): boolean {
  return /\b(verbatim|exact|fixture|migration|sql|source-of-truth)\b|copy from|copied from|schema below|prompt string|system prompt/i.test(
    contractText(contract),
  );
}

function hasUsableMaterialBeyondTaskAnchor(task: ExecutionTask): boolean {
  return (task.sourceMaterialRefs ?? []).some(
    (ref) => ref.origin !== "task-anchor",
  );
}

function normalizePlannerManifest(
  manifest: ExecutionManifest,
  unchecked: PlanTask[],
  req: StrategyRequest,
): ExecutionManifest {
  if (manifest.tasks.length !== unchecked.length) {
    return fallbackPlannerManifest(
      unchecked,
      req,
      `Planner returned ${manifest.tasks.length} task(s) for ${unchecked.length} unchecked task(s)`,
    );
  }

  const tasks = manifest.tasks.map((task, index) => {
    const mappedPlanTask =
      matchPlannerTaskToPlanTask(task, unchecked) ?? unchecked[index];
    const normalized: ExecutionTask = {
      ...task,
      planIndex: mappedPlanTask?.index ?? task.planIndex,
      taskHash: task.taskHash || `planner-owned:${task.id}`,
      review: task.review ?? { mode: "require" },
      affectedAreas: task.affectedAreas ?? [],
      conflictHints: task.conflictHints ?? [],
      sourceRefs: normalizeSourceRefs(task, req),
      sourceMaterialRefs: mappedPlanTask
        ? normalizeSourceMaterialRefs(
            task,
            mappedPlanTask,
            req.plan.path,
            req.manifest,
          )
        : task.sourceMaterialRefs,
      sourceReferences: task.sourceReferences ?? [],
      compiledContract: task.compiledContract,
    };
    return normalized;
  });

  const uncheckedIndexes = new Set(unchecked.map((task) => task.index));
  const coveredIndexes = new Set(tasks.map((task) => task.planIndex));
  if (
    coveredIndexes.size !== unchecked.length ||
    [...coveredIndexes].some((index) => !uncheckedIndexes.has(index))
  ) {
    return fallbackPlannerManifest(
      unchecked,
      req,
      "Planner task coverage could not be reconciled to unchecked tasks",
    );
  }

  const taskIds = new Set(tasks.map((task) => task.id));
  const invalidDependencyReasons: string[] = [];
  for (const task of tasks) {
    const validDeps: string[] = [];
    for (const depId of task.dependsOn) {
      if (depId === task.id) {
        invalidDependencyReasons.push(`task ${task.id} depends on itself`);
      } else if (!taskIds.has(depId)) {
        invalidDependencyReasons.push(
          `task ${task.id} depends on unknown id ${depId}`,
        );
      } else {
        validDeps.push(depId);
      }
    }
    task.dependsOn = validDeps;
  }

  const repaired: ExecutionManifest = {
    ...manifest,
    sourceCorpusHash: manifest.sourceCorpusHash ?? req.corpus?.corpusHash,
    tasks,
  };
  if (invalidDependencyReasons.length > 0) {
    return serialManifest(repaired, invalidDependencyReasons.join("; "));
  }

  const graphValidation = validateExecutionManifest(repaired);
  if (graphValidation.ok) {
    return repaired;
  }
  if (graphValidation.reason.includes("Cycle detected")) {
    return serialManifest(repaired, graphValidation.reason);
  }
  return repaired;
}

function matchPlannerTaskToPlanTask(
  task: ExecutionTask,
  unchecked: PlanTask[],
): PlanTask | undefined {
  const needles = [
    task.title,
    ...(task.sourceRefs ?? []).map((ref) => ref.quote),
  ]
    .map(normalizeTaskText)
    .filter((value): value is string => value !== undefined);

  const semanticMatches = unchecked.filter((planTask) => {
    const planNeedles = [planTask.text, planTask.originalLine]
      .map(normalizeTaskText)
      .filter((value): value is string => value !== undefined);
    return needles.some((needle) =>
      planNeedles.some(
        (planNeedle) =>
          planNeedle.includes(needle) || needle.includes(planNeedle),
      ),
    );
  });

  if (semanticMatches.length === 1) {
    return semanticMatches[0];
  }

  return unchecked.find((planTask) => planTask.index === task.planIndex);
}

function normalizeTaskText(value: string | undefined): string | undefined {
  const normalized = value
    ?.replace(/^\s*[-*]\s+\[[ xX]\]\s*/, "")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 $2")
    .replace(/[`*_#]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  return normalized && normalized.length >= 3 ? normalized : undefined;
}

function validateManifestGrounding(
  manifest: ExecutionManifest,
  req: StrategyRequest,
): { ok: true } | { ok: false; reason: string } {
  for (const task of manifest.tasks) {
    const refs = task.sourceRefs ?? [];
    if (refs.length === 0) {
      return {
        ok: false,
        reason: `task "${task.id}" has no sourceRefs`,
      };
    }

    let grounded = false;
    const failures: string[] = [];
    for (const ref of refs) {
      const content = readSourceRefContent(ref.path, req);
      if (content === undefined) {
        failures.push(`${ref.path}: file does not exist`);
        continue;
      }
      if (!ref.quote || content.includes(ref.quote)) {
        grounded = true;
        break;
      }
      failures.push(`${ref.path}: quote not found`);
    }

    if (!grounded) {
      return {
        ok: false,
        reason: `task "${task.id}" sourceRefs are not grounded (${failures.join("; ")})`,
      };
    }
  }

  return { ok: true };
}

function readSourceRefContent(
  sourcePath: string,
  req: StrategyRequest,
): string | undefined {
  const candidates = isAbsolute(sourcePath)
    ? [resolve(sourcePath)]
    : [
        resolve(dirname(req.plan.path), sourcePath),
        resolve(req.repoRoot, sourcePath),
      ];

  const materialByPath = new Map<string, string>();
  materialByPath.set(resolve(req.plan.path), req.planContent);
  for (const file of req.corpus?.files ?? []) {
    materialByPath.set(resolve(file.absolutePath), file.content);
  }
  for (const task of req.manifest?.tasks ?? []) {
    for (const material of task.referencedMaterials) {
      materialByPath.set(resolve(material.absolutePath), material.content);
    }
  }

  for (const candidate of candidates) {
    const content = materialByPath.get(candidate);
    if (content !== undefined) {
      return content;
    }
  }
  return undefined;
}

function normalizeSourceRefs(
  task: ExecutionTask,
  req: StrategyRequest,
): ExecutionTask["sourceRefs"] {
  const sourceRefs = task.sourceRefs ?? [];
  const refs =
    sourceRefs.length > 0
      ? sourceRefs
      : task.sourceReferences.map((path) => ({ path }));
  if (refs.length > 0) {
    return refs;
  }
  return [{ path: req.plan.path, quote: task.title }];
}

function serialManifest(
  manifest: ExecutionManifest,
  reason: string,
): ExecutionManifest {
  return {
    ...manifest,
    maxConcurrency: 1,
    tasks: manifest.tasks.map((task, index, tasks) => ({
      ...task,
      mode: "serial",
      dependsOn: index === 0 ? [] : [tasks[index - 1].id],
      reasons: [
        ...(task.reasons ?? []),
        `Dependency graph repaired: ${reason}`,
      ],
    })),
  };
}

function isSerialChain(manifest: ExecutionManifest): boolean {
  if (manifest.tasks.length <= 1) {
    return true;
  }
  // Check if each task (except the first) has exactly one dependency on the previous task in plan order
  const sorted = [...manifest.tasks].sort((a, b) => a.planIndex - b.planIndex);
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const curr = sorted[i];
    if (curr.dependsOn.length !== 1 || curr.dependsOn[0] !== prev.id) {
      return false;
    }
  }
  return true;
}

function clampConcurrency(
  plannerProposed: number | undefined,
  config: ImplementConfig,
): number {
  const HARD_MAX = 8;
  const fromConfig = config.maxParallel ?? 3;
  const base = Math.min(fromConfig, HARD_MAX);
  if (plannerProposed !== undefined) {
    return Math.min(plannerProposed, base);
  }
  return base;
}

async function buildExecutionPlannerPrompt(
  req: StrategyRequest,
  unchecked: PlanTask[],
): Promise<string> {
  const taskLines = unchecked
    .map((t) => `- [planIndex=${t.index}] ${t.text}`)
    .join("\n");

  const gitStatus = await getFilteredGitStatus(
    req.repoRoot,
    req.manifest?.allArtifactPaths ?? [req.plan.path],
  );

  let bundleSection = "";
  if (req.manifest) {
    const bundle = formatBundleMaterial(req.manifest);
    if (bundle) {
      bundleSection = `\n\n## Referenced Plan Material\n\n${bundle}`;
    }
  }

  let corpusSection = "";
  if (req.corpus) {
    const corpus = formatCorpusMaterial(req.corpus);
    if (corpus) {
      corpusSection = `\n\n## Plan Corpus\n\n${corpus}`;
    }
  }

  return `You are an execution planner for a parallel code implementation pipeline.

Your job is to read the full human plan corpus, produce a compiled task contract for each unchecked task, and build a dependency graph that reflects only concrete semantic dependencies.

## Plan

${req.planContent}${bundleSection}${corpusSection}

## Unchecked Tasks (${unchecked.length})

${taskLines}

## Context

Repo root: ${req.repoRoot}
Base SHA: ${req.baseSha}
Plan path: ${req.plan.path}
Plan hash: ${req.planHash}

## Current Git Status (excluding .pi/** and plan artifacts)

${gitStatus}

## Safety Constraints

- This strategy phase is strictly read-only. Do not edit, write, stage, reset, commit, install dependencies, or run mutating commands.
- Repository exploration must use search/read/status commands only.

## Progressive Decision Process

1. First, analyze ONLY the plan and unchecked task list. If the tasks clearly form a concrete semantic sequence where each task requires the output of the previous one, you can still return an execution manifest. Set \`maxConcurrency\` to 1 and/or make \`dependsOn\` form a serial chain.

2. If serial is not clear, perform minimal targeted exploration using available repository search and read tools to identify likely task surface areas. Use only a few targeted searches or reads per task unless the ambiguity materially affects the strategy decision.

3. Build a dependency graph only if at least two tasks can make independent progress.

## Compiled Contract Rules

- Read the full human plan corpus as source material.
- For each task, produce a compiled contract that includes only the selected-task obligations. Do not include sibling deliverables or requirements belonging to other tasks.
- \`inScope\` must be specific, concrete items. Do not use vague phrases like "related changes" or "supporting work".
- \`acceptanceCriteria\` must be verifiable. Each criterion should be independently checkable.
- \`outOfScope\` must explicitly list requirements from other tasks or the broader plan that this task must NOT implement.
- \`supportingDesignContext\` is optional. Use it for design notes, patterns, or constraints from the plan that help the implementer but are not themselves acceptance criteria.
- Keep sibling deliverables out of each task contract. The implementer must not treat another task's acceptance criteria as its own.

## Dependency Rules

- Use \`dependsOn\` only for concrete semantic or business dependencies where a later task genuinely requires an earlier task's output. Dependencies may point to any known task id; do not use plan order as proof of dependency.
- Do NOT add dependency edges merely because tasks share files, packages, subsystems, test suites, or infrastructure. Shared surface areas are not automatic dependencies. Record those as \`conflictHints\`, \`affectedAreas\`, or integration risk in \`reasons\` and \`evidencePaths\` instead.
- Do not choose serial because of insufficient evidence, possible file conflicts, or shared systems. If uncertainty remains after bounded exploration, prefer the least restrictive graph supported by concrete dependencies, lower confidence, and explain the risk.

## Response Format

Respond with strict JSON only. Your final response must begin with { and end with }. Do not include markdown fences, analysis, or any text outside the JSON.

Return an execution manifest matching this schema:

{
  "version": 1,
  "sourcePlanHash": "${req.planHash}",
  "sourcePlanPath": "${req.plan.path}",
  "sourceCorpusHash": "${req.corpus?.corpusHash ?? req.planHash}",
  "plannerReason": "...",
  "plannerConfidence": "high" | "medium" | "low",
  "maxConcurrency": <optional positive integer>,
  "tasks": [
    {
      "id": "unique-node-id",
      "planIndex": <optional integer hint from the unchecked-task list when unambiguous>,
      "title": "task title",
      "status": "todo",
      "dependsOn": ["other-node-id"],
      "mode": "parallel",
      "affectedAreas": ["packages/foo"],
      "conflictHints": [],
      "validationCommands": [],
      "reasons": ["why this task is scoped this way"],
      "evidencePaths": [],
      "review": { "mode": "skip" | "suggest" | "require", "reason": "optional" },
      "sourceRefs": [{ "path": "${req.plan.path}", "quote": "short exact source quote grounding this task" }],
      "sourceMaterialRefs": [
        { "origin": "planner", "path": "absolute-or-relative-source-path.md", "mode": { "kind": "full-file" }, "reason": "why this material is required" },
        { "origin": "planner", "path": "absolute-or-relative-source-path.md", "mode": { "kind": "line-range", "startLine": 10, "endLine": 20 }, "reason": "why this exact range is required" }
      ],
      "sourceCheckbox": { "path": "plan.md", "lineNumber": 5, "lineText": "- [ ] Task title" },
      "compiledContract": {
        "objective": "One-line description of what this task must accomplish",
        "inScope": ["specific requirement 1", "specific requirement 2"],
        "acceptanceCriteria": ["criterion that must be verifiable"],
        "outOfScope": ["sibling task requirement 1", "other task deliverable"],
        "supportingDesignContext": "optional context from the plan that helps implementation but is not part of the acceptance criteria",
        "implementationNotes": "optional hints",
        "verificationGuidance": "optional hints on how to verify"
      }
    }
  ]
}

## Source Material References

Each task may include \`sourceMaterialRefs\` for exact raw materials the implementer and reviewer must see in the task packet. These are packet material, unlike \`sourceRefs\`.

- Include only semantically required full files or line ranges from the plan corpus.
- Use line ranges when only a bounded schema, prompt string, fixture, migration, SQL block, or exact source-of-truth excerpt is required.
- Do not include sibling-task material or broad corpus dumps.
- The orchestrator will union these planner-selected refs with deterministic selected-task anchors and explicit task-link refs, validate them, and skip invalid planner refs before rendering.

## Source References

Each task must include \`sourceRefs\` when possible. A source ref grounds the planner-owned task in the plan corpus without making Markdown syntax canonical:

- \`path\` — use the exact corpus file path when known.
- \`quote\` — include a short exact quote/snippet from that file that supports the task.
- Prefer the checkbox line, linked task heading, or task-file text that identifies the executable work.
- Source refs are grounding evidence only; do not copy Markdown link syntax into the task title unless it is part of the human title.

## Source Checkbox References

Each task may include an optional "sourceCheckbox" field to enable the orchestrator to update the human-readable source plan after a task is completed. This preserves progress visibility in the source plan without making Markdown checkboxes the canonical execution state.

- Include "sourceCheckbox" when the task maps to a single, unambiguous checkbox line in the source plan (normal single-file plans and index-file plans).
- "path" — the absolute or relative path to the source plan file containing the checkbox.
- "lineNumber" — the 1-based line number of the checkbox line in the file.
- "lineText" — the exact text of the checkbox line at planning time, including the "[ ]" marker.
- Omit "sourceCheckbox" when the task does not map to a single checkbox line (e.g., multi-file plans, generated plans, or ambiguous mappings).
- The orchestrator will update the checkbox only when the recorded lineNumber still exactly matches the recorded lineText (modulo checkbox marker state). If the line has changed, the update is skipped to avoid corrupting the source file.

## Exploration Guidance

Do not add per-task exploration directives. Implementer and reviewer workers can call injected explore on demand for broad map-building or targeted context checks when useful, and must keep findings within the compiled task scope.

## Task Review Directives

Each task may include an optional advisory "review" field to guide the runtime task-review policy. These directives are advisory hints, not authoritative guarantees. The runtime may override them based on the actual staged diff, retry state, and validation evidence.

- "require" — the runtime must run per-task review. Use for security/auth, persistence, public API, concurrency/state, migrations, dependency/config changes, broad/multi-area work, low planner confidence, or tasks likely to need subjective correctness review.
- "suggest" — review is preferred; in v1 the runtime may only skip when the actual candidate is strictly docs-only. Use as the safe default when you see some risk but not enough to force "require".
- "skip" — the planner believes the task is skip-eligible, not that skipping is guaranteed. Recommend "skip" only for obviously low-risk tasks such as small docs-only changes or additive fixture/snapshot tasks where an objective runtime check can establish safety.
- Omit "review" entirely when you have no strong opinion; the runtime will default to reviewing.
- Do not base review directives on imagined implementation details you cannot verify. Base them only on the plan text, task scope, and files you have observed.

Do not wrap the JSON in a markdown code fence.`;
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
