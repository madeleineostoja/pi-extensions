import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  countMaterialChars,
  MAX_CORPUS_CHARS,
  MAX_CORPUS_FILES,
  type MaterialStore,
} from "./material-store.js";
import type { ParsedPlan, PlanTask } from "./plan.js";
import { writeAtomicJson } from "./atomic-json.js";
import {
  normalizeCheckboxMarker,
  resolveCorpusPath,
  sha256,
} from "./source-integrity.js";

const ID_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

export type PlannerProvenance = {
  path: string;
  quote: string;
};

export type StrictCompiledContract = {
  objective: string;
  inScope: string[];
  acceptanceCriteria: string[];
  outOfScope: string[];
  supportingDesignContext?: string;
  implementationNotes?: string;
  verificationGuidance?: string;
};

export type PlannerTask = {
  id: string;
  planIndex: number;
  title: string;
  dependsOn: string[];
  provenance: PlannerProvenance[];
  compiledContract: StrictCompiledContract;
};

export type PlannerWorkstream = {
  id: string;
  taskIds: string[];
  dependsOn: string[];
  rationale: string;
  risk: "normal" | "isolated";
};

export type PlannerExecutionPlan = {
  version: 1;
  plannerReason: string;
  plannerConfidence: "high" | "medium" | "low";
  tasks: PlannerTask[];
  workstreams: PlannerWorkstream[];
};

export type SourceTaskAnchor = {
  path: string;
  lineNumber: number;
  lineText: string;
  normalizedLineHash: string;
  blockHash: string;
};

export type CompiledExecutionTask = PlannerTask & {
  taskHash: string;
  sourceAnchor: SourceTaskAnchor;
};

export type ExecutionPlan = {
  version: 1;
  executionPlanHash: string;
  source: {
    planPath: string;
    planHash: string;
    corpusHash: string;
    corpusFiles: Array<{ path: string; hash: string }>;
    checkoutId: string;
    baseSha: string;
  };
  workerConcurrency: number;
  planner: {
    reason: string;
    confidence: "high" | "medium" | "low";
  };
  tasks: CompiledExecutionTask[];
  workstreams: PlannerWorkstream[];
};

export type UncheckedPlanTask = {
  planIndex: number;
  task: PlanTask;
};

export type ExecutionPlanCompilerInput = {
  plan: ParsedPlan;
  planHash: string;
  materialStore: MaterialStore;
  checkoutId: string;
  baseSha: string;
  workerConcurrency: number;
};

export type ExecutionPlanResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: string };

export type ExecutionPlanningOutcome =
  | { kind: "no-op" }
  | { kind: "compiled"; plan: ExecutionPlan };

export type PlannerPacket = {
  role: "planner";
  completionKind: "planner";
  identity: string;
  workspace: {
    path: string;
    mutationBoundary: string;
  };
  planContent: string;
  unchecked: UncheckedPlanTask[];
  corpus: MaterialStore["files"];
  baseSha: string;
  workerConcurrency: number;
};

export function buildPlannerPacket(
  args: ExecutionPlanCompilerInput & {
    workspacePath: string;
    checkoutRoot: string;
    runId: string;
  },
): ExecutionPlanResult<PlannerPacket> {
  const unchecked = uncheckedPlanTasks(args.plan);
  if (unchecked.length === 0) {
    return { ok: false, reason: "Planner packet has no unchecked tasks." };
  }
  const inputValidation = validateExecutionPlanInput(args);
  if (!inputValidation.ok) {
    return {
      ok: false,
      reason: `Planner packet ${args.runId}/planner is invalid: ${inputValidation.reason}`,
    };
  }
  if (resolve(args.workspacePath) !== resolve(args.checkoutRoot)) {
    return {
      ok: false,
      reason: `Planner packet ${args.runId}/planner has an invalid assigned workspace.`,
    };
  }
  return {
    ok: true,
    value: {
      role: "planner",
      completionKind: "planner",
      identity: `${args.runId}/planner`,
      workspace: {
        path: args.workspacePath,
        mutationBoundary: "The target checkout is read-only.",
      },
      planContent: args.plan.content,
      unchecked,
      corpus: args.materialStore.files,
      baseSha: args.baseSha,
      workerConcurrency: args.workerConcurrency,
    },
  };
}

