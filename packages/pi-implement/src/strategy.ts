import { execFile } from "node:child_process";
import { isAbsolute, relative } from "node:path";
import { promisify } from "node:util";
import type { ParsedPlan, PlanTask } from "./plan.js";
import type { PlanBundleManifest } from "./manifest.js";
import {
  computeTaskFingerprint,
  formatBundleMaterial,
  PlanMaterialSizeError,
} from "./manifest.js";
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
  parseExecutionPlan,
  validateExecutionManifest,
  validateManifestAgainstPlan,
  writeExecutionManifest,
  type ExecutionManifest,
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

  return processExecutionPlannerResult(
    rawResult,
    req,
    unchecked,
    maxConcurrency,
  );
}

function processExecutionPlannerResult(
  rawResult: string,
  req: StrategyRequest,
  unchecked: PlanTask[],
  _maxConcurrency: number,
): StrategyOutcome {
  const parsed = parseExecutionPlan(rawResult);
  if (!parsed.ok) {
    return {
      mode: "blocked",
      reason: `Planner output invalid: ${parsed.reason}.`,
    };
  }

  const manifest = parsed.value;

  const structuralValidation = validateExecutionManifest(manifest);
  if (!structuralValidation.ok) {
    return {
      mode: "blocked",
      reason: `Execution manifest validation failed: ${structuralValidation.reason}.`,
    };
  }

  const planValidation = validateManifestAgainstPlan(manifest, unchecked);
  if (!planValidation.ok) {
    return {
      mode: "blocked",
      reason: `Execution manifest plan mismatch: ${planValidation.reason}.`,
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
      scout: task.scout,
    })),
  };

  const uncheckedIndexes = unchecked.map((t) => t.index);
  const graphValidation = validateGraph(graph, uncheckedIndexes);
  if (!graphValidation.ok) {
    return {
      mode: "blocked",
      reason: `Dependency graph validation failed: ${graphValidation.reason}.`,
    };
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

  const taskHashes = unchecked
    .map((t) => `${t.index}:${computeTaskFingerprint(t)}`)
    .join(" ");

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

Task fingerprints: ${taskHashes}

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

- Use \`dependsOn\` only for concrete semantic or business dependencies where a later task genuinely requires an earlier task's output. Each dependency MUST point to a node with a LOWER planIndex.
- Do NOT add dependency edges merely because tasks share files, packages, subsystems, test suites, or infrastructure. Shared surface areas are not automatic dependencies. Record those as \`conflictHints\`, \`affectedAreas\`, or integration risk in \`reasons\` and \`evidencePaths\` instead.
- Do not choose serial because of insufficient evidence, possible file conflicts, or shared systems. If uncertainty remains after bounded exploration, prefer the least restrictive graph supported by concrete dependencies, lower confidence, and explain the risk.

## Response Format

Respond with strict JSON only. Your final response must begin with { and end with }. Do not include markdown fences, analysis, or any text outside the JSON.

Return an execution manifest matching this schema:

{
  "version": 1,
  "sourcePlanHash": "${req.planHash}",
  "sourcePlanPath": "${req.plan.path}",
  "plannerReason": "...",
  "plannerConfidence": "high" | "medium" | "low",
  "maxConcurrency": <optional positive integer>,
  "tasks": [
    {
      "id": "unique-node-id",
      "planIndex": <integer matching task planIndex>,
      "title": "task title",
      "taskHash": "full task fingerprint from Task fingerprints above",
      "status": "todo",
      "dependsOn": ["other-node-id"],
      "mode": "parallel",
      "affectedAreas": ["packages/foo"],
      "conflictHints": [],
      "validationCommands": [],
      "reasons": ["why this task is scoped this way"],
      "evidencePaths": [],
      "review": { "mode": "skip" | "suggest" | "require", "reason": "optional" },
      "scout": { "mode": "skip" | "suggest" | "require", "reason": "optional", "prompt": "optional", "breadth": "quick" | "medium" | "very thorough" },
      "sourceReferences": ["plan.md section X", "sub.md line Y"],
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

## Source Checkbox References

Each task may include an optional "sourceCheckbox" field to enable the orchestrator to update the human-readable source plan after a task is completed. This preserves progress visibility in the source plan without making Markdown checkboxes the canonical execution state.

- Include "sourceCheckbox" when the task maps to a single, unambiguous checkbox line in the source plan (normal single-file plans and index-file plans).
- "path" — the absolute or relative path to the source plan file containing the checkbox.
- "lineNumber" — the 1-based line number of the checkbox line in the file.
- "lineText" — the exact text of the checkbox line at planning time, including the "[ ]" marker.
- Omit "sourceCheckbox" when the task does not map to a single checkbox line (e.g., multi-file plans, generated plans, or ambiguous mappings).
- The orchestrator will update the checkbox only when the recorded lineNumber still exactly matches the recorded lineText (modulo checkbox marker state). If the line has changed, the update is skipped to avoid corrupting the source file.

## Scout Directives

Each task may include an optional advisory "scout" field to guide runtime just-in-time exploration before the implementer begins a task. These directives are advisory hints, not authoritative guarantees. The runtime may override them based on config, retry state, and current worktree state.

- "require" — the runtime should run a read-only Scout before this task attempt. Use for broad or ambiguous tasks where early context would materially help the implementer.
- "suggest" — Scout is preferred but may be skipped if the runtime policy says otherwise or the task is trivial.
- "skip" — the planner believes this task needs no Scout exploration. Use for narrow, obvious, or docs-only tasks.
- "prompt" — an optional custom Scout prompt or question. The runtime may include it in the Scout request.
- "breadth" — optional exploration depth hint: "quick" for a few file lookups, "medium" for targeted search, "very thorough" for broad repo tracing.

Omit "scout" entirely when you have no strong opinion.

Important: Scout directives are for future runtime hints only. Do not perform or claim durable repo exploration at planning time. The codebase will change before the task runs. Do not assert that Scout results are already known unless supported by the bounded exploration you performed for strategy decisions.

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
