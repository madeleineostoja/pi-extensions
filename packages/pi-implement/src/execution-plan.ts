import { detectCycle, extractJsonObject, type CycleNode } from "./graph.js";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { PlanBundleManifest, ReferencedMaterial } from "./manifest.js";
import { computeTaskFingerprint } from "./manifest.js";
import type { PlanTask } from "./plan.js";

export type TaskStatus = "todo" | "done";

export type TaskReviewDirective = {
  mode: "skip" | "suggest" | "require";
  reason?: string;
};

export type SourceCheckboxRef = {
  path: string;
  lineNumber: number;
  lineText: string;
};

export type SourceRef = {
  path: string;
  quote?: string;
};

export type SourceMaterialOrigin =
  | "task-anchor"
  | "task-link"
  | "planner"
  | "needs-material"
  | "fallback";

export type SourceMaterialMode =
  | { kind: "full-file" }
  | { kind: "line-range"; startLine: number; endLine: number };

export type SourceMaterialRef = {
  origin: SourceMaterialOrigin;
  path: string;
  mode: SourceMaterialMode;
  reason: string;
};

const SOURCE_MATERIAL_ORIGINS = new Set<SourceMaterialOrigin>([
  "task-anchor",
  "task-link",
  "planner",
  "needs-material",
  "fallback",
]);

export type CompiledContract = {
  objective: string;
  inScope: string[];
  acceptanceCriteria: string[];
  supportingDesignContext?: string;
  implementationNotes?: string;
  outOfScope: string[];
  verificationGuidance?: string;
};

export type ExecutionTask = {
  id: string;
  planIndex: number;
  title: string;
  taskHash: string;
  status: TaskStatus;
  dependsOn: string[];
  mode?: "serial" | "parallel";
  review: TaskReviewDirective;
  affectedAreas: string[];
  conflictHints: string[];
  sourceRefs?: SourceRef[];
  sourceMaterialRefs?: SourceMaterialRef[];
  sourceReferences: string[];
  compiledContract: CompiledContract;
  validationCommands?: string[];
  reasons?: string[];
  evidencePaths?: string[];
  sourceCheckbox?: SourceCheckboxRef;
};

export type ExecutionManifest = {
  version: 1;
  sourcePlanHash?: string;
  sourcePlanPath?: string;
  sourceCorpusHash?: string;
  plannerReason?: string;
  plannerConfidence?: "high" | "medium" | "low";
  maxConcurrency?: number;
  tasks: ExecutionTask[];
};

export function buildTaskAnchorSourceMaterialRef(
  task: PlanTask,
  planPath: string,
): SourceMaterialRef {
  return {
    origin: "task-anchor",
    path: planPath,
    mode: {
      kind: "line-range",
      startLine: task.lineNumber,
      endLine: task.lineNumber + task.blockLines.length,
    },
    reason: "Selected task checkbox line and task block.",
  };
}

export function buildDeterministicSourceMaterialRefs(
  task: PlanTask,
  planPath: string,
  manifest?: PlanBundleManifest,
): SourceMaterialRef[] {
  return [
    buildTaskAnchorSourceMaterialRef(task, planPath),
    ...taskLinkMaterialsForTask(task, manifest).map((material) => ({
      origin: "task-link" as const,
      path: material.absolutePath,
      mode: { kind: "full-file" as const },
      reason:
        "Explicit local Markdown material linked from the selected task block.",
    })),
  ];
}

function taskLinkMaterialsForTask(
  task: PlanTask,
  manifest: PlanBundleManifest | undefined,
): ReferencedMaterial[] {
  return (
    manifest?.tasks
      .find((entry) => entry.planIndex === task.index)
      ?.referencedMaterials.filter(
        (material) =>
          material.origin === "plan-link" || material.origin === "task-link",
      ) ?? []
  );
}