export async function planExecution(
  args: ExecutionPlanCompilerInput & {
    runDir: string;
    workspacePath: string;
    checkoutRoot: string;
    runId: string;
    requestPlanner(packet: PlannerPacket): Promise<unknown>;
  },
): Promise<ExecutionPlanResult<ExecutionPlanningOutcome>> {
  const unchecked = uncheckedPlanTasks(args.plan);
  if (unchecked.length === 0) {
    return { ok: true, value: { kind: "no-op" } };
  }
  const packet = buildPlannerPacket(args);
  if (!packet.ok) {
    return packet;
  }
  const result = await args.requestPlanner(packet.value);
  const compiled = compileExecutionPlan(result, args);
  if (!compiled.ok) {
    return compiled;
  }
  writeExecutionPlan(args.runDir, compiled.value);
  return { ok: true, value: { kind: "compiled", plan: compiled.value } };
}

export function parsePlannerExecutionPlan(
  value: unknown,
): ExecutionPlanResult<PlannerExecutionPlan> {
  const root = object(value, "Execution plan JSON must be an object.");
  if (!root.ok) {
    return root;
  }
  const rootKeys = exactKeys(
    root.value,
    ["version", "plannerReason", "plannerConfidence", "tasks", "workstreams"],
    "Execution plan",
  );
  if (!rootKeys.ok) {
    return rootKeys;
  }
  if (root.value.version !== 1) {
    return failure(
      `Execution plan version must be 1, got: ${String(root.value.version)}.`,
    );
  }
  const plannerReason = nonBlank(
    root.value.plannerReason,
    "Execution plan plannerReason",
  );
  if (!plannerReason.ok) {
    return plannerReason;
  }
  const plannerConfidence = confidence(root.value.plannerConfidence);
  if (!plannerConfidence.ok) {
    return plannerConfidence;
  }
  const tasks = array(root.value.tasks, "Execution plan tasks");
  if (!tasks.ok) {
    return tasks;
  }
  if (tasks.value.length === 0) {
    return failure("Execution plan tasks must not be empty.");
  }
  const workstreams = array(
    root.value.workstreams,
    "Execution plan workstreams",
  );
  if (!workstreams.ok) {
    return workstreams;
  }
  if (workstreams.value.length === 0) {
    return failure("Execution plan workstreams must not be empty.");
  }

  const parsedTasks: PlannerTask[] = [];
  for (let index = 0; index < tasks.value.length; index++) {
    const task = parsePlannerTask(tasks.value[index], index);
    if (!task.ok) {
      return task;
    }
    parsedTasks.push(task.value);
  }
  const parsedWorkstreams: PlannerWorkstream[] = [];
  for (let index = 0; index < workstreams.value.length; index++) {
    const workstream = parsePlannerWorkstream(workstreams.value[index], index);
    if (!workstream.ok) {
      return workstream;
    }
    parsedWorkstreams.push(workstream.value);
  }
  return {
    ok: true,
    value: {
      version: 1,
      plannerReason: plannerReason.value,
      plannerConfidence: plannerConfidence.value,
      tasks: parsedTasks,
      workstreams: parsedWorkstreams,
    },
  };
}

export function compileExecutionPlan(
  plannerValue: unknown,
  input: ExecutionPlanCompilerInput,
): ExecutionPlanResult<ExecutionPlan> {
  if (
    !Number.isInteger(input.workerConcurrency) ||
    input.workerConcurrency < 1
  ) {
    return failure("workerConcurrency must be a positive integer.");
  }
  if (
    !input.checkoutId.trim() ||
    !input.baseSha.trim() ||
    !input.planHash.trim()
  ) {
    return failure("checkoutId, baseSha, and planHash must be non-empty.");
  }
  const inputValidation = validateExecutionPlanInput(input);
  if (!inputValidation.ok) {
    return inputValidation;
  }
  const planner = parsePlannerExecutionPlan(plannerValue);
  if (!planner.ok) {
    return planner;
  }
  const unchecked = uncheckedPlanTasks(input.plan);
  if (unchecked.length === 0) {
    return failure("Cannot compile an execution plan with no unchecked tasks.");
  }
  const validation = validatePlannerPlan(
    planner.value,
    unchecked,
    input.materialStore,
  );
  if (!validation.ok) {
    return validation;
  }

  const tasks = [...planner.value.tasks]
    .sort((left, right) => left.planIndex - right.planIndex)
    .map((task) => {
      const sourceTask = unchecked.find(
        (candidate) => candidate.planIndex === task.planIndex,
      )!.task;
      return {
        ...task,
        taskHash: taskHash(sourceTask),
        sourceAnchor: sourceAnchor(input.materialStore.entryPath, sourceTask),
      };
    });
  const unsigned = {
    version: 1 as const,
    source: {
      planPath: input.materialStore.entryPath,
      planHash: input.planHash,
      corpusHash: input.materialStore.storeHash,
      corpusFiles: input.materialStore.files
        .map((file) => ({ path: file.absolutePath, hash: file.hash }))
        .sort((left, right) => left.path.localeCompare(right.path)),
      checkoutId: input.checkoutId,
      baseSha: input.baseSha,
    },
    workerConcurrency: input.workerConcurrency,
    planner: {
      reason: planner.value.plannerReason,
      confidence: planner.value.plannerConfidence,
    },
    tasks,
    workstreams: planner.value.workstreams,
  };
  return {
    ok: true,
    value: {
      ...unsigned,
      executionPlanHash: hashJson(unsigned),
    },
  };
}

