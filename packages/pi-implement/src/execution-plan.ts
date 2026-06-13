import {
  detectCycle,
  extractJsonObject,
  type CycleNode,
  type ScoutDirective,
} from "./graph.js";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
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
  sourceReferences: string[];
  compiledContract: CompiledContract;
  scout?: ScoutDirective;
  validationCommands?: string[];
  reasons?: string[];
  evidencePaths?: string[];
  sourceCheckbox?: SourceCheckboxRef;
};

export type ExecutionManifest = {
  version: 1;
  sourcePlanHash?: string;
  sourcePlanPath?: string;
  plannerReason?: string;
  plannerConfidence?: "high" | "medium" | "low";
  maxConcurrency?: number;
  tasks: ExecutionTask[];
};

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
  for (const rawTask of obj.tasks) {
    const taskResult = parseExecutionTask(rawTask);
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

  const validation = validateExecutionManifest(manifest);
  if (!validation.ok) {
    return validation;
  }

  return { ok: true, value: manifest };
}

function parseExecutionTask(
  value: unknown,
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

  const sourceReferences = parseStringArray(obj.sourceReferences);
  if (sourceReferences === undefined) {
    return {
      ok: false,
      reason: `Execution task "${id}" sourceReferences must be an array of strings.`,
    };
  }

  if (
    typeof obj.planIndex !== "number" ||
    !Number.isInteger(obj.planIndex) ||
    obj.planIndex < 1
  ) {
    return {
      ok: false,
      reason: `Execution task "${id}" must have a positive integer planIndex.`,
    };
  }

  if (typeof obj.taskHash !== "string" || obj.taskHash.trim().length === 0) {
    return {
      ok: false,
      reason: `Execution task "${id}" must have a non-empty string taskHash.`,
    };
  }

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

  const scoutResult = parseScoutDirective(obj.scout);
  if (scoutResult !== undefined && !scoutResult.ok) {
    return { ok: false, reason: scoutResult.reason };
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
      planIndex: obj.planIndex,
      title: obj.title.trim(),
      taskHash: obj.taskHash.trim(),
      status: obj.status as TaskStatus,
      dependsOn,
      mode: obj.mode as "serial" | "parallel" | undefined,
      review: reviewResult.value,
      affectedAreas,
      conflictHints,
      sourceReferences,
      compiledContract: contractResult.value,
      scout: scoutResult?.value,
      validationCommands,
      reasons,
      evidencePaths,
      sourceCheckbox: sourceCheckboxResult?.value,
    },
  };
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
    return { ok: false, reason: "Execution task scout must be an object." };
  }
  const obj = value as Record<string, unknown>;
  if (obj.mode !== "skip" && obj.mode !== "suggest" && obj.mode !== "require") {
    return {
      ok: false,
      reason: `Execution task scout mode must be "skip", "suggest", or "require", got: ${String(obj.mode)}.`,
    };
  }
  const directive: ScoutDirective = { mode: obj.mode };
  if (obj.reason !== undefined) {
    if (typeof obj.reason !== "string") {
      return {
        ok: false,
        reason: "Execution task scout reason must be a string.",
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
        reason: "Execution task scout prompt must be a string.",
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
        reason: `Execution task scout breadth must be "quick", "medium", or "very thorough", got: ${String(obj.breadth)}.`,
      };
    }
    directive.breadth = obj.breadth;
  }
  return { ok: true, value: directive };
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

  const seenPlanIndexes = new Set<number>();
  for (const task of manifest.tasks) {
    if (seenPlanIndexes.has(task.planIndex)) {
      return {
        ok: false,
        reason: `Duplicate planIndex: ${task.planIndex}.`,
      };
    }
    seenPlanIndexes.add(task.planIndex);
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
  manifest: ExecutionManifest,
  uncheckedTasks: PlanTask[],
): ExecutionValidationResult {
  if (manifest.tasks.length !== uncheckedTasks.length) {
    return {
      ok: false,
      reason: `Manifest has ${manifest.tasks.length} task(s) but plan has ${uncheckedTasks.length} unchecked task(s).`,
    };
  }

  const expectedByIndex = new Map<
    number,
    { title: string; taskHash: string }
  >();
  for (const task of uncheckedTasks) {
    expectedByIndex.set(task.index, {
      title: task.text,
      taskHash: computeTaskFingerprint(task),
    });
  }

  const seenIndexes = new Set<number>();
  for (const task of manifest.tasks) {
    if (seenIndexes.has(task.planIndex)) {
      return {
        ok: false,
        reason: `Duplicate planIndex: ${task.planIndex}.`,
      };
    }
    seenIndexes.add(task.planIndex);

    const expected = expectedByIndex.get(task.planIndex);
    if (!expected) {
      return {
        ok: false,
        reason: `Manifest task "${task.id}" planIndex ${task.planIndex} does not match any unchecked task.`,
      };
    }
    if (task.title !== expected.title) {
      return {
        ok: false,
        reason: `Manifest task "${task.id}" title mismatch: expected "${expected.title}", got "${task.title}".`,
      };
    }
    if (task.taskHash !== expected.taskHash) {
      return {
        ok: false,
        reason: `Manifest task "${task.id}" taskHash mismatch for planIndex ${task.planIndex}.`,
      };
    }
  }

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