export function renderTaskAnchorMaterial(
  task: PlanTask,
  planPath: string,
): string {
  const ref = buildTaskAnchorSourceMaterialRef(task, planPath);
  const content = [task.originalLine, ...task.blockLines].join("\n");
  const fence = markdownFenceFor(content);
  const range =
    ref.mode.kind === "line-range"
      ? `${ref.mode.startLine}-${ref.mode.endLine}`
      : "full-file";

  return `## Selected Task Source Anchor\n\nThe following source excerpt is deterministic anchor material for the selected task. It preserves the raw checkbox line and task block from the source plan for recovery, but it does not expand the implementation scope beyond the compiled task contract.\n\nSource: ${ref.path} lines ${range} (origin: ${ref.origin})\n\n${fence}text\n${content}\n${fence}\n`;
}

function markdownFenceFor(content: string): string {
  let fence = "~~~";
  while (content.includes(fence)) {
    fence += "~";
  }
  return fence;
}

export type ExecutionValidationResult =
  | { ok: true }
  | { ok: false; reason: string };

export function parseExecutionPlan(
  text: string,
): { ok: true; value: ExecutionManifest } | { ok: false; reason: string } {
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
    return { ok: false, reason: "Execution plan JSON must be an object." };
  }

  const obj = parsed as Record<string, unknown>;

  if (obj.version !== 1) {
    return {
      ok: false,
      reason: `Execution plan version must be 1, got: ${String(obj.version)}.`,
    };
  }

  if (!Array.isArray(obj.tasks)) {
    return { ok: false, reason: "Execution plan must include a tasks array." };
  }

  const tasks: ExecutionTask[] = [];
  for (let i = 0; i < obj.tasks.length; i++) {
    const taskResult = parseExecutionTask(obj.tasks[i], i + 1);
    if (!taskResult.ok) {
      return taskResult;
    }
    tasks.push(taskResult.value);
  }

  const manifest: ExecutionManifest = {
    version: 1,
    tasks,
  };

  if (typeof obj.sourcePlanHash === "string") {
    manifest.sourcePlanHash = obj.sourcePlanHash.trim();
  }
  if (typeof obj.sourcePlanPath === "string") {
    manifest.sourcePlanPath = obj.sourcePlanPath.trim();
  }
  if (typeof obj.sourceCorpusHash === "string") {
    manifest.sourceCorpusHash = obj.sourceCorpusHash.trim();
  }
  if (typeof obj.plannerReason === "string") {
    manifest.plannerReason = obj.plannerReason.trim();
  }
  if (
    obj.plannerConfidence === "high" ||
    obj.plannerConfidence === "medium" ||
    obj.plannerConfidence === "low"
  ) {
    manifest.plannerConfidence = obj.plannerConfidence;
  }
  if (
    typeof obj.maxConcurrency === "number" &&
    Number.isInteger(obj.maxConcurrency) &&
    obj.maxConcurrency > 0
  ) {
    manifest.maxConcurrency = obj.maxConcurrency;
  }

  return { ok: true, value: manifest };
}