function validateExecutionPlanInput(
  input: Pick<ExecutionPlanCompilerInput, "plan" | "materialStore">,
): ExecutionPlanResult<void> {
  const { materialStore } = input;
  if (materialStore.validationErrors.length > 0) {
    return failure(
      `Plan corpus is invalid: ${materialStore.validationErrors.join("; ")}`,
    );
  }
  if (materialStore.files.length > MAX_CORPUS_FILES) {
    return failure(
      `Plan corpus exceeds maximum file count of ${MAX_CORPUS_FILES}.`,
    );
  }
  if (countMaterialChars(materialStore) > MAX_CORPUS_CHARS) {
    return failure(
      `Plan corpus exceeds maximum size of ${MAX_CORPUS_CHARS} characters.`,
    );
  }
  return { ok: true, value: undefined };
}

export function uncheckedPlanTasks(plan: ParsedPlan): UncheckedPlanTask[] {
  return plan.tasks
    .filter((task) => !task.checked)
    .map((task, index) => ({ planIndex: index + 1, task }));
}

export function validatePlannerPlan(
  planner: PlannerExecutionPlan,
  unchecked: UncheckedPlanTask[],
  materialStore: MaterialStore,
): ExecutionPlanResult<void> {
  const ids = new Set<string>();
  const indexes = new Set<number>();
  const uncheckedIndexes = new Set(unchecked.map((task) => task.planIndex));
  for (const task of planner.tasks) {
    if (!safeId(task.id)) {
      return failure(`Unsafe task id: "${task.id}".`);
    }
    if (ids.has(task.id)) {
      return failure(`Duplicate task id: "${task.id}".`);
    }
    ids.add(task.id);
    if (!uncheckedIndexes.has(task.planIndex)) {
      return failure(
        `Task "${task.id}" references checked or unknown planIndex ${task.planIndex}.`,
      );
    }
    if (indexes.has(task.planIndex)) {
      return failure(`Duplicate planIndex: ${task.planIndex}.`);
    }
    indexes.add(task.planIndex);
    const provenance = validateProvenance(task, materialStore);
    if (!provenance.ok) {
      return provenance;
    }
  }
  if (indexes.size !== unchecked.length) {
    return failure(
      `Planner task coverage is incomplete: expected ${unchecked.length} unchecked task(s), got ${indexes.size}.`,
    );
  }
  for (const task of planner.tasks) {
    const dependencies = validateDependencies(
      task.id,
      task.dependsOn,
      ids,
      "task",
    );
    if (!dependencies.ok) {
      return dependencies;
    }
  }
  const taskCycle = findCycle(
    planner.tasks.map((task) => ({ id: task.id, dependsOn: task.dependsOn })),
  );
  if (taskCycle) {
    return failure(
      `Task dependency cycle detected: ${taskCycle.join(" -> ")}.`,
    );
  }

  const workstreamIds = new Set<string>();
  const membership = new Map<string, number>();
  for (const [index, workstream] of planner.workstreams.entries()) {
    if (!safeId(workstream.id)) {
      return failure(`Unsafe workstream id: "${workstream.id}".`);
    }
    if (workstreamIds.has(workstream.id)) {
      return failure(`Duplicate workstream id: "${workstream.id}".`);
    }
    workstreamIds.add(workstream.id);
    if (workstream.taskIds.length === 0) {
      return failure(
        `Workstream "${workstream.id}" must contain at least one task.`,
      );
    }
    if (workstream.risk === "isolated" && workstream.taskIds.length !== 1) {
      return failure(
        `Isolated workstream "${workstream.id}" must contain exactly one task.`,
      );
    }
    for (const taskId of workstream.taskIds) {
      if (!ids.has(taskId)) {
        return failure(
          `Workstream "${workstream.id}" contains unknown task "${taskId}".`,
        );
      }
      if (membership.has(taskId)) {
        return failure(`Task "${taskId}" belongs to multiple workstreams.`);
      }
      membership.set(taskId, index);
    }
  }
  if (membership.size !== ids.size) {
    return failure("Workstream task coverage is incomplete.");
  }
  for (const workstream of planner.workstreams) {
    const dependencies = validateDependencies(
      workstream.id,
      workstream.dependsOn,
      workstreamIds,
      "workstream",
    );
    if (!dependencies.ok) {
      return dependencies;
    }
  }
  const workstreamCycle = findCycle(
    planner.workstreams.map((stream) => ({
      id: stream.id,
      dependsOn: stream.dependsOn,
    })),
  );
  if (workstreamCycle) {
    return failure(
      `Workstream dependency cycle detected: ${workstreamCycle.join(" -> ")}.`,
    );
  }

  const taskById = new Map(planner.tasks.map((task) => [task.id, task]));
  for (const [streamIndex, workstream] of planner.workstreams.entries()) {
    const taskOrder = new Map(
      workstream.taskIds.map((id, index) => [id, index]),
    );
    const induced = new Set<string>();
    for (const taskId of workstream.taskIds) {
      for (const dependency of taskById.get(taskId)!.dependsOn) {
        const dependencyStreamIndex = membership.get(dependency)!;
        if (dependencyStreamIndex === streamIndex) {
          if (taskOrder.get(dependency)! >= taskOrder.get(taskId)!) {
            return failure(
              `Workstream "${workstream.id}" orders task "${taskId}" before its dependency "${dependency}".`,
            );
          }
        } else {
          if (dependencyStreamIndex >= streamIndex) {
            return failure(
              `Workstream "${workstream.id}" appears before required workstream for task "${taskId}".`,
            );
          }
          induced.add(planner.workstreams[dependencyStreamIndex]!.id);
        }
      }
    }
    if (!sameSet(induced, new Set(workstream.dependsOn))) {
      return failure(
        `Workstream "${workstream.id}" dependencies must exactly match dependencies induced by its tasks.`,
      );
    }
    for (const dependency of workstream.dependsOn) {
      if (
        planner.workstreams.findIndex((stream) => stream.id === dependency) >=
        streamIndex
      ) {
        return failure(
          `Workstream "${workstream.id}" must follow dependency "${dependency}".`,
        );
      }
    }
  }
  return { ok: true, value: undefined };
}

