import { detectCycle, extractJsonObject, type CycleNode } from "./graph.js";

export type TaskStatus = "todo" | "done";

export type TaskReviewDirective = {
  mode: "skip" | "suggest" | "require";
  reason?: string;
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
  title: string;
  status: TaskStatus;
  dependsOn: string[];
  review: TaskReviewDirective;
  affectedAreas: string[];
  conflictHints: string[];
  sourceReferences: string[];
  compiledContract: CompiledContract;
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

  const contractResult = parseCompiledContract(obj.compiledContract, id);
  if (!contractResult.ok) {
    return { ok: false, reason: contractResult.reason };
  }

  return {
    ok: true,
    value: {
      id,
      title: obj.title.trim(),
      status: obj.status as TaskStatus,
      dependsOn,
      review: reviewResult.value,
      affectedAreas,
      conflictHints,
      sourceReferences,
      compiledContract: contractResult.value,
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