function parseExecutionTask(
  value: unknown,
  fallbackPlanIndex: number,
): { ok: true; value: ExecutionTask } | { ok: false; reason: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, reason: "Execution task must be an object." };
  }
  const obj = value as Record<string, unknown>;

  if (typeof obj.id !== "string" || obj.id.trim().length === 0) {
    return {
      ok: false,
      reason: "Execution task must have a non-empty string id.",
    };
  }
  const id = obj.id.trim();

  if (typeof obj.title !== "string" || obj.title.trim().length === 0) {
    return {
      ok: false,
      reason: `Execution task "${id}" must have a non-empty string title.`,
    };
  }

  if (obj.status !== "todo" && obj.status !== "done") {
    return {
      ok: false,
      reason: `Execution task "${id}" status must be "todo" or "done", got: ${String(obj.status)}.`,
    };
  }

  const dependsOn = parseStringArray(obj.dependsOn);
  if (dependsOn === undefined) {
    return {
      ok: false,
      reason: `Execution task "${id}" dependsOn must be an array of strings.`,
    };
  }

  const reviewResult = parseTaskReviewDirective(obj.review);
  if (reviewResult === undefined) {
    return {
      ok: false,
      reason: `Execution task "${id}" review is required.`,
    };
  }
  if (!reviewResult.ok) {
    return { ok: false, reason: reviewResult.reason };
  }

  const affectedAreas = parseStringArray(obj.affectedAreas);
  if (affectedAreas === undefined) {
    return {
      ok: false,
      reason: `Execution task "${id}" affectedAreas must be an array of strings.`,
    };
  }

  const conflictHints = parseStringArray(obj.conflictHints);
  if (conflictHints === undefined) {
    return {
      ok: false,
      reason: `Execution task "${id}" conflictHints must be an array of strings.`,
    };
  }

  const parsedSourceReferences = parseStringArray(obj.sourceReferences);
  if (
    obj.sourceReferences !== undefined &&
    parsedSourceReferences === undefined
  ) {
    return {
      ok: false,
      reason: `Execution task "${id}" sourceReferences must be an array of strings.`,
    };
  }

  const sourceReferences = parsedSourceReferences ?? [];
  const sourceRefsResult = parseSourceRefs(obj.sourceRefs, sourceReferences);
  if (!sourceRefsResult.ok) {
    return { ok: false, reason: sourceRefsResult.reason };
  }

  const sourceMaterialRefsResult = parseSourceMaterialRefs(
    obj.sourceMaterialRefs,
    id,
  );
  if (sourceMaterialRefsResult !== undefined && !sourceMaterialRefsResult.ok) {
    return { ok: false, reason: sourceMaterialRefsResult.reason };
  }

  const planIndex =
    typeof obj.planIndex === "number" &&
    Number.isInteger(obj.planIndex) &&
    obj.planIndex >= 1
      ? obj.planIndex
      : fallbackPlanIndex;

  const taskHash =
    typeof obj.taskHash === "string" && obj.taskHash.trim().length > 0
      ? obj.taskHash.trim()
      : `planner-owned:${id}`;

  if (
    obj.mode !== undefined &&
    obj.mode !== "serial" &&
    obj.mode !== "parallel"
  ) {
    return {
      ok: false,
      reason: `Execution task "${id}" mode must be "serial" or "parallel", got: ${String(obj.mode)}.`,
    };
  }

  const validationCommands = parseStringArray(obj.validationCommands);
  if (
    validationCommands === undefined &&
    obj.validationCommands !== undefined
  ) {
    return {
      ok: false,
      reason: `Execution task "${id}" validationCommands must be an array of strings.`,
    };
  }

  const reasons = parseStringArray(obj.reasons);
  if (reasons === undefined && obj.reasons !== undefined) {
    return {
      ok: false,
      reason: `Execution task "${id}" reasons must be an array of strings.`,
    };
  }

  const evidencePaths = parseStringArray(obj.evidencePaths);
  if (evidencePaths === undefined && obj.evidencePaths !== undefined) {
    return {
      ok: false,
      reason: `Execution task "${id}" evidencePaths must be an array of strings.`,
    };
  }

  const sourceCheckboxResult = parseSourceCheckbox(obj.sourceCheckbox);
  if (sourceCheckboxResult !== undefined && !sourceCheckboxResult.ok) {
    return { ok: false, reason: sourceCheckboxResult.reason };
  }

  const contractResult = parseCompiledContract(obj.compiledContract, id);
  if (!contractResult.ok) {
    return { ok: false, reason: contractResult.reason };
  }

  return {
    ok: true,
    value: {
      id,
      planIndex,
      title: obj.title.trim(),
      taskHash,
      status: obj.status as TaskStatus,
      dependsOn,
      mode: obj.mode as "serial" | "parallel" | undefined,
      review: reviewResult.value,
      affectedAreas,
      conflictHints,
      sourceRefs: sourceRefsResult.value,
      sourceMaterialRefs: sourceMaterialRefsResult?.value,
      sourceReferences,
      compiledContract: contractResult.value,
      validationCommands,
      reasons,
      evidencePaths,
      sourceCheckbox: sourceCheckboxResult?.value,
    },
  };
}