export function writeExecutionPlan(runDir: string, plan: ExecutionPlan): void {
  const path = join(runDir, "execution-plan.json");
  if (existsSync(path)) {
    throw new Error(`Execution plan already exists: ${path}`);
  }
  writeAtomicJson(path, plan);
}

export function readExecutionPlan(runDir: string): ExecutionPlan | undefined {
  const path = join(runDir, "execution-plan.json");
  if (!existsSync(path)) {
    return undefined;
  }
  try {
    return parseStoredExecutionPlan(JSON.parse(readFileSync(path, "utf-8")));
  } catch {
    return undefined;
  }
}

function parseStoredExecutionPlan(value: unknown): ExecutionPlan | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const plan = value as Record<string, unknown>;
  if (
    !hasExactKeys(plan, [
      "version",
      "executionPlanHash",
      "source",
      "workerConcurrency",
      "planner",
      "tasks",
      "workstreams",
    ]) ||
    plan.version !== 1 ||
    typeof plan.executionPlanHash !== "string" ||
    !Number.isInteger(plan.workerConcurrency) ||
    (plan.workerConcurrency as number) < 1 ||
    !Array.isArray(plan.tasks) ||
    !Array.isArray(plan.workstreams) ||
    typeof plan.source !== "object" ||
    plan.source === null ||
    Array.isArray(plan.source) ||
    typeof plan.planner !== "object" ||
    plan.planner === null ||
    Array.isArray(plan.planner)
  ) {
    return undefined;
  }
  const source = plan.source as Record<string, unknown>;
  if (
    !hasExactKeys(source, [
      "planPath",
      "planHash",
      "corpusHash",
      "corpusFiles",
      "checkoutId",
      "baseSha",
    ]) ||
    !["planPath", "planHash", "corpusHash", "checkoutId", "baseSha"].every(
      (key) => typeof source[key] === "string" && source[key].trim() !== "",
    ) ||
    !Array.isArray(source.corpusFiles) ||
    source.corpusFiles.length === 0 ||
    !source.corpusFiles.every(validCorpusFile)
  ) {
    return undefined;
  }
  const planner = plan.planner as Record<string, unknown>;
  if (
    !hasExactKeys(planner, ["reason", "confidence"]) ||
    typeof planner.reason !== "string" ||
    planner.reason.trim() === ""
  ) {
    return undefined;
  }
  const plannerTasks: unknown[] = [];
  for (const task of plan.tasks) {
    if (typeof task !== "object" || task === null || Array.isArray(task)) {
      return undefined;
    }
    const compiled = task as Record<string, unknown>;
    if (
      !hasExactKeys(compiled, [
        "id",
        "planIndex",
        "title",
        "dependsOn",
        "provenance",
        "compiledContract",
        "taskHash",
        "sourceAnchor",
      ]) ||
      !/^[a-f0-9]{64}$/.test(String(compiled.taskHash)) ||
      !validSourceAnchor(compiled.sourceAnchor)
    ) {
      return undefined;
    }
    const {
      taskHash: _taskHash,
      sourceAnchor: _sourceAnchor,
      ...plannerTask
    } = compiled;
    plannerTasks.push(plannerTask);
  }
  const parsed = parsePlannerExecutionPlan({
    version: plan.version,
    plannerReason: planner.reason,
    plannerConfidence: planner.confidence,
    tasks: plannerTasks,
    workstreams: plan.workstreams,
  });
  if (!parsed.ok) {
    return undefined;
  }
  const candidate = plan as unknown as ExecutionPlan;
  return candidate.executionPlanHash ===
    hashJson({
      version: candidate.version,
      source: candidate.source,
      workerConcurrency: candidate.workerConcurrency,
      planner: candidate.planner,
      tasks: candidate.tasks,
      workstreams: candidate.workstreams,
    })
    ? candidate
    : undefined;
}

function validCorpusFile(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const file = value as Record<string, unknown>;
  return (
    hasExactKeys(file, ["path", "hash"]) &&
    typeof file.path === "string" &&
    file.path.trim() !== "" &&
    /^[a-f0-9]{64}$/.test(String(file.hash))
  );
}

function validSourceAnchor(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const anchor = value as Record<string, unknown>;
  return (
    hasExactKeys(anchor, [
      "path",
      "lineNumber",
      "lineText",
      "normalizedLineHash",
      "blockHash",
    ]) &&
    typeof anchor.path === "string" &&
    Number.isInteger(anchor.lineNumber) &&
    (anchor.lineNumber as number) > 0 &&
    typeof anchor.lineText === "string" &&
    /^[a-f0-9]{64}$/.test(String(anchor.normalizedLineHash)) &&
    /^[a-f0-9]{64}$/.test(String(anchor.blockHash))
  );
}

function hasExactKeys(
  value: Record<string, unknown>,
  allowed: string[],
): boolean {
  return (
    Object.keys(value).every((key) => allowed.includes(key)) &&
    allowed.every((key) => key in value)
  );
}

export function buildStrictExecutionPlannerPrompt(
  packet: PlannerPacket,
): string {
  const tasks = packet.unchecked
    .map((entry) => `- planIndex ${entry.planIndex}: ${entry.task.text}`)
    .join("\n");
  const corpus = packet.corpus
    .map((file) => `### ${file.absolutePath}\n\n${file.content}`)
    .join("\n\n");
  return `You are a read-only execution planner working in the assigned target checkout:\n\n  ${packet.workspace.path}\n\n${packet.workspace.mutationBoundary}\n\nReturn only the strict completion object.\n\n## Source plan\n\n${packet.planContent}\n\n## Unchecked source tasks\n\n${tasks}\n\n## Immutable corpus\n\n${corpus}\n\nBase SHA: ${packet.baseSha}\nEffective worker concurrency: ${packet.workerConcurrency}\n\nCreate exactly one task contract for every listed planIndex. Keep uncertain or coherent evolving work together. Split workstreams only for clear independence, high-risk isolation, or an invocation/review scope too broad to handle coherently. Workstream order must respect dependencies. Ground requirements and acceptance criteria in the source corpus, existing repository contracts, or material correctness, safety, data-integrity, or operational risks. Exploration may reveal implementation options and constraints but does not create scope. Prefer existing project, framework, platform, standard-library, or installed-dependency capabilities over new custom mechanisms when they satisfy the contract. Use implementationNotes only for required constraints, decisions, and reuse opportunities, not code choreography. Keep verificationGuidance proportional to changed behavior and material risk. Every provenance quote must be an exact non-empty quote from a corpus file. Do not invent hashes, source anchors, task modes, fallback plans, or runtime IDs.`;
}