function parseSourceRefs(
  value: unknown,
  legacyReferences: string[],
): { ok: true; value: SourceRef[] } | { ok: false; reason: string } {
  if (value === undefined) {
    return {
      ok: true,
      value: legacyReferences.map((ref) => ({ path: ref })),
    };
  }
  if (!Array.isArray(value)) {
    return { ok: false, reason: "Execution task sourceRefs must be an array." };
  }
  const refs: SourceRef[] = [];
  for (const item of value) {
    if (typeof item === "string") {
      const trimmed = item.trim();
      if (trimmed.length > 0) {
        refs.push({ path: trimmed });
      }
      continue;
    }
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      return {
        ok: false,
        reason: "Execution task sourceRefs entries must be strings or objects.",
      };
    }
    const obj = item as Record<string, unknown>;
    if (typeof obj.path !== "string" || obj.path.trim().length === 0) {
      return {
        ok: false,
        reason:
          "Execution task sourceRefs entries must include a non-empty path.",
      };
    }
    const ref: SourceRef = { path: obj.path.trim() };
    if (typeof obj.quote === "string" && obj.quote.trim().length > 0) {
      ref.quote = obj.quote.trim();
    }
    refs.push(ref);
  }
  return { ok: true, value: refs };
}

function parseSourceMaterialRefs(
  value: unknown,
  taskId: string,
):
  | { ok: true; value: SourceMaterialRef[] }
  | { ok: false; reason: string }
  | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    return {
      ok: false,
      reason: `Execution task "${taskId}" sourceMaterialRefs must be an array.`,
    };
  }

  const refs: SourceMaterialRef[] = [];
  for (let i = 0; i < value.length; i++) {
    const item = value[i];
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      return {
        ok: false,
        reason: `Execution task "${taskId}" sourceMaterialRefs[${i}] must be an object.`,
      };
    }

    const obj = item as Record<string, unknown>;
    if (
      typeof obj.origin !== "string" ||
      !SOURCE_MATERIAL_ORIGINS.has(obj.origin as SourceMaterialOrigin)
    ) {
      return {
        ok: false,
        reason: `Execution task "${taskId}" sourceMaterialRefs[${i}] origin must be one of: ${Array.from(SOURCE_MATERIAL_ORIGINS).join(", ")}.`,
      };
    }
    if (typeof obj.path !== "string" || obj.path.trim().length === 0) {
      return {
        ok: false,
        reason: `Execution task "${taskId}" sourceMaterialRefs[${i}] path must be a non-empty string.`,
      };
    }
    if (typeof obj.reason !== "string" || obj.reason.trim().length === 0) {
      return {
        ok: false,
        reason: `Execution task "${taskId}" sourceMaterialRefs[${i}] reason must be a non-empty string.`,
      };
    }
    if (
      typeof obj.mode !== "object" ||
      obj.mode === null ||
      Array.isArray(obj.mode)
    ) {
      return {
        ok: false,
        reason: `Execution task "${taskId}" sourceMaterialRefs[${i}] mode must be an object with kind "full-file" or "line-range".`,
      };
    }

    const mode = obj.mode as Record<string, unknown>;
    if (mode.kind === "full-file") {
      refs.push(obj as SourceMaterialRef);
      continue;
    }

    if (mode.kind !== "line-range") {
      return {
        ok: false,
        reason: `Execution task "${taskId}" sourceMaterialRefs[${i}] mode.kind must be "full-file" or "line-range", got: ${String(mode.kind)}.`,
      };
    }
    if (!isValidLineSpan(mode.startLine, mode.endLine)) {
      return {
        ok: false,
        reason: `Execution task "${taskId}" sourceMaterialRefs[${i}] with mode.kind "line-range" must include positive integer startLine and endLine with endLine greater than or equal to startLine.`,
      };
    }
    refs.push(obj as SourceMaterialRef);
  }

  return { ok: true, value: refs };
}

function isValidLineSpan(start: unknown, end: unknown): boolean {
  return (
    typeof start === "number" &&
    Number.isInteger(start) &&
    start >= 1 &&
    typeof end === "number" &&
    Number.isInteger(end) &&
    end >= start
  );
}

function parseSourceCheckbox(
  value: unknown,
):
  | { ok: true; value: SourceCheckboxRef }
  | { ok: false; reason: string }
  | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {
      ok: false,
      reason: "Execution task sourceCheckbox must be an object.",
    };
  }
  const obj = value as Record<string, unknown>;
  if (typeof obj.path !== "string" || obj.path.trim().length === 0) {
    return {
      ok: false,
      reason: "Execution task sourceCheckbox path must be a non-empty string.",
    };
  }
  if (
    typeof obj.lineNumber !== "number" ||
    !Number.isInteger(obj.lineNumber) ||
    obj.lineNumber < 1
  ) {
    return {
      ok: false,
      reason:
        "Execution task sourceCheckbox lineNumber must be a positive integer.",
    };
  }
  if (typeof obj.lineText !== "string") {
    return {
      ok: false,
      reason: "Execution task sourceCheckbox lineText must be a string.",
    };
  }
  return {
    ok: true,
    value: {
      path: obj.path.trim(),
      lineNumber: obj.lineNumber,
      lineText: obj.lineText,
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
    return { ok: false, reason: "Execution task review must be an object." };
  }
  const obj = value as Record<string, unknown>;
  if (obj.mode !== "skip" && obj.mode !== "suggest" && obj.mode !== "require") {
    return {
      ok: false,
      reason: `Execution task review mode must be "skip", "suggest", or "require", got: ${String(obj.mode)}.`,
    };
  }
  const directive: TaskReviewDirective = { mode: obj.mode };
  if (obj.reason !== undefined) {
    if (typeof obj.reason !== "string") {
      return {
        ok: false,
        reason: "Execution task review reason must be a string.",
      };
    }
    const trimmed = obj.reason.trim();
    if (trimmed.length > 0) {
      directive.reason = trimmed;
    }
  }
  return { ok: true, value: directive };
}

function parseCompiledContract(
  value: unknown,
  taskId: string,
): { ok: true; value: CompiledContract } | { ok: false; reason: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {
      ok: false,
      reason: `Execution task "${taskId}" compiledContract must be an object.`,
    };
  }
  const obj = value as Record<string, unknown>;

  if (typeof obj.objective !== "string" || obj.objective.trim().length === 0) {
    return {
      ok: false,
      reason: `Execution task "${taskId}" compiledContract must have a non-empty string objective.`,
    };
  }

  const inScope = parseStringArray(obj.inScope);
  if (inScope === undefined) {
    return {
      ok: false,
      reason: `Execution task "${taskId}" compiledContract inScope must be an array of strings.`,
    };
  }
  if (inScope.length === 0 || inScope.some((s) => s.trim().length === 0)) {
    return {
      ok: false,
      reason: `Execution task "${taskId}" compiledContract inScope must be non-empty and contain only non-blank strings.`,
    };
  }

  const acceptanceCriteria = parseStringArray(obj.acceptanceCriteria);
  if (acceptanceCriteria === undefined) {
    return {
      ok: false,
      reason: `Execution task "${taskId}" compiledContract acceptanceCriteria must be an array of strings.`,
    };
  }
  if (
    acceptanceCriteria.length === 0 ||
    acceptanceCriteria.some((s) => s.trim().length === 0)
  ) {
    return {
      ok: false,
      reason: `Execution task "${taskId}" compiledContract acceptanceCriteria must be non-empty and contain only non-blank strings.`,
    };
  }

  const outOfScope = parseStringArray(obj.outOfScope);
  if (outOfScope === undefined) {
    return {
      ok: false,
      reason: `Execution task "${taskId}" compiledContract outOfScope must be an array of strings.`,
    };
  }
  if (
    outOfScope.length === 0 ||
    outOfScope.some((s) => s.trim().length === 0)
  ) {
    return {
      ok: false,
      reason: `Execution task "${taskId}" compiledContract outOfScope must be non-empty and contain only non-blank strings.`,
    };
  }

  const contract: CompiledContract = {
    objective: obj.objective.trim(),
    inScope,
    acceptanceCriteria,
    outOfScope,
  };

  if (typeof obj.supportingDesignContext === "string") {
    const trimmed = obj.supportingDesignContext.trim();
    if (trimmed.length > 0) {
      contract.supportingDesignContext = trimmed;
    }
  }
  if (typeof obj.implementationNotes === "string") {
    const trimmed = obj.implementationNotes.trim();
    if (trimmed.length > 0) {
      contract.implementationNotes = trimmed;
    }
  }
  if (typeof obj.verificationGuidance === "string") {
    const trimmed = obj.verificationGuidance.trim();
    if (trimmed.length > 0) {
      contract.verificationGuidance = trimmed;
    }
  }

  return { ok: true, value: contract };
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