function parsePlannerTask(
  value: unknown,
  index: number,
): ExecutionPlanResult<PlannerTask> {
  const task = object(
    value,
    `Execution plan tasks[${index}] must be an object.`,
  );
  if (!task.ok) {
    return task;
  }
  const keys = exactKeys(
    task.value,
    ["id", "planIndex", "title", "dependsOn", "provenance", "compiledContract"],
    `Execution plan tasks[${index}]`,
  );
  if (!keys.ok) {
    return keys;
  }
  const id = nonBlank(task.value.id, `Execution plan tasks[${index}].id`);
  const title = nonBlank(
    task.value.title,
    `Execution plan tasks[${index}].title`,
  );
  const planIndex = positiveInteger(
    task.value.planIndex,
    `Execution plan tasks[${index}].planIndex`,
  );
  const dependsOn = stringList(
    task.value.dependsOn,
    `Execution plan tasks[${index}].dependsOn`,
    false,
  );
  const provenance = parseProvenance(task.value.provenance, index);
  const compiledContract = parseContract(task.value.compiledContract, index);
  if (!id.ok) {
    return id;
  }
  if (!title.ok) {
    return title;
  }
  if (!planIndex.ok) {
    return planIndex;
  }
  if (!dependsOn.ok) {
    return dependsOn;
  }
  if (!provenance.ok) {
    return provenance;
  }
  if (!compiledContract.ok) {
    return compiledContract;
  }
  return {
    ok: true,
    value: {
      id: id.value,
      title: title.value,
      planIndex: planIndex.value,
      dependsOn: dependsOn.value,
      provenance: provenance.value,
      compiledContract: compiledContract.value,
    },
  };
}

function parsePlannerWorkstream(
  value: unknown,
  index: number,
): ExecutionPlanResult<PlannerWorkstream> {
  const stream = object(
    value,
    `Execution plan workstreams[${index}] must be an object.`,
  );
  if (!stream.ok) {
    return stream;
  }
  const keys = exactKeys(
    stream.value,
    ["id", "taskIds", "dependsOn", "rationale", "risk"],
    `Execution plan workstreams[${index}]`,
  );
  if (!keys.ok) {
    return keys;
  }
  const id = nonBlank(
    stream.value.id,
    `Execution plan workstreams[${index}].id`,
  );
  const taskIds = stringList(
    stream.value.taskIds,
    `Execution plan workstreams[${index}].taskIds`,
    true,
  );
  const dependsOn = stringList(
    stream.value.dependsOn,
    `Execution plan workstreams[${index}].dependsOn`,
    false,
  );
  const rationale = nonBlank(
    stream.value.rationale,
    `Execution plan workstreams[${index}].rationale`,
  );
  if (!id.ok) {
    return id;
  }
  if (!taskIds.ok) {
    return taskIds;
  }
  if (!dependsOn.ok) {
    return dependsOn;
  }
  if (!rationale.ok) {
    return rationale;
  }
  if (stream.value.risk !== "normal" && stream.value.risk !== "isolated") {
    return failure(
      `Execution plan workstreams[${index}].risk must be "normal" or "isolated".`,
    );
  }
  return {
    ok: true,
    value: {
      id: id.value,
      taskIds: taskIds.value,
      dependsOn: dependsOn.value,
      rationale: rationale.value,
      risk: stream.value.risk,
    },
  };
}

function parseProvenance(
  value: unknown,
  taskIndex: number,
): ExecutionPlanResult<PlannerProvenance[]> {
  const entries = array(value, `Execution plan tasks[${taskIndex}].provenance`);
  if (!entries.ok) {
    return entries;
  }
  if (entries.value.length === 0) {
    return failure(
      `Execution plan tasks[${taskIndex}].provenance must not be empty.`,
    );
  }
  const result: PlannerProvenance[] = [];
  for (const [index, entry] of entries.value.entries()) {
    const ref = object(
      entry,
      `Execution plan tasks[${taskIndex}].provenance[${index}] must be an object.`,
    );
    if (!ref.ok) {
      return ref;
    }
    const keys = exactKeys(
      ref.value,
      ["path", "quote"],
      `Execution plan tasks[${taskIndex}].provenance[${index}]`,
    );
    if (!keys.ok) {
      return keys;
    }
    const path = nonBlank(
      ref.value.path,
      `Execution plan tasks[${taskIndex}].provenance[${index}].path`,
    );
    const quote = exactQuote(
      ref.value.quote,
      `Execution plan tasks[${taskIndex}].provenance[${index}].quote`,
    );
    if (!path.ok) {
      return path;
    }
    if (!quote.ok) {
      return quote;
    }
    result.push({ path: path.value, quote: quote.value });
  }
  return { ok: true, value: result };
}