export function validateExecutionManifest(
  manifest: ExecutionManifest,
): ExecutionValidationResult {
  if (manifest.version !== 1) {
    return {
      ok: false,
      reason: `Execution plan version must be 1, got ${manifest.version}.`,
    };
  }

  if (manifest.tasks.length === 0) {
    return {
      ok: false,
      reason: "Execution plan must contain at least one task.",
    };
  }

  const seenIds = new Set<string>();
  const taskById = new Map<string, ExecutionTask>();

  for (const task of manifest.tasks) {
    if (seenIds.has(task.id)) {
      return { ok: false, reason: `Duplicate task id: "${task.id}".` };
    }
    seenIds.add(task.id);
    taskById.set(task.id, task);
  }

  for (const task of manifest.tasks) {
    for (const depId of task.dependsOn) {
      if (depId === task.id) {
        return {
          ok: false,
          reason: `Execution task "${task.id}" depends on itself.`,
        };
      }
      if (!taskById.has(depId)) {
        return {
          ok: false,
          reason: `Execution task "${task.id}" dependsOn unknown id "${depId}".`,
        };
      }
    }
  }

  const cycleResult = detectCycle(manifest.tasks as CycleNode[]);
  if (!cycleResult.ok) {
    return {
      ok: false,
      reason: cycleResult.reason,
    };
  }

  return { ok: true };
}

export function validateManifestAgainstPlan(
  _manifest: ExecutionManifest,
  _uncheckedTasks: PlanTask[],
): ExecutionValidationResult {
  return { ok: true };
}

export function writeExecutionManifest(
  runDir: string,
  manifest: ExecutionManifest,
): void {
  const path = join(runDir, "execution-manifest.json");
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(manifest, null, 2), "utf-8");
  renameSync(tmp, path);
}

export function readExecutionManifest(
  runDir: string,
): ExecutionManifest | undefined {
  const path = join(runDir, "execution-manifest.json");
  if (!existsSync(path)) {
    return undefined;
  }
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as ExecutionManifest;
  } catch {
    return undefined;
  }
}

export function generateMinimalExecutionManifest(
  tasks: PlanTask[],
  planPath: string,
  planBundle?: PlanBundleManifest,
): ExecutionManifest {
  return {
    version: 1,
    tasks: tasks.map((task) => ({
      id: `t${String(task.index).padStart(3, "0")}-${task.text.toLowerCase().replace(/\s+/g, "-")}`,
      planIndex: task.index,
      title: task.text,
      taskHash: computeTaskFingerprint(task),
      status: "todo",
      dependsOn: [],
      review: { mode: "require" },
      affectedAreas: [],
      conflictHints: [],
      sourceRefs: [{ path: planPath, quote: task.text }],
      sourceMaterialRefs: buildDeterministicSourceMaterialRefs(
        task,
        planPath,
        planBundle,
      ),
      sourceReferences: [],
      sourceCheckbox: {
        path: planPath,
        lineNumber: task.lineNumber,
        lineText: task.originalLine,
      },
      compiledContract: {
        objective: task.text,
        inScope: [task.text],
        acceptanceCriteria: ["Task is complete and verified"],
        outOfScope: ["Other tasks"],
      },
    })),
  };
}

export function renderCompiledContract(contract: CompiledContract): string {
  const parts: string[] = [
    "# Task Contract",
    "",
    "## Objective",
    "",
    contract.objective,
    "",
    "## In-Scope Items",
    "",
    ...contract.inScope.map((item) => `- ${item}`),
    "",
    "## Acceptance Criteria",
    "",
    ...contract.acceptanceCriteria.map((c) => `- ${c}`),
    "",
    "## Out-of-Scope Items",
    "",
    ...contract.outOfScope.map((item) => `- ${item}`),
  ];

  if (contract.supportingDesignContext) {
    parts.push(
      "",
      "## Supporting Design Context",
      "",
      contract.supportingDesignContext,
    );
  }
  if (contract.implementationNotes) {
    parts.push("", "## Implementation Notes", "", contract.implementationNotes);
  }
  if (contract.verificationGuidance) {
    parts.push(
      "",
      "## Verification Guidance",
      "",
      contract.verificationGuidance,
    );
  }

  return `${parts.join("\n")}\n`;
}