function parseContract(
  value: unknown,
  taskIndex: number,
): ExecutionPlanResult<StrictCompiledContract> {
  const contract = object(
    value,
    `Execution plan tasks[${taskIndex}].compiledContract must be an object.`,
  );
  if (!contract.ok) {
    return contract;
  }
  const keys = exactKeys(
    contract.value,
    [
      "objective",
      "inScope",
      "acceptanceCriteria",
      "outOfScope",
      "supportingDesignContext",
      "implementationNotes",
      "verificationGuidance",
    ],
    `Execution plan tasks[${taskIndex}].compiledContract`,
  );
  if (!keys.ok) {
    return keys;
  }
  const objective = nonBlank(
    contract.value.objective,
    `Execution plan tasks[${taskIndex}].compiledContract.objective`,
  );
  const inScope = stringList(
    contract.value.inScope,
    `Execution plan tasks[${taskIndex}].compiledContract.inScope`,
    true,
  );
  const acceptanceCriteria = stringList(
    contract.value.acceptanceCriteria,
    `Execution plan tasks[${taskIndex}].compiledContract.acceptanceCriteria`,
    true,
  );
  const outOfScope = stringList(
    contract.value.outOfScope,
    `Execution plan tasks[${taskIndex}].compiledContract.outOfScope`,
    true,
  );
  if (!objective.ok) {
    return objective;
  }
  if (!inScope.ok) {
    return inScope;
  }
  if (!acceptanceCriteria.ok) {
    return acceptanceCriteria;
  }
  if (!outOfScope.ok) {
    return outOfScope;
  }
  const optional: Pick<
    StrictCompiledContract,
    "supportingDesignContext" | "implementationNotes" | "verificationGuidance"
  > = {};
  for (const key of [
    "supportingDesignContext",
    "implementationNotes",
    "verificationGuidance",
  ] as const) {
    if (contract.value[key] === undefined) {
      continue;
    }
    const parsed = nonBlank(
      contract.value[key],
      `Execution plan tasks[${taskIndex}].compiledContract.${key}`,
    );
    if (!parsed.ok) {
      return parsed;
    }
    optional[key] = parsed.value;
  }
  return {
    ok: true,
    value: {
      objective: objective.value,
      inScope: inScope.value,
      acceptanceCriteria: acceptanceCriteria.value,
      outOfScope: outOfScope.value,
      ...optional,
    },
  };
}

function validateProvenance(
  task: PlannerTask,
  store: MaterialStore,
): ExecutionPlanResult<void> {
  for (const ref of task.provenance) {
    let path: string;
    try {
      path = resolveCorpusPath({
        planPath: store.entryPath,
        checkoutRoot: store.repoRoot ?? store.planDir,
        corpus: store.files.map((file) => ({
          path: file.absolutePath,
          hash: file.hash,
        })),
        reference: ref.path,
      });
    } catch {
      return failure(
        `Task "${task.id}" provenance path is outside the immutable corpus: ${ref.path}.`,
      );
    }
    const file = store.files.find(
      (candidate) => candidate.absolutePath === path,
    )!;
    if (!file.content.includes(ref.quote)) {
      return failure(
        `Task "${task.id}" provenance quote is not grounded in ${ref.path}.`,
      );
    }
  }
  return { ok: true, value: undefined };
}

function validateDependencies(
  id: string,
  dependsOn: string[],
  known: Set<string>,
  kind: string,
): ExecutionPlanResult<void> {
  const seen = new Set<string>();
  for (const dependency of dependsOn) {
    if (!safeId(dependency)) {
      return failure(`Unsafe ${kind} dependency id: "${dependency}".`);
    }
    if (dependency === id) {
      return failure(
        `${kind[0]!.toUpperCase()}${kind.slice(1)} "${id}" depends on itself.`,
      );
    }
    if (!known.has(dependency)) {
      return failure(
        `${kind[0]!.toUpperCase()}${kind.slice(1)} "${id}" depends on unknown id "${dependency}".`,
      );
    }
    if (seen.has(dependency)) {
      return failure(
        `${kind[0]!.toUpperCase()}${kind.slice(1)} "${id}" repeats dependency "${dependency}".`,
      );
    }
    seen.add(dependency);
  }
  return { ok: true, value: undefined };
}

function findCycle(
  nodes: Array<{ id: string; dependsOn: string[] }>,
): string[] | undefined {
  const state = new Map<string, "visiting" | "done">();
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const visit = (id: string, path: string[]): string[] | undefined => {
    const status = state.get(id);
    if (status === "visiting") {
      return [...path.slice(path.indexOf(id)), id];
    }
    if (status === "done") {
      return undefined;
    }
    state.set(id, "visiting");
    for (const dependency of byId.get(id)!.dependsOn) {
      const cycle = visit(dependency, [...path, id]);
      if (cycle) {
        return cycle;
      }
    }
    state.set(id, "done");
    return undefined;
  };
  for (const node of nodes) {
    const cycle = visit(node.id, []);
    if (cycle) {
      return cycle;
    }
  }
  return undefined;
}

function sourceAnchor(planPath: string, task: PlanTask): SourceTaskAnchor {
  return {
    path: resolve(planPath),
    lineNumber: task.lineNumber,
    lineText: task.originalLine,
    normalizedLineHash: hash(normalizeCheckboxMarker(task.originalLine)),
    blockHash: hash(
      [normalizeCheckboxMarker(task.originalLine), ...task.blockLines].join(
        "\n",
      ),
    ),
  };
}

function taskHash(task: PlanTask): string {
  return hash(
    JSON.stringify({
      index: task.index,
      line: normalizeCheckboxMarker(task.originalLine),
      blockLines: task.blockLines,
    }),
  );
}

function safeId(value: string): boolean {
  return ID_RE.test(value);
}

function sameSet(left: Set<string>, right: Set<string>): boolean {
  return (
    left.size === right.size && [...left].every((value) => right.has(value))
  );
}

function hash(value: string): string {
  return sha256(value);
}

function hashJson(value: unknown): string {
  return sha256(JSON.stringify(value));
}

function object(
  value: unknown,
  reason: string,
): ExecutionPlanResult<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? { ok: true, value: value as Record<string, unknown> }
    : failure(reason);
}

function array(value: unknown, name: string): ExecutionPlanResult<unknown[]> {
  return Array.isArray(value)
    ? { ok: true, value }
    : failure(`${name} must be an array.`);
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: string[],
  name: string,
): ExecutionPlanResult<void> {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  return unknown.length === 0
    ? { ok: true, value: undefined }
    : failure(`${name} contains unknown field(s): ${unknown.join(", ")}.`);
}

function nonBlank(value: unknown, name: string): ExecutionPlanResult<string> {
  return typeof value === "string" && value.trim().length > 0
    ? { ok: true, value: value.trim() }
    : failure(`${name} must be a non-empty string.`);
}

function exactQuote(value: unknown, name: string): ExecutionPlanResult<string> {
  return typeof value === "string" && value.trim().length > 0
    ? { ok: true, value }
    : failure(`${name} must be a non-empty string.`);
}

function positiveInteger(
  value: unknown,
  name: string,
): ExecutionPlanResult<number> {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? { ok: true, value }
    : failure(`${name} must be a positive integer.`);
}

function stringList(
  value: unknown,
  name: string,
  nonEmpty: boolean,
): ExecutionPlanResult<string[]> {
  if (
    !Array.isArray(value) ||
    !value.every(
      (entry) => typeof entry === "string" && entry.trim().length > 0,
    )
  ) {
    return failure(`${name} must be an array of non-empty strings.`);
  }
  if (nonEmpty && value.length === 0) {
    return failure(`${name} must not be empty.`);
  }
  return { ok: true, value: value.map((entry) => entry.trim()) };
}

function confidence(
  value: unknown,
): ExecutionPlanResult<"high" | "medium" | "low"> {
  return value === "high" || value === "medium" || value === "low"
    ? { ok: true, value }
    : failure(
        'Execution plan plannerConfidence must be "high", "medium", or "low".',
      );
}

function failure<T = never>(reason: string): ExecutionPlanResult<T> {
  return { ok: false, reason };
}
