import { exec, execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  renameSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import {
  buildAlreadySatisfiedReviewerPrompt,
  buildImplementerPrompt,
  buildIntegrationSelfHealPrompt,
  buildOverallReviewerPrompt,
  buildOverallReworkPrompt,
  buildReviewerPrompt,
  buildSchedulerSelfHealPrompt,
  formatExecutionManifestSummary,
} from "./prompts.js";
import { markTaskDone, markTaskUndone, parsePlanFile } from "./plan.js";
import type { PlanTask } from "./plan.js";
import {
  isNeedsMaterialResponse,
  parseNeedsMaterialResponse,
  resolveNeedsMaterialRequests,
  type NeedsMaterialRequest,
} from "./needs-material.js";
import {
  generateMinimalExecutionManifest,
  readExecutionManifest,
  renderCompiledContract,
  renderSourceMaterialPacket,
  type CompiledContract,
  type RenderedSourceMaterialPacket,
  type SourceMaterialOrigin,
  type SourceMaterialRef,
} from "./execution-plan.js";
import {
  tryMarkSourceCheckboxDone,
  tryMarkSourceCheckboxUndone,
} from "./source-checkbox.js";
import type { ExecutionManifest } from "./execution-plan.js";
import type { CommandResult, GitClient } from "./git.js";
import type { SubagentClient } from "./subagents.js";
import type { EffectiveRoles } from "./config.js";
import type {
  RunState,
  ParallelTaskState,
  AgentDisplayRef,
  StatePatch,
} from "./status.js";
import {
  fallbackCommitMessage,
  isValidCommitMessage,
  parseImplementerResult,
  parseIntegrationSelfHealResult,
  parseOverallReviewVerdict,
  parseOverallReworkResult,
  parseReviewerVerdict,
  parseSchedulerSelfHealResult,
} from "./verdict.js";
import type {
  IntegrationSelfHealResult,
  SchedulerSelfHealResult,
} from "./verdict.js";
import type { StatePaths, TaskJson } from "./state.js";
import {
  writeTaskJson,
  appendEvent,
  taskIdFromTask,
  readTaskJson,
  readRunJson,
  readEvents,
  writeRunJson,
} from "./state.js";
import type { RunMode } from "./state.js";
import { extractJsonObject, readGraphJson, writeGraphJson } from "./graph.js";
import type { ImplementGraph } from "./graph.js";
import {
  createSchedulerRun,
  computeReadyTasks,
  canStartTask,
  startTask,
  nextTaskToLand,
  allTasksTerminal,
  anyTaskFailedBlockedStopped,
  getBlockedReason,
  type SchedulerRun,
  type SchedulerTask,
  type SchedulerTaskStatus,
} from "./scheduler.js";
import { checkpointPatch } from "./status.js";
import {
  formatBundleMaterial,
  validatePlanMaterialSizes,
  type PlanBundleManifest,
} from "./manifest.js";
import {
  addMaterialFilesToStore,
  formatStoreBundleMaterial,
  formatStoreCorpusMaterial,
  type MaterialStore,
} from "./material-store.js";
import {
  buildPhase1MaterialInventory,
  buildMaterialStoreFromInventory,
  renderPhase1TaskMaterial,
  resolvePhase1MaterialRefPath,
  MAX_TASK_RENDERED_MATERIAL_CHARS,
  type Phase1MaterialInventory,
} from "./material-inventory.js";

// One initial full review plus up to two anchored re-reviews.
// If the second anchored re-review still returns unresolved required changes, block.
const MAX_ANCHORED_REVIEW_CHANGE_REQUESTS = 2;
const MAX_SYSTEM_FAILURES = 2;
const MAX_ACCUMULATED_DIFF_CHARS = 50000;
const MAX_REWORK_ATTEMPTS = 2;
const MAX_SELF_HEAL_ATTEMPTS = 2;
const MAX_OVERALL_REWORK_ATTEMPTS = 2;
const VALIDATION_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_BROAD_PLANNER_FULL_FILE_CHARS = 20_000;

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

async function buildTaskSourceMaterialPacket(
  args: TaskSourceMaterialPacketArgs,
  needsMaterialRetryState?: { attempted: boolean },
  options?: { forceRepair?: boolean },
): Promise<RenderedSourceMaterialPacket> {
  const deterministicPacket = renderDeterministicSourceMaterial(args);
  const plannerCorpus = buildPlannerSourceMaterialCorpus(args);
  const initialPlanner = renderPlannerSourceMaterial(
    args,
    plannerCorpus,
    args.plannerRefs,
  );
  let packet = mergeSourceMaterialPackets(
    deterministicPacket,
    initialPlanner.packet,
  );
  const initialIssues = collectSourceMaterialIssues(
    packet,
    initialPlanner,
    args.compiledContract,
  );

  const shouldForceRepair = options?.forceRepair && canAttemptRepair(args);
  if (initialIssues.length === 0 && !shouldForceRepair) {
    if (!packet) {
      throw new BlockedError(
        "No selected task source anchor could be rendered.",
      );
    }
    return packet;
  }

  if (hasPathEscapeOrHashMismatch(initialIssues)) {
    return resolveInvalidAfterRepair(
      args,
      deterministicPacket,
      initialPlanner,
      initialIssues,
      false,
    );
  }

  if (!canAttemptRepair(args)) {
    return resolveInvalidAfterRepair(
      args,
      deterministicPacket,
      initialPlanner,
      initialIssues,
      false,
    );
  }

  const repairIssues: SourceMaterialIssue[] =
    initialIssues.length > 0
      ? initialIssues
      : [
          {
            kind: "warning",
            message:
              "Re-run source-material selection now that requested material has been added.",
          },
        ];
  const repair = await repairPlannerSourceMaterialRefs(
    args,
    plannerCorpus,
    repairIssues,
    args.plannerRefs,
  );

  if (repair.kind === "needs_material") {
    if (needsMaterialRetryState?.attempted) {
      throw new BlockedError(
        "Planner requested additional material after one retry; bounded needs-material retry exhausted.",
      );
    }

    const resolution = await resolveAndApplyNeedsMaterial(
      args,
      repair.requests,
    );
    if (resolution.errors.length > 0) {
      throw new BlockedError(
        `Needs-material request rejected: ${resolution.errors.join("; ")}`,
      );
    }

    const augmentedArgs: TaskSourceMaterialPacketArgs = {
      ...args,
      materialStore: resolution.store,
      materialInventory: resolution.inventory,
      corpusFiles: [...(args.corpusFiles ?? []), ...resolution.corpusFiles],
    };

    return buildTaskSourceMaterialPacket(
      augmentedArgs,
      { attempted: true },
      { forceRepair: true },
    );
  }

  const repairedPlanner = renderPlannerSourceMaterial(
    args,
    plannerCorpus,
    repair.refs,
  );
  packet = mergeSourceMaterialPackets(
    deterministicPacket,
    repairedPlanner.packet,
  );
  const postRepairIssues = collectSourceMaterialIssues(
    packet,
    repairedPlanner,
    args.compiledContract,
  );

  if (postRepairIssues.length > 0) {
    return resolveInvalidAfterRepair(
      args,
      deterministicPacket,
      repairedPlanner,
      postRepairIssues,
      true,
      repair.reason,
      repair.failureReason,
    );
  }

  if (!packet) {
    throw new BlockedError("No selected task source anchor could be rendered.");
  }
  const defaultRepairReason = options?.forceRepair
    ? "re-selected source material after adding requested material"
    : "replaced invalid planner refs after validation failures";
  const repairReason = repair.failureReason
    ? `Planner source material repair attempted but failed: ${repair.failureReason}`
    : `Planner source material repaired: ${repair.reason ?? defaultRepairReason}.`;
  return {
    ...packet,
    section: `${packet.section}\n\nSource material repair note: ${repairReason}`,
    warnings: [...packet.warnings, repairReason],
    repair: {
      attempted: true,
      reason: repair.reason,
      failureReason: repair.failureReason,
    },
  };
}

type NeedsMaterialResolution = {
  store: MaterialStore;
  inventory: Phase1MaterialInventory;
  corpusFiles: Array<{ path: string; hash: string }>;
  errors: string[];
};

async function resolveAndApplyNeedsMaterial(
  args: TaskSourceMaterialPacketArgs,
  requests: NeedsMaterialRequest[],
): Promise<NeedsMaterialResolution> {
  const baseStore =
    args.materialStore ??
    buildMaterialStoreFromInventory(args.materialInventory);
  const resolution = resolveNeedsMaterialRequests(requests, baseStore);

  if (resolution.files.length === 0) {
    const errors =
      resolution.errors.length > 0
        ? resolution.errors
        : ["No material files were accepted."];
    return {
      store: baseStore,
      inventory: args.materialInventory,
      corpusFiles: [],
      errors,
    };
  }

  const augmentedStore = addMaterialFilesToStore(
    baseStore,
    resolution.files.map((file) => ({
      absolutePath: file.absolutePath,
      content: file.content,
      origins: ["needs-material" as const],
      taskOrigins: [
        { taskIndex: args.task.index, origin: "needs-material" as const },
      ],
    })),
  );

  const inventory = buildPhase1MaterialInventory({ store: augmentedStore });

  return {
    store: augmentedStore,
    inventory,
    corpusFiles: resolution.files.map((file) => ({
      path: file.absolutePath,
      hash: file.hash,
    })),
    errors: [],
  };
}

function renderDeterministicSourceMaterial(
  args: TaskSourceMaterialPacketArgs,
): RenderedSourceMaterialPacket | undefined {
  const generatedDeterministicRefs =
    generateMinimalExecutionManifest([args.task], args.planPath, args.manifest)
      .tasks[0]?.sourceMaterialRefs ?? [];
  const explicitDeterministicRefs = (args.plannerRefs ?? []).filter(
    (ref) => ref.origin === "task-anchor" || ref.origin === "task-link",
  );
  return renderPhase1TaskMaterial({
    inventory: args.materialInventory,
    refs: [...generatedDeterministicRefs, ...explicitDeterministicRefs],
  });
}

type PlannerSourceMaterialResult = {
  packet: RenderedSourceMaterialPacket | undefined;
  warnings: string[];
};

function renderPlannerSourceMaterial(
  args: TaskSourceMaterialPacketArgs,
  corpus: PlannerSourceMaterialCorpus,
  refs: SourceMaterialRef[] | undefined,
): PlannerSourceMaterialResult {
  const warnings: string[] = [];
  const packet = renderSourceMaterialPacket(
    (refs ?? [])
      .filter(
        (ref) => ref.origin === "planner" || ref.origin === "needs-material",
      )
      .map((ref) => ({ ...ref, origin: ref.origin })),
    {
      resolvePath: (ref) => {
        const allowed = resolvePhase1MaterialRefPath(
          ref,
          args.materialInventory,
        );
        if (!allowed.ok) {
          return allowed;
        }
        if (!corpus.byAbsolutePath.has(allowed.absolutePath)) {
          return {
            ok: false,
            reason: "path is not in the ingested plan corpus",
          };
        }
        return { ok: true, absolutePath: allowed.absolutePath };
      },
      readFileContent: ({ absolutePath }) => {
        const corpusEntry = corpus.byAbsolutePath.get(absolutePath);
        if (corpusEntry?.content !== undefined) {
          return corpusEntry.content;
        }
        return readFileSync(absolutePath, "utf-8");
      },
      validateFileContent: ({ absolutePath, fileContent }) => {
        const corpusEntry = corpus.byAbsolutePath.get(absolutePath);
        if (!corpusEntry) {
          return "path is not in the ingested plan corpus";
        }
        if (hashText(fileContent) !== corpusEntry.hash) {
          return "file hash does not match the ingested plan corpus";
        }
        return undefined;
      },
      warnings,
    },
  );
  return { packet, warnings };
}

type SourceMaterialIssue = {
  kind: "warning" | "oversized" | "exact-material-required";
  message: string;
};

function collectSourceMaterialIssues(
  packet: RenderedSourceMaterialPacket | undefined,
  plannerResult: PlannerSourceMaterialResult,
  compiledContract: CompiledContract,
): SourceMaterialIssue[] {
  const issues: SourceMaterialIssue[] = [];
  for (const warning of plannerResult.warnings) {
    issues.push({ kind: "warning", message: warning });
  }
  for (const ref of packet?.resolvedRefs ?? []) {
    if (
      (ref.origin === "planner" || ref.origin === "needs-material") &&
      ref.mode.kind === "full-file" &&
      ref.renderedCharCount > MAX_BROAD_PLANNER_FULL_FILE_CHARS
    ) {
      issues.push({
        kind: "warning",
        message: `Planner full-file ref ${ref.absolutePath} is too broad (${ref.renderedCharCount} characters); narrow it to a line-range.`,
      });
    }
  }
  if (packet && packet.section.length > MAX_TASK_RENDERED_MATERIAL_CHARS) {
    issues.push({
      kind: "oversized",
      message: `Rendered source material exceeds maximum size of ${MAX_TASK_RENDERED_MATERIAL_CHARS} characters (${packet.section.length} characters).`,
    });
  }
  if (
    requiresExactMaterial(compiledContract) &&
    !packetHasMaterialBeyondTaskAnchor(packet)
  ) {
    issues.push({
      kind: "exact-material-required",
      message:
        "Task contract requires exact source material, but no usable rendered material beyond the selected task anchor was resolved.",
    });
  }
  return issues;
}

function canAttemptRepair(args: TaskSourceMaterialPacketArgs): boolean {
  return !!(args.subagents && args.roles?.planner && args.updateState);
}

function resolvedTaskId(args: TaskSourceMaterialPacketArgs): string {
  return args.taskId ?? taskIdFromTask(args.task.index - 1, args.task.text);
}

function hasHardSafetyIssue(issues: SourceMaterialIssue[]): boolean {
  return issues.some(
    (issue) =>
      issue.kind === "oversized" ||
      issue.kind === "exact-material-required" ||
      (issue.kind === "warning" &&
        (issue.message.includes("outside allowed roots") ||
          issue.message.includes("hash does not match"))),
  );
}

function hasPathEscapeOrHashMismatch(issues: SourceMaterialIssue[]): boolean {
  return issues.some(
    (issue) =>
      issue.kind === "warning" &&
      (issue.message.includes("outside allowed roots") ||
        issue.message.includes("hash does not match")),
  );
}

function resolveInvalidAfterRepair(
  args: TaskSourceMaterialPacketArgs,
  deterministicPacket: RenderedSourceMaterialPacket | undefined,
  plannerResult: PlannerSourceMaterialResult,
  issues: SourceMaterialIssue[],
  repairAttempted: boolean,
  repairReason?: string,
  repairFailureReason?: string,
): RenderedSourceMaterialPacket {
  if (hasHardSafetyIssue(issues)) {
    const audit = repairFailureReason
      ? ` Repair failure: ${repairFailureReason}`
      : repairReason
        ? ` Repair reason: ${repairReason}`
        : "";
    throw new BlockedError(
      `Task source material could not be repaired: ${issues.map((i) => i.message).join("; ")}.${audit}`,
    );
  }
  if (
    requiresExactMaterial(args.compiledContract) &&
    !packetHasMaterialBeyondTaskAnchor(deterministicPacket)
  ) {
    const audit = repairFailureReason
      ? ` Repair failure: ${repairFailureReason}`
      : repairReason
        ? ` Repair reason: ${repairReason}`
        : "";
    throw new BlockedError(
      `Task source material could not be repaired: exact/verbatim source material is required, but the fallback packet would only contain the selected task anchor. Issues: ${issues.map((i) => i.message).join("; ")}.${audit}`,
    );
  }
  if (!deterministicPacket) {
    throw new BlockedError("No selected task source anchor could be rendered.");
  }
  const repairNotes: string[] = [];
  if (repairAttempted) {
    repairNotes.push(
      "Planner source material repair attempted, but output remained invalid. Invalid planner refs were dropped; final packet uses deterministic anchors only.",
    );
  } else {
    repairNotes.push(
      "Invalid planner source material refs were dropped; final packet uses deterministic anchors only.",
    );
  }
  if (repairReason) {
    repairNotes.push(`Repair reason: ${repairReason}`);
  }
  if (repairFailureReason) {
    repairNotes.push(`Repair failure: ${repairFailureReason}`);
  }
  const repairNote = repairNotes.join(" ");
  const warnings = [
    ...plannerResult.warnings,
    `${repairNote} Remaining issues: ${issues.map((i) => i.message).join("; ")}`,
  ];
  return {
    ...deterministicPacket,
    section: `${deterministicPacket.section}\n\nSource material repair note: ${repairNote}\n\nLow-confidence source material warning for review: ${warnings.join("; ")}`,
    warnings,
    repair: {
      attempted: repairAttempted,
      reason: repairReason,
      failureReason: repairFailureReason,
    },
  };
}

type PlannerRepairResult =
  | {
      kind: "refs";
      refs: SourceMaterialRef[];
      reason?: string;
      failureReason?: string;
    }
  | {
      kind: "needs_material";
      requests: NeedsMaterialRequest[];
      reason?: string;
      failureReason?: string;
    };

async function repairPlannerSourceMaterialRefs(
  args: TaskSourceMaterialPacketArgs,
  corpus: PlannerSourceMaterialCorpus,
  issues: SourceMaterialIssue[],
  currentRefs: SourceMaterialRef[] | undefined,
): Promise<PlannerRepairResult> {
  const prompt = buildSourceMaterialRepairPrompt(args, issues, currentRefs);
  let repairId: string | undefined;
  try {
    const id = await args.subagents!.spawn({
      type: args.roles!.planner.type,
      prompt,
      description: `planner: repair source material refs for task ${args.task.index}`,
      model: args.roles!.planner.model,
      thinking: args.roles!.planner.thinking,
      role: "planner",
      readOnly: true,
      cwd: args.repoRoot,
    });
    repairId = id;
    const ref: AgentDisplayRef = {
      id,
      role: "planner",
      label: `Planner · Repair source material refs for task ${args.task.index}`,
      startedAt: new Date().toISOString(),
    };
    args.updateState!((prev) => addActiveAgentPatch(prev, ref));
    const result = await args.subagents!.waitFor(id, args.signal);
    args.updateState!((prev) => removeActiveAgentPatch(prev, id));
    if (result.status !== "completed") {
      return {
        kind: "refs",
        refs: currentRefs ?? [],
        failureReason: `Repair subagent finished with status ${result.status}: ${result.error}`,
      };
    }
    const parsed = parseSourceMaterialRepairResponse(result.result);
    if (!parsed.ok) {
      return {
        kind: "refs",
        refs: currentRefs ?? [],
        failureReason: `Repair response parse failed: ${parsed.reason}`,
      };
    }
    if (isNeedsMaterialResponse(parsed.value)) {
      return {
        kind: "needs_material",
        requests: parsed.value.requests,
        reason: "Planner requested additional material.",
      };
    }
    if (parsed.value.taskId !== resolvedTaskId(args)) {
      return {
        kind: "refs",
        refs: currentRefs ?? [],
        failureReason: `Repair response taskId mismatch: expected ${resolvedTaskId(args)}, got ${parsed.value.taskId}`,
      };
    }
    return {
      kind: "refs",
      refs: parsed.value.sourceMaterialRefs.map((ref) => ({
        ...ref,
        origin: ref.origin === "needs-material" ? "needs-material" : "planner",
      })),
      reason: parsed.value.reason,
    };
  } catch (err) {
    const id = repairId;
    if (id) {
      args.updateState!((prev) => removeActiveAgentPatch(prev, id));
    }
    return {
      kind: "refs",
      refs: currentRefs ?? [],
      failureReason: `Repair subagent threw: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

function buildSourceMaterialRepairPrompt(
  args: TaskSourceMaterialPacketArgs,
  issues: SourceMaterialIssue[],
  currentRefs: SourceMaterialRef[] | undefined,
): string {
  return `You are repairing planner-selected source material references for a single task packet.

Task id: ${resolvedTaskId(args)}
Task title: ${args.task.text}
Plan path: ${args.planPath}

Compiled task contract:
${renderCompiledContract(args.compiledContract)}

Current planner-selected sourceMaterialRefs:
${JSON.stringify(currentRefs ?? [], null, 2)}

Validation issues to fix:
${issues.map((issue) => `- ${issue.message}`).join("\n")}

Your job is to return a corrected set of sourceMaterialRefs for this task only. Preserve only the exact/raw material the implementer needs from the plan corpus. Replace invalid line ranges, narrow overly broad or oversized full-file refs into precise line ranges, and include any material required by verbatim/exact/source-of-truth language in the contract. Do not ask for a regenerated execution manifest or change the task contract. Do not include deterministic selected-task anchors or task-link refs; those are merged separately and cannot be removed.

If the required material is a safe local Markdown file that is missing from the plan corpus, you may instead request it by returning a needs_material response. The orchestrator will resolve the path, add the file to the material store, and rerun this repair step once. Only request local Markdown files; URLs and non-Markdown files will be rejected.

Respond with strict JSON only, beginning with { and ending with }. Do not include markdown fences or analysis outside the JSON.

Schema for corrected refs:
{
  "taskId": "${resolvedTaskId(args)}",
  "sourceMaterialRefs": [
    { "origin": "planner", "path": "relative-or-absolute-path.md", "mode": { "kind": "full-file" }, "reason": "why this material is required" },
    { "origin": "planner", "path": "relative-or-absolute-path.md", "mode": { "kind": "line-range", "startLine": 10, "endLine": 20 }, "reason": "why this exact range is required" }
  ],
  "reason": "why the corrections were made"
}

Schema for requesting additional material:
{
  "kind": "needs_material",
  "requests": [
    { "pathHint": "relative-or-absolute-path.md", "relativeTo": "plan" | "repo" | "path", "reason": "why this file is required" }
  ]
}`;
}

type SourceMaterialRepairResponse = {
  taskId: string;
  sourceMaterialRefs: SourceMaterialRef[];
  reason: string;
};

function parseSourceMaterialRepairResponse(text: string):
  | {
      ok: true;
      value:
        | SourceMaterialRepairResponse
        | import("./needs-material.js").NeedsMaterialResponse;
    }
  | { ok: false; reason: string } {
  const candidate = extractJsonObject(text);
  if (!candidate.ok) {
    return candidate;
  }

  const needsMaterial = parseNeedsMaterialResponse(text);
  if (needsMaterial.ok) {
    return { ok: true, value: needsMaterial.value };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate.text);
  } catch {
    return { ok: false, reason: "Repair response is not valid JSON." };
  }
  if (!isRecord(parsed)) {
    return { ok: false, reason: "Repair response JSON must be an object." };
  }
  const obj = parsed;
  if (typeof obj.taskId !== "string" || obj.taskId.trim().length === 0) {
    return {
      ok: false,
      reason: "Repair response taskId must be a non-empty string.",
    };
  }
  if (!Array.isArray(obj.sourceMaterialRefs)) {
    return {
      ok: false,
      reason: "Repair response sourceMaterialRefs must be an array.",
    };
  }
  const refs: SourceMaterialRef[] = [];
  for (let i = 0; i < obj.sourceMaterialRefs.length; i++) {
    const refResult = parseRepairSourceMaterialRef(
      obj.sourceMaterialRefs[i],
      i,
    );
    if (!refResult.ok) {
      return { ok: false, reason: refResult.reason };
    }
    refs.push(refResult.value);
  }
  if (typeof obj.reason !== "string" || obj.reason.trim().length === 0) {
    return {
      ok: false,
      reason: "Repair response reason must be a non-empty string.",
    };
  }
  return {
    ok: true,
    value: {
      taskId: obj.taskId.trim(),
      sourceMaterialRefs: refs,
      reason: obj.reason.trim(),
    },
  };
}

function parseRepairSourceMaterialRef(
  value: unknown,
  index: number,
): { ok: true; value: SourceMaterialRef } | { ok: false; reason: string } {
  if (!isRecord(value)) {
    return {
      ok: false,
      reason: `Repair response sourceMaterialRefs[${index}] must be an object.`,
    };
  }
  const obj = value;
  const origin: SourceMaterialOrigin =
    obj.origin === "needs-material" ? "needs-material" : "planner";
  if (typeof obj.path !== "string" || obj.path.trim().length === 0) {
    return {
      ok: false,
      reason: `Repair response sourceMaterialRefs[${index}] path must be a non-empty string.`,
    };
  }
  if (typeof obj.reason !== "string" || obj.reason.trim().length === 0) {
    return {
      ok: false,
      reason: `Repair response sourceMaterialRefs[${index}] reason must be a non-empty string.`,
    };
  }
  if (!isRecord(obj.mode)) {
    return {
      ok: false,
      reason: `Repair response sourceMaterialRefs[${index}] mode must be an object.`,
    };
  }
  const mode = obj.mode;
  if (mode.kind === "full-file") {
    return {
      ok: true,
      value: {
        origin,
        path: obj.path.trim(),
        mode: { kind: "full-file" },
        reason: obj.reason.trim(),
      },
    };
  }
  if (mode.kind !== "line-range") {
    return {
      ok: false,
      reason: `Repair response sourceMaterialRefs[${index}] mode.kind must be "full-file" or "line-range", got: ${String(mode.kind)}.`,
    };
  }
  if (
    typeof mode.startLine !== "number" ||
    !Number.isInteger(mode.startLine) ||
    mode.startLine < 1 ||
    typeof mode.endLine !== "number" ||
    !Number.isInteger(mode.endLine) ||
    mode.endLine < mode.startLine
  ) {
    return {
      ok: false,
      reason: `Repair response sourceMaterialRefs[${index}] line-range must include positive integer startLine and endLine with endLine >= startLine.`,
    };
  }
  return {
    ok: true,
    value: {
      origin,
      path: obj.path.trim(),
      mode: {
        kind: "line-range",
        startLine: mode.startLine,
        endLine: mode.endLine,
      },
      reason: obj.reason.trim(),
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mergeSourceMaterialPackets(
  phase1Packet: RenderedSourceMaterialPacket | undefined,
  plannerPacket: RenderedSourceMaterialPacket | undefined,
): RenderedSourceMaterialPacket | undefined {
  if (!phase1Packet) {
    return plannerPacket;
  }
  if (!plannerPacket) {
    return phase1Packet;
  }
  return {
    section: `${phase1Packet.section}\n\n${plannerPacket.section}`,
    resolvedRefs: [...phase1Packet.resolvedRefs, ...plannerPacket.resolvedRefs],
    warnings: [...phase1Packet.warnings, ...plannerPacket.warnings],
  };
}

function packetHasMaterialBeyondTaskAnchor(
  packet: RenderedSourceMaterialPacket | undefined,
): boolean {
  return (
    packet?.resolvedRefs.some((ref) => ref.origin !== "task-anchor") ?? false
  );
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

type PlannerSourceMaterialCorpusEntry = {
  absolutePath: string;
  hash: string;
  content?: string;
};

type PlannerSourceMaterialCorpus = {
  byAbsolutePath: Map<string, PlannerSourceMaterialCorpusEntry>;
  planDir: string;
  repoRoot?: string;
};

function buildPlannerSourceMaterialCorpus(
  args: TaskSourceMaterialPacketArgs,
): PlannerSourceMaterialCorpus {
  const byAbsolutePath = new Map<string, PlannerSourceMaterialCorpusEntry>();
  const addEntry = (path: string, hash: string, content?: string) => {
    const absolutePath = resolve(path);
    const existing = byAbsolutePath.get(absolutePath);
    if (existing?.content !== undefined && content === undefined) {
      return;
    }
    byAbsolutePath.set(absolutePath, { absolutePath, hash, content });
  };

  for (const material of args.materialInventory.materials) {
    addEntry(material.absolutePath, material.hash, material.content);
  }
  for (const task of args.manifest?.tasks ?? []) {
    for (const material of task.referencedMaterials) {
      addEntry(
        material.absolutePath,
        hashText(material.content),
        material.content,
      );
    }
  }
  for (const file of args.corpusFiles ?? []) {
    addEntry(file.path, file.hash);
  }

  return {
    byAbsolutePath,
    planDir: dirname(resolve(args.planPath)),
    repoRoot: args.repoRoot ? resolve(args.repoRoot) : undefined,
  };
}

type RetryFeedback = {
  source: "reviewer" | "system" | "commit-hook" | "integration";
  message: string;
};

type TaskSourceMaterialPacketArgs = {
  task: PlanTask;
  taskId?: string;
  planPath: string;
  manifest?: PlanBundleManifest;
  repoRoot?: string;
  corpusFiles?: Array<{ path: string; hash: string }>;
  materialInventory: Phase1MaterialInventory;
  materialStore?: MaterialStore;
  compiledContract: CompiledContract;
  plannerRefs?: SourceMaterialRef[];
  subagents?: SubagentClient;
  roles?: EffectiveRoles;
  updateState?: (state: StatePatch) => void;
  signal?: AbortSignal;
};

export type OrchestratorDeps = {
  git: GitClient;
  subagents: SubagentClient;
  planPath: string;
  planArtifacts?: string[];
  manifest?: PlanBundleManifest;
  executionManifest?: ExecutionManifest;
  materialInventory?: Phase1MaterialInventory;
  materialStore?: MaterialStore;
  corpusMaterial?: string;
  roles: EffectiveRoles;
  mode?: RunMode;
  maxConcurrency?: number;
  runId?: string;
  paths?: StatePaths;
  updateState(state: StatePatch): void;
  shouldStop(): boolean;
  signal?: AbortSignal;
  verifyCommand?: string;
};

export async function runImplementation(deps: OrchestratorDeps): Promise<void> {
  deps.updateState({
    phase: "preflight",
    planPath: deps.planPath,
    lastReason: undefined,
  });
  await deps.git.root();
  if (deps.manifest) {
    if (deps.manifest.validationErrors.length > 0) {
      throw new BlockedError(
        `plan bundle validation failed:\n${deps.manifest.validationErrors.join("\n")}`,
      );
    }
    const materialSizeErrors = validatePlanMaterialSizes(deps.manifest);
    if (materialSizeErrors.length > 0) {
      throw new BlockedError(
        `plan material too large:\n${materialSizeErrors.join("\n")}`,
      );
    }
  }
  let plan = parsePlanFile(deps.planPath);
  const repoRoot = await deps.git.root();
  const materialInventory =
    deps.materialInventory ??
    buildPhase1MaterialInventory({
      plan,
      planPath: deps.planPath,
      manifest: deps.manifest,
      repoRoot,
    });
  deps = { ...deps, materialInventory };
  const planArtifacts = deps.planArtifacts ?? [deps.planPath];
  if (!(await deps.git.isCleanExcept(planArtifacts))) {
    throw new BlockedError("dirty worktree");
  }

  const runBaseSha = deps.paths
    ? (readRunJson(deps.paths)?.baseSha ?? (await deps.git.head()))
    : await deps.git.head();

  let executionManifest = deps.executionManifest;
  if (!executionManifest && deps.paths) {
    executionManifest = readExecutionManifest(deps.paths.runDir);
  }
  if (!executionManifest) {
    const plan = parsePlanFile(deps.planPath);
    executionManifest = generateMinimalExecutionManifest(
      plan.tasks,
      deps.planPath,
      deps.manifest,
    );
  }
  deps = { ...deps, executionManifest, planArtifacts };
  validateRecordedPlanCorpus(deps);

  if (deps.mode === "serial") {
    await runSerialImplementation(deps, plan, planArtifacts, runBaseSha);
    return;
  }

  // For auto/parallel: try to load a graph and run the scheduler
  const graph = deps.paths ? readGraphJson(deps.paths.runDir) : undefined;
  if (graph && deps.paths && deps.runId) {
    await runParallelImplementation(
      deps,
      graph,
      plan,
      planArtifacts,
      runBaseSha,
    );
    return;
  }

  // Fallback to serial if no graph (shouldn't happen in normal flow)
  await runSerialImplementation(deps, plan, planArtifacts, runBaseSha);
}

async function runSerialImplementation(
  deps: OrchestratorDeps,
  initialPlan: ReturnType<typeof parsePlanFile>,
  planArtifacts: string[],
  runBaseSha: string,
): Promise<void> {
  let plan = initialPlan;

  for (;;) {
    throwIfStopped(deps);
    plan = parsePlanFile(deps.planPath);
    if (!(await deps.git.isCleanExcept(planArtifacts))) {
      throw new BlockedError("dirty worktree");
    }
    if (!deps.executionManifest) {
      throw new BlockedError("no execution manifest available");
    }
    validateRecordedPlanCorpus(deps);
    const next = nextUncheckedManifestTask(
      plan,
      deps.executionManifest,
      deps.paths,
    );
    const task = next?.planTask;
    deps.updateState({
      taskIndex: task?.index ?? completedPlanTaskIndex(plan),
      totalTasks: plan.tasks.length,
    });
    if (!task) {
      await runOverallReviewLoop(deps, plan, planArtifacts, runBaseSha);
      deps.updateState({
        phase: "done",
        taskIndex: plan.tasks.length,
        totalTasks: plan.tasks.length,
        activeSubagentId: undefined,
      });
      return;
    }

    const taskId = taskIdFromTask(task.index - 1, task.text);
    const runId = deps.runId ?? "run";
    const branchName = `pi-implement/${runId}/${taskId}`;

    if (deps.paths) {
      writeTaskJson(deps.paths, taskId, {
        id: taskId,
        planIndex: task.index - 1,
        title: task.text,
        status: "pending",
        dependsOn: [],
        attempts: 0,
        integrationAttempts: 0,
      });
    }

    const baseSha = await deps.git.head();
    const paths = deps.paths;
    const worktreePath =
      deps.mode === "parallel" && paths
        ? join(paths.worktreesDir, taskId)
        : undefined;

    if (worktreePath) {
      await deps.git.createTaskBranch(branchName, baseSha);
      await deps.git.addWorktree(worktreePath, branchName);
      if (deps.paths) {
        writeTaskJson(deps.paths, taskId, {
          id: taskId,
          planIndex: task.index - 1,
          title: task.text,
          status: "pending",
          dependsOn: [],
          attempts: 0,
          integrationAttempts: 0,
          baseSha,
          worktreePath,
          branchName,
        });
      }
    }

    const taskGit = worktreePath
      ? deps.git.forWorktree(worktreePath, await deps.git.root())
      : deps.git;

    try {
      const landed = await runTaskWorker({
        deps,
        plan,
        task,
        taskId,
        taskGit,
        worktreePath,
        branchName,
        baseSha,
        planArtifacts,
        runBaseSha,
      });
      if (!landed) {
        break;
      }
    } finally {
      if (worktreePath && deps.mode !== "parallel") {
        await deps.git.removeWorktree(worktreePath).catch(() => undefined);
        await deps.git.deleteTaskBranch(branchName).catch(() => undefined);
      }
    }

    if (deps.mode === "parallel") {
      throw new BlockedError(
        "parallel task approved, but main-checkout integration is not implemented yet",
      );
    }
  }
}

// ── Parallel scheduler ──────────────────────────────────────────────────────

type WorkerResult = {
  taskId: string;
  outcome:
    | { kind: "approved"; taskCommitSha: string; commitMessage: string }
    | { kind: "satisfied" }
    | { kind: "failed"; reason: string }
    | { kind: "stopped" };
};

type TaskWorkerResult = "changed" | "satisfied" | false;

async function runParallelImplementation(
  deps: OrchestratorDeps,
  graph: ImplementGraph,
  initialPlan: ReturnType<typeof parsePlanFile>,
  planArtifacts: string[],
  runBaseSha: string,
): Promise<void> {
  const sched = createSchedulerRun(graph, deps.maxConcurrency ?? 1);
  const runningWorkers = new Map<string, Promise<WorkerResult>>();
  let plan = initialPlan;
  const reworkTaskIds = new Set<string>();
  let schedulerSelfHealAttempts = 0;
  let schedulerSelfHealFailed = false;
  let schedulerSelfHealRemainingBlocker: string | undefined;

  deps.updateState({
    phase: "scheduling",
    runId: deps.runId,
    mode: deps.mode,
    baseSha: graph.baseSha,
    maxConcurrency: deps.maxConcurrency,
    totalCount: graph.nodes.length,
    landedCount: 0,
  });

  scheduler: for (;;) {
    if (allTasksTerminal(sched)) {
      if (anyTaskFailedBlockedStopped(sched)) {
        const healProgress = await attemptSchedulerSelfHeal(
          deps,
          sched,
          graph,
          plan,
          planArtifacts,
          schedulerSelfHealAttempts,
        );
        schedulerSelfHealAttempts = healProgress.attempts;
        schedulerSelfHealRemainingBlocker = healProgress.remainingBlocker;
        if (healProgress.hasProgress) {
          continue scheduler;
        }
        if (healProgress.attempted) {
          schedulerSelfHealFailed = true;
        }
      }
      break;
    }

    throwIfStopped(deps);
    plan = parsePlanFile(deps.planPath);
    validateRecordedPlanCorpus(deps);

    // ── Start ready tasks ──
    const ready = computeReadyTasks(sched).filter((id) =>
      canStartTask(sched, id),
    );
    for (const taskId of ready) {
      if (runningWorkers.has(taskId)) {
        continue;
      }
      const wasNeedsRework = sched.tasks.get(taskId)?.status === "needs_rework";
      if (wasNeedsRework) {
        reworkTaskIds.add(taskId);
      }
      startTask(sched, taskId);

      const taskNode = graph.nodes.find((n) => n.id === taskId)!;
      const planTask = plan.tasks.find((t) => t.index === taskNode.planIndex);
      if (!planTask) {
        const task = sched.tasks.get(taskId)!;
        task.status = "failed";
        task.lastReason = `Plan task ${taskNode.planIndex} not found`;
        continue;
      }

      const promise = launchTaskWorker(
        deps,
        sched,
        taskId,
        planTask,
        planArtifacts,
        runBaseSha,
        wasNeedsRework,
      );
      runningWorkers.set(taskId, promise);
    }

    updateParallelState(deps, sched);

    const hasActiveRework = [...reworkTaskIds].some((id) =>
      runningWorkers.has(id),
    );

    // ── Try landing (serialized, plan-ordered) ──
    const toLand = nextTaskToLand(sched);
    if (toLand && !hasActiveRework) {
      const landResult = await landApprovedTask(
        deps,
        sched,
        toLand,
        plan,
        planArtifacts,
      );
      if (landResult === "landed") {
        continue; // Keep looping to possibly land more
      } else if (landResult === "needs_rework") {
        // The task status is already set to needs_rework; it will restart
        continue;
      }
      // integration_failed stays as is; loop continues
    }

    // ── Wait for next worker or integration event ──
    if (runningWorkers.size > 0) {
      // Race all running workers for the next completion
      const result = await Promise.race(runningWorkers.values());
      runningWorkers.delete(result.taskId);
      reworkTaskIds.delete(result.taskId);

      const task = sched.tasks.get(result.taskId)!;
      if (result.outcome.kind === "approved") {
        task.status = "approved";
        task.taskCommitSha = result.outcome.taskCommitSha;
        task.approvedCommitMessage = result.outcome.commitMessage;
        task.activeAgentIds = [];
        task.activeAgentRefs = [];
        if (deps.paths) {
          const existing = readTaskJson(deps.paths, result.taskId);
          writeTaskJson(deps.paths, result.taskId, {
            ...buildTaskJsonSnapshot(existing, task),
            status: "approved",
            taskCommitSha: result.outcome.taskCommitSha,
            commitMessage: result.outcome.commitMessage,
            activeSubagentIds: [],
          });
          appendEvent(deps.paths, {
            type: "task_approved",
            taskId: result.taskId,
            commitSha: result.outcome.taskCommitSha,
          });
        }
      } else if (result.outcome.kind === "satisfied") {
        task.status = "satisfied";
        task.activeAgentIds = [];
        task.activeAgentRefs = [];
        sched.landedOrder.push(result.taskId);
        if (deps.paths) {
          const existing = readTaskJson(deps.paths, result.taskId);
          writeTaskJson(deps.paths, result.taskId, {
            ...buildTaskJsonSnapshot(existing, task),
            status: "satisfied",
            activeSubagentIds: [],
          });
          appendEvent(deps.paths, {
            type: "task_satisfied",
            taskId: result.taskId,
          });
        }
      } else if (result.outcome.kind === "failed") {
        task.status = "failed";
        task.lastReason = result.outcome.reason;
        task.activeAgentIds = [];
        task.activeAgentRefs = [];
        if (deps.paths) {
          const existing = readTaskJson(deps.paths, result.taskId);
          writeTaskJson(deps.paths, result.taskId, {
            ...buildTaskJsonSnapshot(existing, task),
            status: "failed",
            activeSubagentIds: [],
            lastReason: result.outcome.reason,
          });
        }
      } else {
        // stopped
        task.status = "stopped";
        task.activeAgentIds = [];
        task.activeAgentRefs = [];
        if (deps.paths) {
          const existing = readTaskJson(deps.paths, result.taskId);
          writeTaskJson(deps.paths, result.taskId, {
            ...buildTaskJsonSnapshot(existing, task),
            status: "stopped",
            activeSubagentIds: [],
          });
        }
      }
      continue;
    }

    // Nothing running and nothing to land
    if (!toLand && !hasActiveRework) {
      const healProgress = await attemptSchedulerSelfHeal(
        deps,
        sched,
        graph,
        plan,
        planArtifacts,
        schedulerSelfHealAttempts,
      );
      schedulerSelfHealAttempts = healProgress.attempts;
      schedulerSelfHealRemainingBlocker = healProgress.remainingBlocker;
      if (healProgress.hasProgress) {
        continue;
      }
      schedulerSelfHealFailed = true;
      sched.phase = "blocked";
      break;
    }
  }

  if (!allTasksTerminal(sched)) {
    const reason = stalledSchedulerReason(
      sched,
      schedulerSelfHealFailed,
      schedulerSelfHealRemainingBlocker,
    );
    deps.updateState({ phase: "blocked", lastReason: reason });
    throw new BlockedError(reason);
  }

  if (!anyTaskFailedBlockedStopped(sched)) {
    const finalValidation = await validateFinalParallelRun(deps);
    if (!finalValidation.ok) {
      sched.phase = "blocked";
      deps.updateState({
        phase: "blocked",
        lastReason: finalValidation.reason,
      });
      throw new BlockedError(finalValidation.reason);
    }
    await runOverallReviewLoop(deps, initialPlan, planArtifacts, graph.baseSha);
    markCompletedParallelSourceCheckboxes(deps, sched, plan);
  }

  const landedCount = [...sched.tasks.values()].filter(
    (t) => t.status === "landed",
  ).length;
  const satisfiedCount = [...sched.tasks.values()].filter(
    (t) => t.status === "satisfied",
  ).length;
  const hasFailure = anyTaskFailedBlockedStopped(sched);
  const failureReason = hasFailure
    ? stalledSchedulerReason(
        sched,
        schedulerSelfHealFailed,
        schedulerSelfHealRemainingBlocker,
      )
    : undefined;
  deps.updateState({
    phase: hasFailure
      ? "blocked"
      : sched.phase === "done" || allTasksTerminal(sched)
        ? "done"
        : (sched.phase as RunState["phase"]),
    landedCount,
    satisfiedCount,
    activeSubagentId: undefined,
    activeSubagentIds: [],
    activeAgentRefs: [],
    ...(failureReason ? { lastReason: failureReason } : {}),
  });

  if (failureReason) {
    throw new BlockedError(failureReason);
  }
}

async function launchTaskWorker(
  deps: OrchestratorDeps,
  sched: SchedulerRun,
  taskId: string,
  planTask: ReturnType<typeof parsePlanFile>["tasks"][number],
  planArtifacts: string[],
  runBaseSha: string,
  wasNeedsRework: boolean,
): Promise<WorkerResult> {
  const task = sched.tasks.get(taskId)!;
  const baseSha = await deps.git.head();
  const runId = deps.runId ?? "run";
  const branchName = `pi-implement/${runId}/${taskId}`;
  const worktreePath = deps.paths
    ? join(deps.paths.worktreesDir, taskId)
    : undefined;

  if (worktreePath) {
    try {
      if (wasNeedsRework) {
        await deps.git.removeWorktree(worktreePath).catch(() => undefined);
        await deps.git.deleteTaskBranch(branchName).catch(() => undefined);
      }
      await deps.git.createTaskBranch(branchName, baseSha);
      await deps.git.addWorktree(worktreePath, branchName);
      task.worktreePath = worktreePath;
      task.branchName = branchName;
      if (deps.paths) {
        const existing = readTaskJson(deps.paths, taskId);
        writeTaskJson(deps.paths, taskId, {
          ...buildTaskJsonSnapshot(existing, task),
          status: "coding",
          baseSha,
          worktreePath,
          branchName,
        });
        appendEvent(deps.paths, { type: "task_started", taskId });
      }
    } catch (err) {
      await deps.git.removeWorktree(worktreePath).catch(() => undefined);
      await deps.git.deleteTaskBranch(branchName).catch(() => undefined);
      const reason = err instanceof Error ? err.message : String(err);
      return {
        taskId,
        outcome: { kind: "failed", reason: `Worktree setup failed: ${reason}` },
      };
    }
  }

  const taskGit = worktreePath
    ? deps.git.forWorktree(worktreePath, await deps.git.root())
    : deps.git;

  const plan = parsePlanFile(deps.planPath);

  try {
    const success = await runTaskWorker({
      deps,
      plan,
      task: planTask,
      taskId,
      taskGit,
      worktreePath,
      branchName,
      baseSha,
      planArtifacts,
      schedulerTask: task,
      runBaseSha,
      wasNeedsRework,
      initialFeedback:
        wasNeedsRework && task.lastReason
          ? { source: "integration", message: task.lastReason }
          : undefined,
      attemptOrdinalBase: task.integrationAttempts,
    });

    if (deps.shouldStop() || deps.signal?.aborted) {
      return { taskId, outcome: { kind: "stopped" } };
    }

    if (success === "satisfied") {
      return { taskId, outcome: { kind: "satisfied" } };
    }

    if (success === "changed" && worktreePath) {
      const taskCommitSha = await taskGit.head();
      const taskJson = deps.paths
        ? readTaskJson(deps.paths, taskId)
        : undefined;
      const commitMessage =
        taskJson?.commitMessage ?? `chore: implement ${task.title}`;
      return {
        taskId,
        outcome: { kind: "approved", taskCommitSha, commitMessage },
      };
    }

    return {
      taskId,
      outcome: {
        kind: "failed",
        reason: task.lastReason ?? "Task worker failed",
      },
    };
  } catch (err) {
    if (err instanceof StoppedError) {
      return { taskId, outcome: { kind: "stopped" } };
    }
    const reason = err instanceof Error ? err.message : String(err);
    return { taskId, outcome: { kind: "failed", reason } };
  }
}

async function landApprovedTask(
  deps: OrchestratorDeps,
  sched: SchedulerRun,
  taskId: string,
  plan: ReturnType<typeof parsePlanFile>,
  planArtifacts: string[],
): Promise<"landed" | "needs_rework" | "integration_failed"> {
  const task = sched.tasks.get(taskId)!;
  if (!task.taskCommitSha) {
    return markIntegrationFailure(
      deps,
      task,
      taskId,
      "Task commit SHA missing",
    );
  }

  task.status = "integrating";
  deps.updateState({ phase: "integrating" });

  const planTask = plan.tasks.find((t) => t.index === task.planIndex);
  if (!planTask) {
    return markIntegrationFailure(deps, task, taskId, "Plan task not found");
  }

  const integrationStartHead = await deps.git.head();
  const cleanBeforeIntegration = await ensureCleanMainCheckoutBeforeIntegration(
    deps,
    taskId,
    planArtifacts,
    integrationStartHead,
  );
  if (!cleanBeforeIntegration.ok) {
    return markIntegrationFailure(
      deps,
      task,
      taskId,
      cleanBeforeIntegration.reason,
    );
  }

  const preIntegrationHead = integrationStartHead;
  const planArtifactSnapshot = snapshotPlanArtifacts(planArtifacts);

  const failForRework = async (source: string, reason: string) => {
    await rollbackIntegration(
      deps,
      preIntegrationHead,
      planArtifacts,
      planArtifactSnapshot,
    );
    task.integrationAttempts++;
    task.lastReason = `${source}: ${reason}`;
    if (deps.paths) {
      persistTaskArtifact(
        deps.paths,
        taskId,
        "integration.md",
        `# Integration failed\n\nSource: ${source}\n\nPre-integration HEAD: ${preIntegrationHead}\n\n${reason}\n`,
      );
      appendEvent(deps.paths, {
        type: "integration_failed",
        taskId,
        reason: task.lastReason,
      });
    }
    if (task.integrationAttempts > MAX_REWORK_ATTEMPTS) {
      task.status = "integration_failed";
      return "integration_failed" as const;
    }
    task.status = "needs_rework";
    return "needs_rework" as const;
  };

  const failBlocked = async (source: string, reason: string) => {
    await rollbackIntegration(
      deps,
      preIntegrationHead,
      planArtifacts,
      planArtifactSnapshot,
    );
    task.integrationAttempts++;
    task.status = "integration_failed";
    task.lastReason = `${source}: ${reason}`;
    if (deps.paths) {
      persistTaskArtifact(
        deps.paths,
        taskId,
        "integration.md",
        `# Integration blocked\n\nSource: ${source}\n\nPre-integration HEAD: ${preIntegrationHead}\n\n${reason}\n`,
      );
      appendEvent(deps.paths, {
        type: "integration_failed",
        taskId,
        reason: task.lastReason,
      });
      const existing = readTaskJson(deps.paths, taskId);
      writeTaskJson(deps.paths, taskId, {
        ...buildTaskJsonSnapshot(existing, task),
        status: "integration_failed",
        lastReason: task.lastReason,
      });
    }
    return "integration_failed" as const;
  };

  try {
    task.selfHealAttempts = 0;

    // ── Cherry-pick with optional self-heal ──
    let cherryPick = await deps.git.cherryPickNoCommit(task.taskCommitSha);
    let cherryPickSucceeded = cherryPick.exitCode === 0;
    if (!cherryPickSucceeded) {
      const preHealStagedPaths = parseNameStatusPaths(
        await deps.git.stagedNameStatus(),
      );
      const preHealSnapshot: IntegrationCandidateSnapshot = {
        head: preIntegrationHead,
        stagedFingerprint: "",
        worktreeFingerprint: "",
        stagedPaths: preHealStagedPaths,
      };
      const healResult = await tryIntegrationSelfHeal(
        deps,
        task,
        taskId,
        plan,
        planArtifacts,
        preIntegrationHead,
        planArtifactSnapshot,
        "cherry-pick",
        cherryPick.stderr ||
          cherryPick.stdout ||
          "git cherry-pick --no-commit failed",
      );
      // Always verify safety after a self-heal attempt, regardless of whether
      // the repair agent returned a retryable result.
      if (task.selfHealAttempts > 0) {
        await stageDeclaredSelfHealFiles(
          deps,
          healResult?.result,
          planArtifacts,
        );
        const safety = await checkSelfHealSafety(
          deps,
          preIntegrationHead,
          planArtifacts,
          planArtifactSnapshot,
          healResult?.result,
          preHealSnapshot,
        );
        if (safety) {
          return await failBlocked("self-heal", safety);
        }
      }
      if (healResult?.result.retryIntegration) {
        if (healResult.result.retryMode === "retry_cherry_pick") {
          await rollbackIntegration(
            deps,
            preIntegrationHead,
            planArtifacts,
            planArtifactSnapshot,
          );
          cherryPick = await deps.git.cherryPickNoCommit(task.taskCommitSha);
          cherryPickSucceeded = cherryPick.exitCode === 0;
        } else {
          cherryPickSucceeded = true;
        }
      }
      if (!cherryPickSucceeded) {
        return await failForRework(
          "cherry-pick",
          cherryPick.stderr ||
            cherryPick.stdout ||
            "git cherry-pick --no-commit failed",
        );
      }
    }

    let candidateSnapshot = await snapshotIntegrationCandidate(
      deps,
      planArtifacts,
    );

    // ── Validation with optional self-heal ──
    let validation = await validateIntegratedTask(
      deps,
      taskId,
      planArtifacts,
      task,
    );
    while (!validation.ok && task.selfHealAttempts < MAX_SELF_HEAL_ATTEMPTS) {
      const preHealSnapshot = candidateSnapshot;
      const healResult = await tryIntegrationSelfHeal(
        deps,
        task,
        taskId,
        plan,
        planArtifacts,
        preIntegrationHead,
        planArtifactSnapshot,
        "validation",
        validation.reason,
      );
      // Always verify safety after a self-heal attempt, regardless of whether
      // the repair agent returned a retryable result.
      if (task.selfHealAttempts > 0) {
        await stageDeclaredSelfHealFiles(
          deps,
          healResult?.result,
          planArtifacts,
        );
        const safety = await checkSelfHealSafety(
          deps,
          preIntegrationHead,
          planArtifacts,
          planArtifactSnapshot,
          healResult?.result,
          preHealSnapshot,
        );
        if (safety) {
          return await failBlocked("self-heal", safety);
        }
      }
      if (!healResult?.result.retryIntegration) {
        break;
      }

      if (healResult.result.retryMode === "retry_cherry_pick") {
        await rollbackIntegration(
          deps,
          preIntegrationHead,
          planArtifacts,
          planArtifactSnapshot,
        );
        const cp = await deps.git.cherryPickNoCommit(task.taskCommitSha);
        if (cp.exitCode !== 0) {
          return await failForRework(
            "cherry-pick",
            cp.stderr || cp.stdout || "git cherry-pick --no-commit failed",
          );
        }
      }

      candidateSnapshot = await snapshotIntegrationCandidate(
        deps,
        planArtifacts,
      );
      validation = await validateIntegratedTask(
        deps,
        taskId,
        planArtifacts,
        task,
      );
    }

    if (!validation.ok) {
      return await failForRework("validation", validation.reason);
    }
    const mutationReason = await detectIntegrationMutation(
      deps,
      planArtifacts,
      planArtifactSnapshot,
      candidateSnapshot,
    );
    if (mutationReason) {
      return await failBlocked("validation", mutationReason);
    }

    const commit = await deps.git.commit(
      task.approvedCommitMessage ?? `chore: implement ${task.title}`,
    );
    if (commit.exitCode !== 0) {
      return await failForRework(
        "commit-hook",
        commit.stderr || commit.stdout || "git commit failed",
      );
    }

    const landedHead = await deps.git.head();
    if (landedHead === preIntegrationHead) {
      return await failForRework(
        "commit",
        "Commit succeeded but HEAD did not advance",
      );
    }
    const changedPlanArtifactAfterCommit = changedSnapshotPath(
      planArtifacts,
      planArtifactSnapshot,
    );
    if (changedPlanArtifactAfterCommit) {
      return await failBlocked(
        "commit",
        `Commit hook changed a plan artifact: ${changedPlanArtifactAfterCommit}`,
      );
    }
    if (!(await deps.git.isCleanExcept(planArtifacts))) {
      return await failBlocked(
        "commit",
        "Commit succeeded but main checkout is dirty",
      );
    }

    task.status = "landed";
    task.landedCommitSha = landedHead;
    sched.landedOrder.push(taskId);

    if (deps.paths) {
      appendEvent(deps.paths, {
        type: "task_landed",
        taskId,
        commitSha: landedHead,
      });
      const existing = readTaskJson(deps.paths, taskId);
      writeTaskJson(deps.paths, taskId, {
        ...buildTaskJsonSnapshot(existing, task),
        status: "landed",
        landedCommitSha: landedHead,
      });
    }

    deps.updateState((prev) => ({
      currentMainHead: landedHead,
      ...checkpointPatch(
        prev,
        `\u2713 Task ${task.planIndex + 1}/${plan.tasks.length} landed @ ${landedHead.slice(0, 7)}`,
      ),
    }));
    return "landed";
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return await failForRework("integration", reason);
  }
}

function markIntegrationFailure(
  deps: OrchestratorDeps,
  task: SchedulerTask,
  taskId: string,
  reason: string,
): "integration_failed" {
  task.status = "integration_failed";
  task.lastReason = reason;
  if (deps.paths) {
    appendEvent(deps.paths, { type: "integration_failed", taskId, reason });
    const existing = readTaskJson(deps.paths, taskId);
    writeTaskJson(deps.paths, taskId, {
      ...buildTaskJsonSnapshot(existing, task),
      status: "integration_failed",
      lastReason: reason,
    });
  }
  return "integration_failed";
}

async function ensureCleanMainCheckoutBeforeIntegration(
  deps: OrchestratorDeps,
  taskId: string,
  planArtifacts: string[],
  expectedHead: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (await deps.git.isCleanExcept(planArtifacts)) {
    return { ok: true };
  }

  const statusBefore = await deps.git.status();
  if (deps.paths) {
    persistTaskArtifact(
      deps.paths,
      taskId,
      "pre-integration-dirty-status.txt",
      statusBefore,
    );
  }

  if ((await deps.git.head()) !== expectedHead) {
    return {
      ok: false,
      reason: `Main checkout dirty before integration and HEAD changed. Status:\n${statusBefore}`,
    };
  }

  const operation = await deps.git.activeOperation();
  if (operation) {
    return {
      ok: false,
      reason: `Main checkout has active ${operation} operation before integration. Status:\n${statusBefore}`,
    };
  }

  const { staged, unstaged, untracked } = await collectChangedPaths(deps);
  const dirtyPaths = [...staged, ...unstaged, ...untracked];
  const dirtyPlanArtifact = dirtyPaths.find((path) =>
    isPlanArtifactPath(path, planArtifacts, deps.planPath),
  );
  if (dirtyPlanArtifact) {
    return {
      ok: false,
      reason: `Main checkout dirty before integration includes a plan artifact: ${dirtyPlanArtifact}. Status:\n${statusBefore}`,
    };
  }

  await deps.git.reset();
  await deps.git.restoreWorktreeFromIndexExcept(planArtifacts);

  if (await deps.git.isCleanExcept(planArtifacts)) {
    if (deps.paths) {
      persistTaskArtifact(
        deps.paths,
        taskId,
        "pre-integration-cleanup.md",
        `# Pre-integration cleanup\n\nRemoved non-plan checkout residue before integration.\n\n## Status before\n\n\`\`\`\n${statusBefore}\n\`\`\`\n`,
      );
    }
    return { ok: true };
  }

  return {
    ok: false,
    reason: `Main checkout dirty before integration after cleanup. Status before:\n${statusBefore}\n\nStatus after:\n${await deps.git.status()}`,
  };
}

async function rollbackIntegration(
  deps: OrchestratorDeps,
  preIntegrationHead: string,
  planArtifacts: string[],
  planArtifactSnapshot: Map<string, string | undefined>,
): Promise<void> {
  await deps.git.cherryPickAbort().catch(async () => {
    await deps.git.resetHard(preIntegrationHead).catch(() => undefined);
  });
  await deps.git.resetHard(preIntegrationHead).catch(() => undefined);
  await deps.git
    .restoreWorktreeFromIndexExcept(planArtifacts)
    .catch(() => undefined);
  restorePlanArtifacts(planArtifacts, planArtifactSnapshot);
}

type IntegrationCandidateSnapshot = {
  head: string;
  stagedFingerprint: string;
  worktreeFingerprint: string;
  stagedPaths: string[];
};

async function snapshotIntegrationCandidate(
  deps: OrchestratorDeps,
  planArtifacts: string[],
): Promise<IntegrationCandidateSnapshot> {
  const [head, stagedFingerprint, worktreeFingerprint, stagedNameStatus] =
    await Promise.all([
      deps.git.head(),
      deps.git.stagedFingerprint(),
      deps.git.worktreeFingerprintExcept(planArtifacts),
      deps.git.stagedNameStatus(),
    ]);
  const stagedPaths = parseNameStatusPaths(stagedNameStatus);
  return { head, stagedFingerprint, worktreeFingerprint, stagedPaths };
}

async function detectIntegrationMutation(
  deps: OrchestratorDeps,
  planArtifacts: string[],
  planArtifactSnapshot: Map<string, string | undefined>,
  snapshot: IntegrationCandidateSnapshot,
): Promise<string | undefined> {
  if ((await deps.git.head()) !== snapshot.head) {
    return "Validation or integration review changed HEAD";
  }
  const changedPlanArtifact = changedSnapshotPath(
    planArtifacts,
    planArtifactSnapshot,
  );
  if (changedPlanArtifact) {
    return `Validation or integration review changed a plan artifact: ${changedPlanArtifact}`;
  }
  const stagedFingerprint = await deps.git.stagedFingerprint();
  if (stagedFingerprint !== snapshot.stagedFingerprint) {
    return "Validation or integration review changed the staged integration diff";
  }
  const worktreeFingerprint =
    await deps.git.worktreeFingerprintExcept(planArtifacts);
  if (worktreeFingerprint !== snapshot.worktreeFingerprint) {
    return "Validation or integration review changed the integration worktree";
  }
  return undefined;
}

async function tryIntegrationSelfHeal(
  deps: OrchestratorDeps,
  task: SchedulerTask,
  taskId: string,
  plan: ReturnType<typeof parsePlanFile>,
  planArtifacts: string[],
  preIntegrationHead: string,
  planArtifactSnapshot: Map<string, string | undefined>,
  failureSource: "cherry-pick" | "validation",
  failureDetails: string,
): Promise<{ ok: true; result: IntegrationSelfHealResult } | undefined> {
  if (task.selfHealAttempts >= MAX_SELF_HEAL_ATTEMPTS) {
    return undefined;
  }
  task.selfHealAttempts++;

  const landedTasks = deps.paths ? getLandedTasks(deps.paths) : undefined;
  const graphContext = deps.paths
    ? buildGraphContext(deps.paths.runDir)
    : undefined;
  const runArtifactPaths = deps.paths
    ? collectRunArtifactPaths(deps.paths, taskId)
    : undefined;
  const prompt = buildIntegrationSelfHealPrompt({
    taskId,
    title: task.title,
    planIndex: task.planIndex - 1,
    taskCommitSha: task.taskCommitSha!,
    preIntegrationHead,
    mainCheckoutPath: await deps.git.root(),
    worktreePath: task.worktreePath,
    validationCommands: deps.verifyCommand ? [deps.verifyCommand] : undefined,
    validationFailure:
      failureSource === "validation" ? failureDetails : undefined,
    cherryPickFailure:
      failureSource === "cherry-pick" ? failureDetails : undefined,
    landedTasks,
    runArtifactPaths,
    graphContext,
  });

  if (deps.paths) {
    appendEvent(deps.paths, {
      type: "self_heal_started",
      taskId,
      attempt: task.selfHealAttempts,
    });
    persistTaskArtifact(
      deps.paths,
      taskId,
      `self-heal-${task.selfHealAttempts}.md`,
      prompt,
    );
  }

  const id = await deps.subagents.spawn({
    type: deps.roles.selfHeal.type,
    prompt,
    description: `integration self-heal ${taskId}`,
    model: deps.roles.selfHeal.model,
    thinking: deps.roles.selfHeal.thinking,
    role: "selfHeal",
    taskId,
    cwd: task.worktreePath,
  });
  const ref: AgentDisplayRef = {
    id,
    role: "implementer",
    label: `Integration self-heal \u00b7 ${taskId}`,
    startedAt: new Date().toISOString(),
  };
  setSchedulerActiveAgent(task, ref);
  deps.updateState((prev) => addActiveAgentPatch(prev, ref));

  const result = await deps.subagents.waitFor(id, deps.signal).finally(() => {
    clearSchedulerActiveAgent(task, id);
    deps.updateState((prev) => removeActiveAgentPatch(prev, id));
  });

  if (result.status !== "completed") {
    if (deps.paths) {
      appendEvent(deps.paths, {
        type: "self_heal_failed",
        taskId,
        attempt: task.selfHealAttempts,
        reason: result.status === "stopped" ? "stopped" : result.error,
      });
    }
    return undefined;
  }

  if (deps.paths) {
    persistTaskArtifact(
      deps.paths,
      taskId,
      `self-heal-${task.selfHealAttempts}-result.md`,
      result.result,
    );
    appendEvent(deps.paths, {
      type: "self_heal_completed",
      taskId,
      attempt: task.selfHealAttempts,
      result: result.result,
    });
  }

  const parsed = parseIntegrationSelfHealResult(result.result);
  if (!parsed.ok) {
    if (deps.paths) {
      appendEvent(deps.paths, {
        type: "self_heal_failed",
        taskId,
        attempt: task.selfHealAttempts,
        reason: parsed.reason,
      });
    }
    return undefined;
  }

  return parsed;
}

async function stageDeclaredSelfHealFiles(
  deps: OrchestratorDeps,
  healResult: IntegrationSelfHealResult | undefined,
  planArtifacts: string[],
): Promise<void> {
  if (
    !healResult?.retryIntegration ||
    healResult.retryMode === "retry_cherry_pick"
  ) {
    return;
  }
  const files = (healResult.filesChanged ?? []).filter(
    (path) => !isPlanArtifactPath(path, planArtifacts, deps.planPath),
  );
  if (files.length > 0) {
    await deps.git.stagePaths(files);
  }
}

async function checkSelfHealSafety(
  deps: OrchestratorDeps,
  preIntegrationHead: string,
  planArtifacts: string[],
  planArtifactSnapshot: Map<string, string | undefined>,
  healResult: IntegrationSelfHealResult | undefined,
  preHealSnapshot?: IntegrationCandidateSnapshot,
): Promise<string | undefined> {
  if ((await deps.git.head()) !== preIntegrationHead) {
    return "Self-heal changed HEAD";
  }
  const changedPlanArtifact = changedSnapshotPath(
    planArtifacts,
    planArtifactSnapshot,
  );
  if (changedPlanArtifact) {
    return `Self-heal changed a plan artifact: ${changedPlanArtifact}`;
  }
  if (preHealSnapshot && (await deps.git.head()) !== preHealSnapshot.head) {
    return "Self-heal changed HEAD relative to pre-heal snapshot";
  }

  const { unstaged, untracked } = await collectChangedPaths(deps);

  const allowedUntracked = new Set<string>();
  const allowedUnstaged = new Set<string>();

  if (indicatesDependencyInstallation(healResult)) {
    for (const path of untracked) {
      if (isPackageManagerFile(path)) {
        allowedUntracked.add(path);
      }
    }
    for (const path of unstaged) {
      if (isPackageManagerFile(path)) {
        allowedUnstaged.add(path);
      }
    }
  }

  const disallowedUntracked = untracked.filter((p) => !allowedUntracked.has(p));
  const disallowedUnstaged = unstaged.filter((p) => !allowedUnstaged.has(p));

  if (disallowedUntracked.length > 0) {
    return `Self-heal left unexpected untracked files: ${disallowedUntracked.join(", ")}`;
  }
  if (disallowedUnstaged.length > 0) {
    return `Self-heal left unexpected unstaged changes: ${disallowedUnstaged.join(", ")}`;
  }

  return undefined;
}

// ── Scheduler self-heal ───────────────────────────────────────────────────

type SchedulerSelfHealProgress = {
  attempted: boolean;
  attempts: number;
  hasProgress: boolean;
  remainingBlocker?: string;
};

async function attemptSchedulerSelfHeal(
  deps: OrchestratorDeps,
  sched: SchedulerRun,
  graph: ImplementGraph,
  plan: ReturnType<typeof parsePlanFile>,
  planArtifacts: string[],
  currentAttempts: number,
): Promise<SchedulerSelfHealProgress> {
  const baseline = await captureSchedulerSelfHealBaseline(
    deps,
    sched,
    planArtifacts,
  );
  const healResult = await trySchedulerSelfHeal(
    deps,
    sched,
    graph,
    plan,
    planArtifacts,
    currentAttempts,
  );
  if (!healResult?.ok) {
    return {
      attempted: false,
      attempts: currentAttempts,
      hasProgress: false,
    };
  }

  const attempts = currentAttempts + 1;
  const progress = await checkSchedulerSelfHealProgress(
    deps,
    sched,
    planArtifacts,
    baseline,
    healResult.result,
  );
  if (progress.hasProgress) {
    for (const taskId of progress.revivedTaskIds) {
      reviveTaskForSchedulerRetry(deps, sched, taskId);
    }
  }

  return {
    attempted: true,
    attempts,
    hasProgress: progress.hasProgress,
    remainingBlocker: healResult.result.remainingBlocker ?? undefined,
  };
}

async function trySchedulerSelfHeal(
  deps: OrchestratorDeps,
  sched: SchedulerRun,
  graph: ImplementGraph,
  plan: ReturnType<typeof parsePlanFile>,
  planArtifacts: string[],
  currentAttempts: number,
): Promise<{ ok: true; result: SchedulerSelfHealResult } | undefined> {
  if (currentAttempts >= MAX_SELF_HEAL_ATTEMPTS) {
    return undefined;
  }

  const baseSha = graph.baseSha;
  const currentHead = await deps.git.head();
  const gitStatus = await deps.git.status();
  const runId = deps.runId ?? "run";
  const matchingBranches = await deps.git.listBranchesMatching(
    `pi-implement/${runId}/*`,
  );
  const worktrees = await deps.git.listWorktrees();

  const graphSummary = buildSchedulerGraphSummary(sched, graph);

  const eventsTail = deps.paths
    ? readEvents(deps.paths)
        .slice(-20)
        .map((e) => JSON.stringify(e))
        .join("\n")
    : "";

  const artifactPaths: string[] = [];
  for (const task of sched.tasks.values()) {
    if (deps.paths) {
      const taskArtifacts = collectRunArtifactPaths(deps.paths, task.id);
      if (taskArtifacts) {
        artifactPaths.push(...taskArtifacts);
      }
    }
  }

  const prompt = buildSchedulerSelfHealPrompt({
    runId,
    mode: deps.mode,
    maxConcurrency: deps.maxConcurrency,
    baseSha,
    currentHead,
    planPath: deps.planPath,
    graphSummary,
    eventsTail,
    artifactPaths: artifactPaths.length > 0 ? artifactPaths : undefined,
    gitStatus,
    matchingBranches,
    worktrees,
  });

  if (deps.paths) {
    appendEvent(deps.paths, {
      type: "scheduler_self_heal_started",
      attempt: currentAttempts + 1,
    });
  }

  try {
    const id = await deps.subagents.spawn({
      type: deps.roles.selfHeal.type,
      prompt,
      description: `scheduler self-heal ${runId}`,
      model: deps.roles.selfHeal.model,
      thinking: deps.roles.selfHeal.thinking,
      role: "selfHeal",
      cwd: await deps.git.root(),
    });
    const ref: AgentDisplayRef = {
      id,
      role: "implementer",
      label: `Scheduler self-heal \u00b7 ${runId}`,
      startedAt: new Date().toISOString(),
    };
    deps.updateState((prev) => addActiveAgentPatch(prev, ref));

    const result = await deps.subagents.waitFor(id, deps.signal).finally(() => {
      deps.updateState((prev) => removeActiveAgentPatch(prev, id));
    });

    if (result.status !== "completed") {
      if (deps.paths) {
        appendEvent(deps.paths, {
          type: "scheduler_self_heal_failed",
          attempt: currentAttempts + 1,
          reason: result.status === "stopped" ? "stopped" : result.error,
        });
      }
      return undefined;
    }

    if (deps.paths) {
      appendEvent(deps.paths, {
        type: "scheduler_self_heal_completed",
        attempt: currentAttempts + 1,
        result: result.result,
      });
    }

    const parsed = parseSchedulerSelfHealResult(result.result);
    if (!parsed.ok) {
      if (deps.paths) {
        appendEvent(deps.paths, {
          type: "scheduler_self_heal_failed",
          attempt: currentAttempts + 1,
          reason: parsed.reason,
        });
      }
      return undefined;
    }

    return parsed;
  } catch {
    return undefined;
  }
}

type SchedulerSelfHealBaseline = {
  head: string;
  planArtifactSnapshot: Map<string, string | undefined>;
  gitStatusText: string;
  wasClean: boolean;
  branches: string[];
  worktrees: string[];
  taskStates: Map<string, { status: SchedulerTaskStatus; lastReason?: string }>;
  taskJsonStates: Map<string, TaskJson | undefined>;
  runJson: unknown;
  graphJson: unknown;
  lockJson: unknown;
  setupBlockers: Map<
    string,
    { branchExists: boolean; worktreeExists: boolean; aheadOfBase: boolean }
  >;
};

export async function captureSchedulerSelfHealBaseline(
  deps: OrchestratorDeps,
  sched: SchedulerRun,
  planArtifacts: string[],
): Promise<SchedulerSelfHealBaseline> {
  const head = await deps.git.head();
  const planArtifactSnapshot = snapshotPlanArtifacts(planArtifacts);
  const gitStatusText = await deps.git.status();
  const wasClean = await deps.git.isCleanExcept(planArtifacts);
  const runId = deps.runId ?? "run";
  const branches = await deps.git.listBranchesMatching(
    `pi-implement/${runId}/*`,
  );
  const worktrees = await deps.git.listWorktrees();
  const taskStates = new Map<
    string,
    { status: SchedulerTaskStatus; lastReason?: string }
  >();
  const taskJsonStates = new Map<string, TaskJson | undefined>();
  const setupBlockers = new Map<
    string,
    { branchExists: boolean; worktreeExists: boolean; aheadOfBase: boolean }
  >();
  const runJson = deps.paths ? readJsonFile(deps.paths.runJson) : undefined;
  const graphJson = deps.paths
    ? readJsonFile(join(deps.paths.runDir, "graph.json"))
    : undefined;
  const lockJson = deps.paths ? readJsonFile(deps.paths.lockFile) : undefined;

  for (const task of sched.tasks.values()) {
    taskStates.set(task.id, {
      status: task.status,
      lastReason: task.lastReason,
    });
    if (deps.paths) {
      const onDisk = readTaskJson(deps.paths, task.id);
      taskJsonStates.set(task.id, onDisk);
    }
    if (isSetupBlockedTask(task)) {
      const branchName = `pi-implement/${runId}/${task.id}`;
      const worktreePath = deps.paths
        ? join(deps.paths.worktreesDir, task.id)
        : undefined;
      const taskJson = deps.paths
        ? readTaskJson(deps.paths, task.id)
        : undefined;
      const taskBaseSha = taskJson?.baseSha ?? head;
      setupBlockers.set(task.id, {
        branchExists: branches.some((b) => b === branchName),
        worktreeExists: worktreePath
          ? worktrees.some((wt) => wt === worktreePath)
          : false,
        aheadOfBase: branches.some((b) => b === branchName)
          ? await deps.git.aheadOfBase(branchName, taskBaseSha)
          : false,
      });
    }
  }

  return {
    head,
    planArtifactSnapshot,
    gitStatusText,
    wasClean,
    branches,
    worktrees,
    taskStates,
    taskJsonStates,
    runJson,
    graphJson,
    lockJson,
    setupBlockers,
  };
}

export async function checkSchedulerSelfHealProgress(
  deps: OrchestratorDeps,
  sched: SchedulerRun,
  planArtifacts: string[],
  baseline: SchedulerSelfHealBaseline,
  healResult: SchedulerSelfHealResult,
): Promise<{ hasProgress: boolean; revivedTaskIds: string[] }> {
  const revivedTaskIds: string[] = [];

  if (!healResult.retryScheduler) {
    return { hasProgress: false, revivedTaskIds };
  }

  if (baseline.setupBlockers.size > 0 && !deps.paths) {
    return { hasProgress: false, revivedTaskIds };
  }

  if (
    deps.paths &&
    !restoreSchedulerSelfHealDurableState(deps.paths, baseline)
  ) {
    return { hasProgress: false, revivedTaskIds };
  }

  // Post-heal safety checks
  const currentHead = await deps.git.head();
  if (currentHead !== baseline.head) {
    return { hasProgress: false, revivedTaskIds };
  }

  const changedPlanArtifact = changedSnapshotPath(
    planArtifacts,
    baseline.planArtifactSnapshot,
  );
  if (changedPlanArtifact) {
    return { hasProgress: false, revivedTaskIds };
  }

  // Task state integrity: in-memory status/lastReason must match baseline.
  // The self-heal agent must not mutate orchestrator task state.
  for (const [taskId, preState] of baseline.taskStates) {
    const task = sched.tasks.get(taskId);
    if (!task) {
      continue;
    }
    if (
      task.status !== preState.status ||
      task.lastReason !== preState.lastReason
    ) {
      return { hasProgress: false, revivedTaskIds };
    }
  }

  const isDependencyInstall =
    indicatesSchedulerDependencyInstallation(healResult);
  const { staged, unstaged, untracked } = await collectChangedPaths(deps);
  if (hasNonPlanChangedPath(staged, planArtifacts, deps.planPath)) {
    return { hasProgress: false, revivedTaskIds };
  }
  if (hasNonPlanChangedPath(unstaged, planArtifacts, deps.planPath)) {
    return { hasProgress: false, revivedTaskIds };
  }
  if (hasNonPlanChangedPath(untracked, planArtifacts, deps.planPath)) {
    return { hasProgress: false, revivedTaskIds };
  }

  const runId = deps.runId ?? "run";
  const currentBranches = await deps.git.listBranchesMatching(
    `pi-implement/${runId}/*`,
  );
  const currentWorktrees = await deps.git.listWorktrees();
  const currentClean = await deps.git.isCleanExcept(planArtifacts);

  if (isDependencyInstall && !currentClean) {
    return { hasProgress: false, revivedTaskIds };
  }

  // Observable progress: retryable setup-blocked task became clean.
  if (!baseline.wasClean && currentClean) {
    for (const task of sched.tasks.values()) {
      if (
        isMainCheckoutDirtySetupFailure(task.lastReason) &&
        task.dependsOn.every((depId) => {
          const dep = sched.tasks.get(depId);
          return dep?.status === "landed" || dep?.status === "satisfied";
        })
      ) {
        revivedTaskIds.push(task.id);
      }
    }
  }

  // Observable progress: stale branch/worktree removed for a setup-blocked task
  for (const [taskId, preBlocker] of baseline.setupBlockers) {
    const task = sched.tasks.get(taskId);
    if (!task) {
      continue;
    }
    if (!isSetupBlockedTask(task)) {
      continue;
    }
    const depsComplete = task.dependsOn.every((depId) => {
      const dep = sched.tasks.get(depId);
      return dep?.status === "landed" || dep?.status === "satisfied";
    });
    if (!depsComplete) {
      continue;
    }
    if (preBlocker.aheadOfBase) {
      continue;
    }

    const branchName = `pi-implement/${runId}/${taskId}`;
    const worktreePath = deps.paths
      ? join(deps.paths.worktreesDir, taskId)
      : undefined;

    const branchStillExists = currentBranches.some((b) => b === branchName);
    const worktreeStillExists = worktreePath
      ? currentWorktrees.some((wt) => wt === worktreePath)
      : false;

    const branchRemoved = preBlocker.branchExists && !branchStillExists;
    const worktreeRemoved = preBlocker.worktreeExists && !worktreeStillExists;

    if (branchRemoved || worktreeRemoved) {
      const repairNamesTask =
        (healResult.summary?.includes(taskId) ?? false) ||
        (healResult.commands?.some(
          (cmd) =>
            cmd.includes(branchName) ||
            (worktreePath ? cmd.includes(worktreePath) : false),
        ) ??
          false);

      if (repairNamesTask) {
        revivedTaskIds.push(taskId);
      }
    }
  }

  if (revivedTaskIds.length > 0) {
    return { hasProgress: true, revivedTaskIds: [...new Set(revivedTaskIds)] };
  }

  // Observable progress: interrupted/dirty scheduler state was cleared
  if (!baseline.wasClean && currentClean) {
    return { hasProgress: true, revivedTaskIds };
  }

  // Observable progress: dependency installation with clean/ignored git status
  if (isDependencyInstall && currentClean) {
    return { hasProgress: true, revivedTaskIds };
  }

  return { hasProgress: false, revivedTaskIds };
}

function restoreSchedulerSelfHealDurableState(
  paths: StatePaths,
  baseline: SchedulerSelfHealBaseline,
): boolean {
  if (
    !isObjectWithRunId(baseline.runJson) ||
    !isObjectWithRunId(baseline.graphJson) ||
    !isObjectWithRunId(baseline.lockJson)
  ) {
    return false;
  }

  const currentRunJson = readJsonFile(paths.runJson);
  if (!deepEqualJson(currentRunJson, baseline.runJson)) {
    writeRunJson(paths, baseline.runJson as never);
  }

  const currentGraphJson = readJsonFile(join(paths.runDir, "graph.json"));
  if (!deepEqualJson(currentGraphJson, baseline.graphJson)) {
    writeGraphJson(paths.runDir, baseline.graphJson as never);
  }

  if (!existsSync(paths.lockFile)) {
    return false;
  }
  const currentLockJson = readJsonFile(paths.lockFile);
  if (!isObjectWithRunId(currentLockJson)) {
    return false;
  }
  if (currentLockJson.runId !== baseline.lockJson.runId) {
    return false;
  }
  if (!deepEqualJson(currentLockJson, baseline.lockJson)) {
    writeAtomicJson(paths.lockFile, baseline.lockJson);
  }

  for (const [taskId, preDiskState] of baseline.taskJsonStates) {
    const onDisk = readTaskJson(paths, taskId);
    if (!preDiskState) {
      if (onDisk) {
        rmSync(join(paths.tasksDir, taskId, "task.json"), { force: true });
      }
      continue;
    }
    if (!onDisk) {
      writeTaskJson(paths, taskId, preDiskState);
      continue;
    }
    if (!deepEqualJson(onDisk, preDiskState)) {
      writeTaskJson(paths, taskId, preDiskState);
    }
  }

  return true;
}

function readJsonFile<T = unknown>(path: string): T | undefined {
  if (!existsSync(path)) {
    return undefined;
  }
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as T;
  } catch {
    return undefined;
  }
}

function writeAtomicJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), "utf-8");
  renameSync(tmp, path);
}

function isObjectWithRunId(value: unknown): value is { runId: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as { runId?: unknown }).runId === "string"
  );
}

function deepEqualJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function hasNonPlanChangedPath(
  paths: string[],
  planArtifacts: string[],
  planPath: string,
): boolean {
  return paths.some(
    (path) => !isPlanArtifactPath(path, planArtifacts, planPath),
  );
}

function isPlanArtifactPath(
  path: string,
  planArtifacts: string[],
  planPath: string,
): boolean {
  const normalized = normalizeStatusPath(path);
  return planArtifacts.some((artifact) => {
    const normalizedArtifact = normalizeStatusPath(artifact);
    if (normalized === normalizedArtifact) {
      return true;
    }
    if (!isAbsolute(artifact)) {
      return false;
    }
    const relativeArtifact = normalizeStatusPath(
      relative(dirname(planPath), artifact),
    );
    return normalized === relativeArtifact;
  });
}

function normalizeStatusPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

function isSetupBlockedTask(task: SchedulerTask): boolean {
  return (
    (task.status === "failed" || task.status === "integration_failed") &&
    isSetupFailureReason(task.lastReason)
  );
}

function isMainCheckoutDirtySetupFailure(reason: string | undefined): boolean {
  return /Main checkout dirty before integration/i.test(reason ?? "");
}

function isSetupFailureReason(reason: string | undefined): boolean {
  if (!reason) {
    return false;
  }
  const setupPatterns = [
    /Worktree setup failed/i,
    /branch .* already exists/i,
    /worktree .* already exists/i,
    /interrupted git operation/i,
    /Main checkout dirty before integration/i,
  ];
  return setupPatterns.some((p) => p.test(reason));
}

function reviveTaskForSchedulerRetry(
  deps: OrchestratorDeps,
  sched: SchedulerRun,
  taskId: string,
): void {
  const task = sched.tasks.get(taskId);
  if (!task) {
    return;
  }
  const retryIntegration =
    task.status === "integration_failed" &&
    task.taskCommitSha !== undefined &&
    isMainCheckoutDirtySetupFailure(task.lastReason);
  task.status = retryIntegration ? "approved" : "needs_rework";
  task.activeAgentIds = [];
  task.activeAgentRefs = [];
  task.lastReason = retryIntegration
    ? "self-heal cleaned main checkout; retrying integration"
    : "self-heal repaired setup blocker; retrying";
  if (deps.paths) {
    const existing = readTaskJson(deps.paths, taskId);
    writeTaskJson(deps.paths, taskId, {
      ...buildTaskJsonSnapshot(existing, task),
      status: task.status,
      activeSubagentIds: [],
      lastReason: task.lastReason,
    });
    appendEvent(deps.paths, {
      type: "task_self_heal_requeued",
      taskId,
      reason: task.lastReason,
    });
  }
}

export function buildSchedulerGraphSummary(
  sched: SchedulerRun,
  graph: ImplementGraph,
): string {
  const lines: string[] = [
    `Run ID: ${graph.runId}`,
    `Base SHA: ${graph.baseSha}`,
    `Plan: ${graph.planPath}`,
    `Nodes (${graph.nodes.length}):`,
  ];
  for (const node of graph.nodes) {
    const task = sched.tasks.get(node.id);
    const deps =
      node.dependsOn.length > 0
        ? ` dependsOn: [${node.dependsOn.join(", ")}]`
        : "";
    lines.push(
      `- ${node.id}: ${node.title} (plan ${node.planIndex}, mode: ${node.mode}, status: ${task?.status ?? "pending"}${deps})`,
    );
    if (task?.lastReason) {
      lines.push(`  lastReason: ${task.lastReason}`);
    }
    if (task?.taskCommitSha) {
      lines.push(`  taskCommitSha: ${task.taskCommitSha}`);
    }
    if (task?.landedCommitSha) {
      lines.push(`  landedCommitSha: ${task.landedCommitSha}`);
    }
    if (task?.worktreePath) {
      lines.push(`  worktree: ${task.worktreePath}`);
    }
    if (task?.branchName) {
      lines.push(`  branch: ${task.branchName}`);
    }
    if (task?.activeAgentIds && task.activeAgentIds.length > 0) {
      lines.push(`  activeAgents: [${task.activeAgentIds.join(", ")}]`);
    } else {
      lines.push(`  activeAgents: (none)`);
    }
  }
  return lines.join("\n");
}

async function collectChangedPaths(deps: OrchestratorDeps): Promise<{
  staged: string[];
  unstaged: string[];
  untracked: string[];
}> {
  const status = await deps.git.status();
  const staged: string[] = [];
  const unstaged: string[] = [];
  const untracked: string[] = [];

  for (const line of status.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    const xy = line.slice(0, 2);
    const rest = line.slice(3);
    let path = rest;
    if (rest.includes(" -> ")) {
      path = rest.split(" -> ").pop()!;
    }
    path = path.trim();

    if (xy[0] !== " " && xy[0] !== "?") {
      staged.push(path);
    }
    if (xy === "??") {
      untracked.push(path);
    } else if (xy[1] !== " ") {
      unstaged.push(path);
    }
  }

  return { staged, unstaged, untracked };
}

function parseNameStatusPaths(nameStatus: string): string[] {
  const paths: string[] = [];
  for (const line of nameStatus.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    const parts = trimmed.split("\t");
    if (parts.length >= 2) {
      paths.push(parts[parts.length - 1]!);
    }
  }
  return paths;
}

function isPackageManagerFile(path: string): boolean {
  const name = path.split("/").pop() ?? path;
  return [
    "package-lock.json",
    "npm-shrinkwrap.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    ".npmrc",
  ].includes(name);
}

function indicatesDependencyInstallation(
  result: IntegrationSelfHealResult | undefined,
): boolean {
  if (!result?.commands) {
    return false;
  }
  const installPattern = /^(npm|pnpm|yarn)\s+(install|ci|add)/;
  return result.commands.some((cmd) => installPattern.test(cmd.trim()));
}

function indicatesSchedulerDependencyInstallation(
  result: SchedulerSelfHealResult | undefined,
): boolean {
  if (!result?.commands) {
    return false;
  }
  const installPattern = /^(npm|pnpm|yarn)\s+(install|ci|add)/;
  return result.commands.some((cmd) => installPattern.test(cmd.trim()));
}

function getLandedTasks(
  paths: StatePaths,
): Array<{ id: string; title: string; commitSha?: string }> {
  const events = readEvents(paths);
  const completionEvents = events.filter(
    (e) => e.type === "task_landed" || e.type === "task_satisfied",
  );
  const seen = new Set<string>();
  const landedTasks: Array<{
    id: string;
    title: string;
    commitSha?: string;
  }> = [];
  for (const ev of completionEvents) {
    if (seen.has(ev.taskId)) {
      continue;
    }
    seen.add(ev.taskId);
    const taskJson = readTaskJson(paths, ev.taskId);
    if (taskJson) {
      landedTasks.push({
        id: taskJson.id,
        title: taskJson.title,
        commitSha: taskJson.landedCommitSha,
      });
    }
  }
  return landedTasks;
}

function buildGraphContext(runDir: string): string | undefined {
  const graph = readGraphJson(runDir);
  if (!graph) {
    return undefined;
  }
  const lines = [
    `Run ID: ${graph.runId}`,
    `Base SHA: ${graph.baseSha}`,
    `Plan: ${graph.planPath}`,
    `Nodes (${graph.nodes.length}):`,
  ];
  for (const node of graph.nodes) {
    const deps =
      node.dependsOn.length > 0
        ? ` dependsOn: [${node.dependsOn.join(", ")}]`
        : "";
    lines.push(
      `- ${node.id}: ${node.title} (plan ${node.planIndex}, mode: ${node.mode}${deps})`,
    );
  }
  return lines.join("\n");
}

function collectRunArtifactPaths(
  paths: StatePaths,
  taskId: string,
): string[] | undefined {
  const artifactPaths: string[] = [];
  try {
    if (existsSync(paths.eventsJsonl)) {
      artifactPaths.push(paths.eventsJsonl);
    }
    if (existsSync(paths.runJson)) {
      artifactPaths.push(paths.runJson);
    }
    const graphPath = join(paths.runDir, "graph.json");
    if (existsSync(graphPath)) {
      artifactPaths.push(graphPath);
    }
    const taskDir = join(paths.tasksDir, taskId);
    if (existsSync(taskDir)) {
      for (const entry of readdirSync(taskDir, { withFileTypes: true })) {
        if (entry.isFile()) {
          artifactPaths.push(join(taskDir, entry.name));
        }
      }
    }
  } catch {
    return undefined;
  }
  return artifactPaths.length > 0 ? artifactPaths : undefined;
}

type ValidationResult = { ok: true } | { ok: false; reason: string };

async function validateIntegratedTask(
  deps: OrchestratorDeps,
  taskId: string,
  planArtifacts: string[],
  schedulerTask?: SchedulerTask,
): Promise<ValidationResult> {
  const commands = await resolveValidationCommands(deps);
  if (commands.length > 0) {
    for (const command of commands) {
      const result = await runValidationCommand(command, await deps.git.root());
      if (deps.paths) {
        persistTaskArtifact(
          deps.paths,
          taskId,
          `integration-${safeArtifactName(command.label)}.log`,
          `${command.display}\n\nexitCode: ${result.exitCode}\n\nSTDOUT\n${result.stdout}\n\nSTDERR\n${result.stderr}\n`,
        );
      }
      if (result.exitCode !== 0) {
        return {
          ok: false,
          reason: `${command.display} failed\n\n${result.stderr || result.stdout}`,
        };
      }
    }
    return { ok: true };
  }

  deps.updateState({
    lastReason:
      "parallel run with LLM-only verification — recommend setting verifyCommand",
  });
  const verdict = await runIntegrationReviewFallback(
    deps,
    taskId,
    planArtifacts,
    schedulerTask,
  );
  if (!verdict.ok) {
    return verdict;
  }
  return { ok: true };
}

async function validateFinalParallelRun(
  deps: OrchestratorDeps,
): Promise<ValidationResult> {
  const commands = await resolveValidationCommands(deps);
  for (const command of commands) {
    const result = await runValidationCommand(command, await deps.git.root());
    if (result.exitCode !== 0) {
      return {
        ok: false,
        reason: `Final validation failed: ${command.display}\n\n${result.stderr || result.stdout}`,
      };
    }
  }
  return { ok: true };
}

type ValidationCommand =
  | { kind: "shell"; label: string; display: string; command: string }
  | {
      kind: "exec";
      label: string;
      display: string;
      file: string;
      args: string[];
    };

async function resolveValidationCommands(
  deps: OrchestratorDeps,
): Promise<ValidationCommand[]> {
  if (deps.verifyCommand) {
    return [
      {
        kind: "shell",
        label: "verifyCommand",
        display: deps.verifyCommand,
        command: deps.verifyCommand,
      },
    ];
  }

  const root = await deps.git.root();
  const packageJsonPath = join(root, "package.json");
  if (!existsSync(packageJsonPath)) {
    return [];
  }

  let scripts: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as {
      scripts?: Record<string, unknown>;
    };
    scripts = parsed.scripts ?? {};
  } catch {
    return [];
  }

  const packageManager = detectPackageManager(root);
  const commands: ValidationCommand[] = [];
  for (const script of ["test", "typecheck", "build"]) {
    if (typeof scripts[script] !== "string") {
      continue;
    }
    commands.push({
      kind: "exec",
      label: script,
      display: `${packageManager.display} ${script}`,
      file: packageManager.file,
      args: [...packageManager.argsPrefix, script],
    });
  }
  return commands;
}

function detectPackageManager(root: string): {
  file: string;
  argsPrefix: string[];
  display: string;
} {
  if (existsSync(join(root, "pnpm-lock.yaml"))) {
    return { file: "pnpm", argsPrefix: [], display: "pnpm" };
  }
  if (existsSync(join(root, "yarn.lock"))) {
    return { file: "yarn", argsPrefix: [], display: "yarn" };
  }
  return { file: "npm", argsPrefix: ["run"], display: "npm run" };
}

async function runValidationCommand(
  command: ValidationCommand,
  cwd: string,
): Promise<CommandResult> {
  try {
    if (command.kind === "shell") {
      const result = await execAsync(command.command, {
        cwd,
        env: process.env,
        timeout: VALIDATION_TIMEOUT_MS,
        maxBuffer: 10 * 1024 * 1024,
      });
      return {
        command: command.display,
        exitCode: 0,
        stdout: result.stdout,
        stderr: result.stderr,
      };
    }
    const result = await execFileAsync(command.file, command.args, {
      cwd,
      env: process.env,
      timeout: VALIDATION_TIMEOUT_MS,
      maxBuffer: 10 * 1024 * 1024,
    });
    return {
      command: command.display,
      exitCode: 0,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  } catch (err) {
    const failed = err as Error & {
      code?: number | string;
      stdout?: string;
      stderr?: string;
      signal?: string;
    };
    return {
      command: command.display,
      exitCode: typeof failed.code === "number" ? failed.code : 1,
      stdout: failed.stdout ?? "",
      stderr: failed.signal
        ? `${failed.stderr ?? ""}\nTerminated by signal ${failed.signal}`
        : (failed.stderr ?? failed.message),
    };
  }
}

async function runIntegrationReviewFallback(
  deps: OrchestratorDeps,
  taskId: string,
  planArtifacts: string[],
  schedulerTask?: SchedulerTask,
): Promise<ValidationResult> {
  const diff = await deps.git.stagedDiff();
  const prompt = `Review this integrated parallel task diff on the main checkout.

No command validation is configured or auto-detected. Decide whether the integrated diff is safe to commit.

Do not edit files, stage, reset, commit, checkout, merge, rebase, clean, install dependencies, or run any command that changes files or git state. Use read-only commands only.

Plan artifacts are not part of the implementation commit and should be ignored: ${planArtifacts.join(", ")}

## Staged Diff

\`\`\`diff
${diff}
\`\`\`

End with exactly one tagged JSON result:
<pi-integration-review-result>{"verdict":"approved"}</pi-integration-review-result>

Or:
<pi-integration-review-result>{"verdict":"changes_requested","requiredChanges":["..."],"reason":"..."}</pi-integration-review-result>`;

  const id = await deps.subagents.spawn({
    type: deps.roles.reviewer.type,
    prompt,
    description: `integration review ${taskId}`,
    model: deps.roles.reviewer.model,
    thinking: deps.roles.reviewer.thinking,
    role: "reviewer",
    taskId,
    cwd: await deps.git.root(),
    readOnly: true,
  });
  const ref: AgentDisplayRef = {
    id,
    role: "reviewer",
    label: `Reviewer · Integration review · ${taskId}`,
    startedAt: new Date().toISOString(),
  };
  setSchedulerActiveAgent(schedulerTask, ref);
  deps.updateState((prev) => addActiveAgentPatch(prev, ref));
  const result = await deps.subagents.waitFor(id, deps.signal).finally(() => {
    clearSchedulerActiveAgent(schedulerTask, id);
    deps.updateState((prev) => removeActiveAgentPatch(prev, id));
  });
  if (result.status !== "completed") {
    return {
      ok: false,
      reason: `Integration review ${result.status}: ${result.error}`,
    };
  }
  if (deps.paths) {
    persistTaskArtifact(
      deps.paths,
      taskId,
      "integration-review.md",
      result.result,
    );
  }
  const verdict = parseIntegrationReviewVerdict(result.result);
  if (verdict.ok) {
    return { ok: true };
  }
  return { ok: false, reason: verdict.reason };
}

function parseIntegrationReviewVerdict(
  text: string,
): { ok: true } | { ok: false; reason: string } {
  const match = text.match(
    /<pi-integration-review-result>([\s\S]*?)<\/pi-integration-review-result>/,
  );
  if (!match?.[1]) {
    return { ok: false, reason: "Integration review result tag missing" };
  }
  try {
    const parsed = JSON.parse(match[1]) as {
      verdict?: unknown;
      requiredChanges?: unknown;
      reason?: unknown;
    };
    if (parsed.verdict === "approved") {
      return { ok: true };
    }
    const requiredChanges = Array.isArray(parsed.requiredChanges)
      ? parsed.requiredChanges.filter((v): v is string => typeof v === "string")
      : [];
    const reason =
      typeof parsed.reason === "string" && parsed.reason.trim()
        ? parsed.reason.trim()
        : requiredChanges.join("\n");
    return {
      ok: false,
      reason: reason || "Integration review requested changes",
    };
  } catch (err) {
    return {
      ok: false,
      reason: `Integration review JSON invalid: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export function nextOverallReviewArtifactPath(planPath: string): string {
  const base = planPath.replace(/\.md$/i, ".overall-review.md");
  if (!existsSync(base)) {
    return base;
  }
  let suffix = 2;
  for (;;) {
    const candidate = base.replace(/\.md$/i, `-${suffix}.md`);
    if (!existsSync(candidate)) {
      return candidate;
    }
    suffix++;
  }
}

type OverallReviewOutcome =
  | { verdict: "approved" }
  | {
      verdict: "changes_requested";
      requiredChanges: string[];
      recommendationMarkdown?: string;
      rawResult: string;
    };

async function runOverallReviewOnce(
  deps: OrchestratorDeps,
  plan: ReturnType<typeof parsePlanFile>,
  planArtifacts: string[],
  baseSha: string,
): Promise<OverallReviewOutcome> {
  throwIfStopped(deps);

  if (!(await deps.git.isCleanExcept(planArtifacts))) {
    throw new BlockedError("dirty worktree before final review");
  }

  const planContent = readFileSync(deps.planPath, "utf-8");
  const headSha = await deps.git.head();

  let bundleMaterial: string | undefined;
  if (deps.materialStore) {
    bundleMaterial = formatStoreBundleMaterial(deps.materialStore);
  } else if (deps.manifest) {
    bundleMaterial = formatBundleMaterial(deps.manifest);
  }

  let corpusMaterial: string | undefined;
  if (deps.materialStore) {
    corpusMaterial = formatStoreCorpusMaterial(deps.materialStore);
  } else if (deps.corpusMaterial) {
    corpusMaterial = deps.corpusMaterial;
  }

  if (baseSha === headSha) {
    return { verdict: "approved" };
  }

  const diff = await deps.git.diffRange(baseSha, headSha);

  const landedTasks = deps.paths ? getLandedTasks(deps.paths) : [];

  const prompt = buildOverallReviewerPrompt({
    planContent,
    planPath: deps.planPath,
    baseSha,
    headSha,
    diff,
    runId: deps.runId,
    landedTasks,
    bundleMaterial,
    corpusMaterial,
    executionManifest: deps.executionManifest,
  });

  deps.updateState({ phase: "final_review", activeSubagentId: undefined });

  const preReviewHead = await deps.git.head();
  const planArtifactSnapshot = snapshotPlanArtifacts(planArtifacts);
  const stagedFingerprint = await deps.git.stagedFingerprint();
  const worktreeFingerprint =
    await deps.git.worktreeFingerprintExcept(planArtifacts);

  const id = await deps.subagents.spawn({
    type: deps.roles.reviewer.type,
    prompt,
    description: "overall review",
    model: deps.roles.reviewer.model,
    thinking: deps.roles.reviewer.thinking,
    role: "reviewer",
    cwd: await deps.git.root(),
    readOnly: true,
  });
  const ref: AgentDisplayRef = {
    id,
    role: "reviewer",
    label: "Reviewer · Overall review",
    startedAt: new Date().toISOString(),
  };
  deps.updateState((prev) => addActiveAgentPatch(prev, ref));
  const result = await deps.subagents.waitFor(id, deps.signal).finally(() => {
    deps.updateState((prev) => removeActiveAgentPatch(prev, id));
  });

  if (result.status !== "completed") {
    throw new BlockedError(`Overall review ${result.status}: ${result.error}`);
  }

  // Boundary checks
  if ((await deps.git.head()) !== preReviewHead) {
    throw new BlockedError("overall reviewer changed HEAD");
  }
  const changedPlanArtifact = changedSnapshotPath(
    planArtifacts,
    planArtifactSnapshot,
  );
  if (changedPlanArtifact) {
    throw new BlockedError(
      `overall reviewer changed a plan artifact: ${changedPlanArtifact}`,
    );
  }
  const stagedFingerprintAfter = await deps.git.stagedFingerprint();
  if (stagedFingerprintAfter !== stagedFingerprint) {
    throw new BlockedError("overall reviewer changed staged state");
  }
  const worktreeFingerprintAfter =
    await deps.git.worktreeFingerprintExcept(planArtifacts);
  if (worktreeFingerprintAfter !== worktreeFingerprint) {
    throw new BlockedError("overall reviewer changed worktree state");
  }

  const verdict = parseOverallReviewVerdict(result.result);
  if (verdict.verdict === "approved") {
    return { verdict: "approved" };
  }

  return {
    verdict: "changes_requested",
    requiredChanges: verdict.requiredChanges,
    recommendationMarkdown: verdict.recommendationMarkdown,
    rawResult: result.result,
  };
}

type OverallReworkAttemptResult =
  | { ok: true; commitSha: string }
  | { ok: false; reason: string; blocking: boolean };

async function resetOverallRework(
  deps: OrchestratorDeps,
  preAttemptHead: string,
  planArtifacts: string[],
  planArtifactSnapshot: Map<string, string | undefined>,
): Promise<void> {
  await deps.git.resetHard(preAttemptHead).catch(() => undefined);
  await deps.git
    .restoreWorktreeFromIndexExcept(planArtifacts)
    .catch(() => undefined);
  restorePlanArtifacts(planArtifacts, planArtifactSnapshot);
}

async function runOverallReworkAttempt(
  deps: OrchestratorDeps,
  plan: ReturnType<typeof parsePlanFile>,
  planArtifacts: string[],
  runBaseSha: string,
  review: Extract<OverallReviewOutcome, { verdict: "changes_requested" }>,
  attemptNumber: number,
  priorAttemptFailures: string[],
): Promise<OverallReworkAttemptResult> {
  throwIfStopped(deps);

  if (!(await deps.git.isCleanExcept(planArtifacts))) {
    return {
      ok: false,
      reason: "dirty worktree before overall rework",
      blocking: true,
    };
  }

  const preAttemptHead = await deps.git.head();
  const planArtifactSnapshot = snapshotPlanArtifacts(planArtifacts);

  const headSha = await deps.git.head();
  const diff = await deps.git.diffRange(runBaseSha, headSha);

  const landedTasks = deps.paths ? getLandedTasks(deps.paths) : [];

  let bundleMaterial: string | undefined;
  if (deps.materialStore) {
    bundleMaterial = formatStoreBundleMaterial(deps.materialStore);
  } else if (deps.manifest) {
    bundleMaterial = formatBundleMaterial(deps.manifest);
  }

  let corpusMaterial: string | undefined;
  if (deps.materialStore) {
    corpusMaterial = formatStoreCorpusMaterial(deps.materialStore);
  } else if (deps.corpusMaterial) {
    corpusMaterial = deps.corpusMaterial;
  }

  const prompt = buildOverallReworkPrompt({
    planContent: readFileSync(deps.planPath, "utf-8"),
    planPath: deps.planPath,
    baseSha: runBaseSha,
    headSha,
    diff,
    runId: deps.runId,
    landedTasks,
    bundleMaterial,
    corpusMaterial,
    requiredChanges: review.requiredChanges,
    recommendationMarkdown: review.recommendationMarkdown,
    priorAttemptFailures,
    executionManifest: deps.executionManifest,
  });

  deps.updateState({ phase: "final_rework", activeSubagentId: undefined });

  if (deps.paths) {
    const artifactDir = join(deps.paths.runDir, "overall-review");
    mkdirSync(artifactDir, { recursive: true });
    const promptPath = join(artifactDir, `rework-prompt-${attemptNumber}.md`);
    writeFileSync(promptPath, prompt, "utf-8");
    appendEvent(deps.paths, {
      type: "overall_rework_started",
      attempt: attemptNumber,
      artifactPath: promptPath,
    });
  }

  deps.updateState((prev) =>
    checkpointPatch(prev, `Overall rework started (attempt ${attemptNumber})`),
  );

  const id = await deps.subagents.spawn({
    type: deps.roles.implementer.type,
    prompt,
    description: `overall rework attempt ${attemptNumber}`,
    model: deps.roles.implementer.model,
    thinking: deps.roles.implementer.thinking,
    role: "implementer",
    cwd: await deps.git.root(),
  });
  const ref: AgentDisplayRef = {
    id,
    role: "implementer",
    label: `Overall rework · attempt ${attemptNumber}`,
    startedAt: new Date().toISOString(),
  };
  deps.updateState((prev) => addActiveAgentPatch(prev, ref));
  const result = await deps.subagents.waitFor(id, deps.signal).finally(() => {
    deps.updateState((prev) => removeActiveAgentPatch(prev, id));
  });

  // Stopped
  if (result.status === "stopped") {
    await resetOverallRework(
      deps,
      preAttemptHead,
      planArtifacts,
      planArtifactSnapshot,
    );
    throw new StoppedError();
  }

  // Persist result when paths exist
  if (deps.paths && result.status === "completed") {
    const artifactDir = join(deps.paths.runDir, "overall-review");
    mkdirSync(artifactDir, { recursive: true });
    writeFileSync(
      join(artifactDir, `rework-result-${attemptNumber}.md`),
      result.result,
      "utf-8",
    );
  }

  // Failed subagent
  if (result.status !== "completed") {
    await resetOverallRework(
      deps,
      preAttemptHead,
      planArtifacts,
      planArtifactSnapshot,
    );
    if (deps.paths) {
      appendEvent(deps.paths, {
        type: "overall_rework_failed",
        attempt: attemptNumber,
        reason: result.error,
      });
    }
    return {
      ok: false,
      reason: `Implementer subagent failed: ${result.error}`,
      blocking: false,
    };
  }

  // Boundary checks
  if ((await deps.git.head()) !== preAttemptHead) {
    await resetOverallRework(
      deps,
      preAttemptHead,
      planArtifacts,
      planArtifactSnapshot,
    );
    return {
      ok: false,
      reason: "overall rework implementer changed HEAD",
      blocking: true,
    };
  }
  const changedPlanArtifact = changedSnapshotPath(
    planArtifacts,
    planArtifactSnapshot,
  );
  if (changedPlanArtifact) {
    await resetOverallRework(
      deps,
      preAttemptHead,
      planArtifacts,
      planArtifactSnapshot,
    );
    return {
      ok: false,
      reason: `overall rework implementer changed a plan artifact: ${changedPlanArtifact}`,
      blocking: true,
    };
  }

  // Parse result
  const parsed = parseOverallReworkResult(result.result);
  if (!parsed.ok) {
    await resetOverallRework(
      deps,
      preAttemptHead,
      planArtifacts,
      planArtifactSnapshot,
    );
    if (deps.paths) {
      appendEvent(deps.paths, {
        type: "overall_rework_failed",
        attempt: attemptNumber,
        reason: parsed.reason,
      });
    }
    return {
      ok: false,
      reason: `Invalid rework result: ${parsed.reason}`,
      blocking: false,
    };
  }

  // Stage all except plan artifacts
  await deps.git.stageAllExcept(planArtifacts);
  const hasStaged = await deps.git.hasStagedChanges();

  if (!hasStaged) {
    await resetOverallRework(
      deps,
      preAttemptHead,
      planArtifacts,
      planArtifactSnapshot,
    );
    if (deps.paths) {
      appendEvent(deps.paths, {
        type: "overall_rework_failed",
        attempt: attemptNumber,
        reason: "reworker produced no staged changes",
      });
    }
    return {
      ok: false,
      reason: "Overall reworker produced no staged changes",
      blocking: false,
    };
  }

  const stagedAfter = await deps.git.stagedFingerprint();
  const worktreeAfter = await deps.git.worktreeFingerprintExcept(planArtifacts);

  // Validation
  const validationCommands = await resolveValidationCommands(deps);
  const validationLogs: string[] = [];
  let validationFailureReason: string | undefined;
  if (validationCommands.length > 0) {
    for (const command of validationCommands) {
      const validationResult = await runValidationCommand(
        command,
        await deps.git.root(),
      );
      const log = `${command.display}\n\nexitCode: ${validationResult.exitCode}\n\nSTDOUT\n${validationResult.stdout}\n\nSTDERR\n${validationResult.stderr}\n`;
      validationLogs.push(log);
      if (deps.paths) {
        const artifactDir = join(deps.paths.runDir, "overall-review");
        mkdirSync(artifactDir, { recursive: true });
        writeFileSync(
          join(
            artifactDir,
            `rework-validation-${attemptNumber}-${safeArtifactName(command.label)}.log`,
          ),
          log,
          "utf-8",
        );
      }
      if (validationResult.exitCode !== 0) {
        validationFailureReason = `Validation failed: ${command.display}\n\n${validationResult.stderr || validationResult.stdout}`;
        break;
      }
    }
  }

  // Validation mutation detection — always run, even when validation failed
  const postValidationHead = await deps.git.head();
  const postValidationStaged = await deps.git.stagedFingerprint();
  const postValidationWorktree =
    await deps.git.worktreeFingerprintExcept(planArtifacts);
  const changedPlanArtifactAfterValidation = changedSnapshotPath(
    planArtifacts,
    planArtifactSnapshot,
  );

  if (postValidationHead !== preAttemptHead) {
    await resetOverallRework(
      deps,
      preAttemptHead,
      planArtifacts,
      planArtifactSnapshot,
    );
    return {
      ok: false,
      reason: "Validation changed HEAD during overall rework",
      blocking: true,
    };
  }
  if (changedPlanArtifactAfterValidation) {
    await resetOverallRework(
      deps,
      preAttemptHead,
      planArtifacts,
      planArtifactSnapshot,
    );
    return {
      ok: false,
      reason: `Validation changed a plan artifact during overall rework: ${changedPlanArtifactAfterValidation}`,
      blocking: true,
    };
  }
  if (postValidationStaged !== stagedAfter) {
    await resetOverallRework(
      deps,
      preAttemptHead,
      planArtifacts,
      planArtifactSnapshot,
    );
    return {
      ok: false,
      reason: "Validation changed staged state during overall rework",
      blocking: true,
    };
  }
  if (postValidationWorktree !== worktreeAfter) {
    await resetOverallRework(
      deps,
      preAttemptHead,
      planArtifacts,
      planArtifactSnapshot,
    );
    return {
      ok: false,
      reason: "Validation changed worktree state during overall rework",
      blocking: true,
    };
  }

  if (validationFailureReason) {
    await resetOverallRework(
      deps,
      preAttemptHead,
      planArtifacts,
      planArtifactSnapshot,
    );
    if (deps.paths) {
      appendEvent(deps.paths, {
        type: "overall_rework_failed",
        attempt: attemptNumber,
        reason: validationFailureReason,
      });
    }
    return {
      ok: false,
      reason: validationFailureReason,
      blocking: false,
    };
  }

  // Commit
  const commitMessage = isValidCommitMessage(parsed.result.commitMessage ?? "")
    ? parsed.result.commitMessage!
    : "fix: address overall review";

  const commit = await deps.git.commit(commitMessage);
  if (commit.exitCode !== 0) {
    await resetOverallRework(
      deps,
      preAttemptHead,
      planArtifacts,
      planArtifactSnapshot,
    );
    if (deps.paths) {
      appendEvent(deps.paths, {
        type: "overall_rework_failed",
        attempt: attemptNumber,
        reason: `commit-hook failure: ${commit.stderr || commit.stdout}`,
      });
    }
    return {
      ok: false,
      reason: `Commit hook failed: ${commit.stderr || commit.stdout}`,
      blocking: false,
    };
  }

  const postCommitHead = await deps.git.head();
  if (postCommitHead === preAttemptHead) {
    await resetOverallRework(
      deps,
      preAttemptHead,
      planArtifacts,
      planArtifactSnapshot,
    );
    return {
      ok: false,
      reason: "Commit succeeded but HEAD did not advance",
      blocking: false,
    };
  }

  const changedPlanArtifactAfterCommit = changedSnapshotPath(
    planArtifacts,
    planArtifactSnapshot,
  );
  if (changedPlanArtifactAfterCommit) {
    await resetOverallRework(
      deps,
      preAttemptHead,
      planArtifacts,
      planArtifactSnapshot,
    );
    return {
      ok: false,
      reason: `Commit hook changed a plan artifact during overall rework: ${changedPlanArtifactAfterCommit}`,
      blocking: true,
    };
  }

  if (!(await deps.git.isCleanExcept(planArtifacts))) {
    await resetOverallRework(
      deps,
      preAttemptHead,
      planArtifacts,
      planArtifactSnapshot,
    );
    return {
      ok: false,
      reason: "Commit succeeded but checkout is dirty after overall rework",
      blocking: false,
    };
  }

  if (deps.paths) {
    appendEvent(deps.paths, {
      type: "overall_rework_committed",
      attempt: attemptNumber,
      commitSha: postCommitHead,
    });
  }

  deps.updateState((prev) =>
    checkpointPatch(
      prev,
      `Overall rework committed (attempt ${attemptNumber}) @ ${postCommitHead.slice(0, 7)}`,
    ),
  );

  return { ok: true, commitSha: postCommitHead };
}

function buildOverallReviewArtifactContent(
  deps: OrchestratorDeps,
  baseSha: string,
  headSha: string,
  lastReview: Extract<OverallReviewOutcome, { verdict: "changes_requested" }>,
  reworkFailures: string[],
): string {
  const recommendation =
    lastReview.recommendationMarkdown ??
    `## Required Changes\n\n${lastReview.requiredChanges.map((c) => `- ${c}`).join("\n")}`;

  const reworkSection =
    reworkFailures.length > 0
      ? `\n## Rework Attempts\n\n${reworkFailures.map((f, i) => `- Attempt ${i + 1}: ${f}`).join("\n")}\n`
      : "";

  const manifestSection = formatExecutionManifestSummary(
    deps.executionManifest,
  );

  const corpusSection =
    deps.materialStore || deps.corpusMaterial
      ? `\n## Plan Corpus\n\n${
          deps.materialStore
            ? formatStoreCorpusMaterial(deps.materialStore)
            : deps.corpusMaterial
        }\n`
      : "";

  return `# Overall Review: Changes Requested

## Verdict

changes_requested

## Required Changes

${lastReview.requiredChanges.map((c) => `- ${c}`).join("\n")}

## Recommendation

${recommendation}

## Context

- Plan: ${deps.planPath}
- Base SHA: ${baseSha}
- Head SHA: ${headSha}
${deps.runId ? `- Run ID: ${deps.runId}\n` : ""}${reworkSection}${manifestSection}${corpusSection}
## Raw Result

${lastReview.rawResult}
`;
}

async function runOverallReviewLoop(
  deps: OrchestratorDeps,
  plan: ReturnType<typeof parsePlanFile>,
  planArtifacts: string[],
  runBaseSha: string,
): Promise<void> {
  const reworkFailures: string[] = [];

  const initialReview = await runOverallReviewOnce(
    deps,
    plan,
    planArtifacts,
    runBaseSha,
  );

  if (initialReview.verdict === "approved") {
    deps.updateState((prev) =>
      checkpointPatch(prev, "Final overall review approved"),
    );
    if (deps.paths) {
      appendEvent(deps.paths, { type: "overall_review_approved" });
    }
    return;
  }

  let lastReview: Extract<
    OverallReviewOutcome,
    { verdict: "changes_requested" }
  > = initialReview;

  if (deps.paths) {
    appendEvent(deps.paths, {
      type: "overall_review_changes_requested",
      requiredChanges: initialReview.requiredChanges,
    });
  }

  deps.updateState((prev) =>
    checkpointPatch(
      prev,
      `Overall review changes requested: ${initialReview.requiredChanges.join("; ")}`,
    ),
  );

  for (let attempt = 1; attempt <= MAX_OVERALL_REWORK_ATTEMPTS; attempt++) {
    const rework = await runOverallReworkAttempt(
      deps,
      plan,
      planArtifacts,
      runBaseSha,
      lastReview,
      attempt,
      reworkFailures,
    );

    if (!rework.ok) {
      if (rework.blocking) {
        throw new BlockedError(rework.reason);
      }
      reworkFailures.push(rework.reason);
      continue;
    }

    // Re-run overall review only after a successful rework commit
    const review = await runOverallReviewOnce(
      deps,
      plan,
      planArtifacts,
      runBaseSha,
    );

    if (review.verdict === "approved") {
      deps.updateState((prev) =>
        checkpointPatch(prev, "Final overall review approved"),
      );
      if (deps.paths) {
        appendEvent(deps.paths, { type: "overall_review_approved" });
      }
      return;
    }

    lastReview = review;

    if (deps.paths) {
      appendEvent(deps.paths, {
        type: "overall_review_changes_requested",
        requiredChanges: review.requiredChanges,
      });
    }

    deps.updateState((prev) =>
      checkpointPatch(
        prev,
        `Overall review changes requested: ${review.requiredChanges.join("; ")}`,
      ),
    );
  }

  const headSha = await deps.git.head();
  const artifactPath = nextOverallReviewArtifactPath(deps.planPath);
  const artifactContent = buildOverallReviewArtifactContent(
    deps,
    runBaseSha,
    headSha,
    lastReview,
    reworkFailures,
  );
  mkdirSync(dirname(artifactPath), { recursive: true });
  writeFileSync(artifactPath, artifactContent, "utf-8");

  const latestFailure = reworkFailures.at(-1);
  const message = latestFailure
    ? `Overall review requested changes: ${lastReview.requiredChanges.join("; ")}. Latest rework failure: ${latestFailure}`
    : `Overall review requested changes: ${lastReview.requiredChanges.join("; ")}`;
  throw new OverallReviewFollowupError(artifactPath, message);
}

function safeArtifactName(value: string): string {
  return (
    value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-|-$/g, "") ||
    "validation"
  );
}

export function stalledSchedulerReason(
  sched: SchedulerRun,
  schedulerSelfHealAttempted = false,
  remainingBlocker?: string,
): string {
  const lines: string[] = [];
  lines.push("Parallel scheduler blocked:");

  const allTasks = [...sched.tasks.values()].sort(
    (a, b) => a.planIndex - b.planIndex,
  );

  for (const task of allTasks) {
    if (task.status === "landed" || task.status === "satisfied") {
      continue;
    }

    if (
      task.status === "failed" ||
      task.status === "blocked" ||
      task.status === "stopped" ||
      task.status === "integration_failed"
    ) {
      const reason = task.lastReason ? `: ${task.lastReason}` : "";
      lines.push(`- ${task.id}: ${task.status}${reason}`);
      continue;
    }

    if (task.status === "approved") {
      const unlandedDeps = task.dependsOn
        .map((depId) => sched.tasks.get(depId))
        .filter(
          (dep) => dep && dep.status !== "landed" && dep.status !== "satisfied",
        )
        .map((dep) => `${dep!.id}:${dep!.status}`);
      if (unlandedDeps.length > 0) {
        lines.push(
          `- ${task.id}: approved but cannot land until dependencies land: ${unlandedDeps.join(", ")}`,
        );
      } else {
        lines.push(`- ${task.id}: approved`);
      }
      continue;
    }

    const blockedReason = getBlockedReason(task, sched);
    if (blockedReason) {
      lines.push(`- ${task.id}: ${task.status}, ${blockedReason}`);
    } else {
      lines.push(`- ${task.id}: ${task.status}`);
    }
  }

  if (schedulerSelfHealAttempted) {
    const healLine = remainingBlocker
      ? `Self-heal attempted but did not produce retryable progress; remaining blocker: ${remainingBlocker}`
      : "Self-heal attempted but did not produce retryable progress";
    lines.push(healLine);
  }

  return lines.join("\n");
}

function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function normalizePlanCheckboxes(text: string): string {
  return text.replace(/^(\s*[-*+]\s+\[)[ xX](\]\s+)/gm, "$1 $2");
}

function readRecordedCorpusFileRecords(paths: StatePaths): {
  entryPath?: string;
  files: Array<{ path: string; hash: string }>;
} {
  const run = readRunJson(paths);
  let entryPath = run?.planPath;
  let files = run?.corpusFiles ?? [];

  if (existsSync(paths.corpusJson)) {
    try {
      const parsed = JSON.parse(readFileSync(paths.corpusJson, "utf-8")) as {
        entryPath?: unknown;
        files?: unknown;
      };
      if (typeof parsed.entryPath === "string" && parsed.entryPath) {
        entryPath = parsed.entryPath;
      }
      if (Array.isArray(parsed.files)) {
        files = parsed.files.filter(
          (file): file is { path: string; hash: string } =>
            typeof file === "object" &&
            file !== null &&
            typeof (file as { path?: unknown }).path === "string" &&
            typeof (file as { hash?: unknown }).hash === "string",
        );
      }
    } catch {
      throw new BlockedError("recorded plan corpus metadata is unreadable");
    }
  }

  return { entryPath, files };
}

function validateRecordedPlanCorpus(deps: OrchestratorDeps): void {
  if (!deps.paths || !deps.executionManifest) {
    return;
  }

  const { entryPath, files } = readRecordedCorpusFileRecords(deps.paths);
  if (files.length === 0) {
    return;
  }

  for (const file of files) {
    if (!existsSync(file.path)) {
      throw new BlockedError(
        `plan corpus changed since execution manifest was built: missing ${file.path}; re-run pi-implement to re-ingest and replan before executing further tasks.`,
      );
    }

    const content = readFileSync(file.path, "utf-8");
    if (
      entryPath &&
      file.path === entryPath &&
      existsSync(deps.paths.planSnapshot)
    ) {
      const snapshot = readFileSync(deps.paths.planSnapshot, "utf-8");
      if (
        hashText(normalizePlanCheckboxes(content)) !==
        hashText(normalizePlanCheckboxes(snapshot))
      ) {
        throw new BlockedError(
          `plan corpus changed since execution manifest was built: ${file.path}; re-run pi-implement to re-ingest and replan before executing further tasks.`,
        );
      }
      continue;
    }

    if (hashText(content) !== file.hash) {
      throw new BlockedError(
        `plan corpus changed since execution manifest was built: ${file.path}; re-run pi-implement to re-ingest and replan before executing further tasks.`,
      );
    }
  }
}

function readTaskJsonByPlanIndex(
  paths: StatePaths,
  planIndex: number,
): TaskJson | undefined {
  if (!existsSync(paths.tasksDir)) {
    return undefined;
  }
  for (const dirent of readdirSync(paths.tasksDir, { withFileTypes: true })) {
    if (!dirent.isDirectory()) {
      continue;
    }
    const taskJson = readTaskJson(paths, dirent.name);
    if (
      taskJson &&
      (taskJson.planIndex === planIndex || taskJson.planIndex === planIndex - 1)
    ) {
      return taskJson;
    }
  }
  return undefined;
}

function nextUncheckedManifestTask(
  plan: ReturnType<typeof parsePlanFile>,
  manifest: ExecutionManifest,
  paths?: StatePaths,
):
  | {
      planTask: PlanTask;
      manifestTask: import("./execution-plan.js").ExecutionTask;
    }
  | undefined {
  for (const manifestTask of manifest.tasks) {
    const planTask = plan.tasks.find((t) => t.index === manifestTask.planIndex);
    if (!planTask) {
      continue;
    }
    if (!planTask.checked) {
      // If run state says the task is already landed/satisfied, trust
      // canonical run state over the source checkbox.
      if (paths) {
        const taskJson = readTaskJsonByPlanIndex(paths, manifestTask.planIndex);
        if (taskJson?.status === "landed" || taskJson?.status === "satisfied") {
          continue;
        }
      }
      return { planTask, manifestTask };
    }
  }
  return undefined;
}

function completedPlanTaskIndex(
  plan: ReturnType<typeof parsePlanFile>,
): number | undefined {
  return plan.tasks.length > 0 ? plan.tasks.length : undefined;
}

function updateParallelState(
  deps: OrchestratorDeps,
  sched: SchedulerRun,
): void {
  const tasks: ParallelTaskState[] = [];
  const activeAgentIds: string[] = [];
  let landedCount = 0;
  let satisfiedCount = 0;

  for (const task of sched.tasks.values()) {
    if (task.status === "landed") {
      landedCount++;
    }
    if (task.status === "satisfied") {
      satisfiedCount++;
    }
    const taskMeta = deps.paths ? readTaskJson(deps.paths, task.id) : undefined;
    tasks.push({
      id: task.id,
      planIndex: task.planIndex - 1,
      title: task.title,
      status: task.status as ParallelTaskState["status"],
      blockedReason: getBlockedReason(task, sched),
      worktreePath: task.worktreePath,
      landedCommitSha: task.landedCommitSha,
      activeAgentIds: task.activeAgentIds,
      activeAgentRefs: task.activeAgentRefs,
      review: taskMeta?.review,
    });
    for (const id of task.activeAgentIds) {
      activeAgentIds.push(id);
    }
  }

  const activeAgentRefs = [...sched.tasks.values()].flatMap((task) =>
    task.activeAgentRefs.filter((ref) => activeAgentIds.includes(ref.id)),
  );

  deps.updateState({
    tasks,
    activeSubagentId: activeAgentIds.at(-1),
    activeSubagentIds: activeAgentIds,
    activeAgentRefs,
    landedCount,
    satisfiedCount,
    totalCount: sched.tasks.size,
  });
}

function setSchedulerActiveAgent(
  task: SchedulerTask | undefined,
  ref: AgentDisplayRef,
): void {
  if (!task) {
    return;
  }
  task.activeAgentIds = [
    ...task.activeAgentIds.filter((id) => id !== ref.id),
    ref.id,
  ];
  task.activeAgentRefs = [
    ...task.activeAgentRefs.filter((existing) => existing.id !== ref.id),
    ref,
  ];
}

function clearSchedulerActiveAgent(
  task: SchedulerTask | undefined,
  id: string,
): void {
  if (!task) {
    return;
  }
  task.activeAgentIds = task.activeAgentIds.filter(
    (existing) => existing !== id,
  );
  task.activeAgentRefs = task.activeAgentRefs.filter((ref) => ref.id !== id);
}

function addActiveAgentPatch(
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

function removeActiveAgentPatch(prev: RunState, id: string): Partial<RunState> {
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

function taskToJson(task: SchedulerTask): TaskJson {
  return {
    id: task.id,
    planIndex: task.planIndex,
    title: task.title,
    status: task.status as TaskJson["status"],
    dependsOn: task.dependsOn,
    attempts: 0,
    integrationAttempts: task.integrationAttempts,
    baseSha: undefined,
    worktreePath: task.worktreePath,
    branchName: task.branchName,
    taskCommitSha: task.taskCommitSha,
    landedCommitSha: task.landedCommitSha,
    activeSubagentIds: task.activeAgentIds,
    lastReason: task.lastReason,
    commitMessage: task.approvedCommitMessage,
    selfHealAttempts: task.selfHealAttempts,
  };
}

function currentTaskReviewMetadata(
  paths: StatePaths | undefined,
  taskId: string,
): TaskJson["review"] {
  return paths ? readTaskJson(paths, taskId)?.review : undefined;
}

function nextTaskReviewMetadata(
  paths: StatePaths | undefined,
  taskId: string,
): TaskJson["review"] {
  const existingReview = currentTaskReviewMetadata(paths, taskId);
  return {
    lastDecision: "reviewed",
    reviewedCount: (existingReview?.reviewedCount ?? 0) + 1,
  };
}

function buildTaskJsonSnapshot(
  existing: TaskJson | undefined,
  task: SchedulerTask,
): TaskJson {
  return {
    ...taskToJson(task),
    review: existing?.review,
  };
}

// ── Task worker (shared serial + parallel) ─────────────────────────────────

async function runTaskWorker(args: {
  deps: OrchestratorDeps;
  plan: ReturnType<typeof parsePlanFile>;
  task: ReturnType<typeof parsePlanFile>["tasks"][number];
  taskId: string;
  taskGit: GitClient;
  worktreePath: string | undefined;
  branchName: string;
  baseSha: string;
  planArtifacts: string[];
  schedulerTask?: SchedulerTask;
  runBaseSha?: string;
  wasNeedsRework?: boolean;
  initialFeedback?: RetryFeedback;
  attemptOrdinalBase?: number;
}): Promise<TaskWorkerResult> {
  const {
    deps,
    plan,
    task,
    taskId,
    taskGit,
    worktreePath,
    branchName,
    baseSha,
    planArtifacts,
    schedulerTask,
    runBaseSha,
    initialFeedback,
  } = args;

  let feedback: RetryFeedback | undefined = initialFeedback;
  let priorSummary: string | undefined;
  let attempt = 1;
  let systemFailures = 0;
  let anchoredReviewChangeRequests = 0;
  let priorReviewRequiredChanges: string[] | undefined;
  for (;;) {
    throwIfStopped(deps);
    const taskHeadBefore = worktreePath
      ? await taskGit.head()
      : await deps.git.head();
    const planArtifactSnapshot = snapshotPlanArtifacts(planArtifacts);
    const compiledContractEntry = deps.executionManifest?.tasks.find(
      (mt) => mt.planIndex === task.index,
    );
    if (!compiledContractEntry) {
      throw new BlockedError(
        `Task ${task.index} missing from execution manifest`,
      );
    }
    const compiledContract = renderCompiledContract(
      compiledContractEntry.compiledContract,
    );
    const effectiveWorktreePath = worktreePath ?? (await deps.git.root());
    const recordedCorpusFiles = deps.paths
      ? readRecordedCorpusFileRecords(deps.paths).files
      : [];

    if (!deps.materialInventory) {
      throw new BlockedError("no Phase 1 material inventory available");
    }
    const sourceMaterialPacket = await buildTaskSourceMaterialPacket({
      task,
      taskId,
      planPath: deps.planPath,
      manifest: deps.manifest,
      repoRoot: await deps.git.root(),
      corpusFiles: recordedCorpusFiles,
      materialInventory: deps.materialInventory,
      materialStore: deps.materialStore,
      compiledContract: compiledContractEntry.compiledContract,
      plannerRefs: compiledContractEntry.sourceMaterialRefs,
      subagents: deps.subagents,
      roles: deps.roles,
      updateState: deps.updateState,
      signal: deps.signal,
    });
    const implementerPrompt = buildImplementerPrompt({
      compiledContract,
      worktreePath: effectiveWorktreePath,
      sourceMaterial: sourceMaterialPacket?.section,
      feedback: feedback ? formatFeedback(feedback) : undefined,
      priorSummary,
    });
    deps.updateState({
      phase: "coding",
      taskIndex: task.index,
      totalTasks: plan.tasks.length,
      attempt,
      activeSubagentId: undefined,
      lastReason: feedback ? formatFeedback(feedback) : undefined,
    });

    if (deps.paths) {
      persistTaskArtifact(deps.paths, taskId, "prompt.md", implementerPrompt);
      if (sourceMaterialPacket) {
        persistTaskArtifact(
          deps.paths,
          taskId,
          "source-material.md",
          `## Referenced Source Material\n\n${sourceMaterialPacket.section}\n`,
        );
        persistTaskArtifact(
          deps.paths,
          taskId,
          "task-packet.json",
          `${JSON.stringify(
            {
              resolvedMaterialRefs: sourceMaterialPacket.resolvedRefs,
              ...(sourceMaterialPacket.repair
                ? { sourceMaterialRepair: sourceMaterialPacket.repair }
                : {}),
            },
            null,
            2,
          )}\n`,
        );
      }
    }

    const implementerId = await deps.subagents.spawn({
      type: deps.roles.implementer.type,
      prompt: implementerPrompt,
      description: `implement task ${task.index}/${plan.tasks.length}: ${shortTask(task.text)}`,
      model: deps.roles.implementer.model,
      thinking: deps.roles.implementer.thinking,
      role: "implementer",
      taskId,
      cwd: effectiveWorktreePath,
    });
    const implementerRef: AgentDisplayRef = {
      id: implementerId,
      role: "implementer",
      label: `Task ${task.index}/${plan.tasks.length} implementer \u00b7 ${shortTask(task.text)}`,
      startedAt: new Date().toISOString(),
      taskId,
      taskIndex: task.index,
      taskTotal: plan.tasks.length,
      taskTitle: shortTask(task.text),
    };
    setSchedulerActiveAgent(schedulerTask, implementerRef);
    deps.updateState((prev) => addActiveAgentPatch(prev, implementerRef));
    if (deps.paths) {
      writeTaskJson(deps.paths, taskId, {
        id: taskId,
        planIndex: task.index - 1,
        title: task.text,
        status: "coding",
        dependsOn: [],
        attempts: attempt,
        integrationAttempts: 0,
        baseSha,
        worktreePath,
        branchName,
        activeSubagentIds: [implementerId],
        review: currentTaskReviewMetadata(deps.paths, taskId),
      });
      appendEvent(deps.paths, { type: "task_started", taskId });
    }
    const implementation = await deps.subagents.waitFor(
      implementerId,
      deps.signal,
    );
    clearSchedulerActiveAgent(schedulerTask, implementerId);
    deps.updateState((prev) => removeActiveAgentPatch(prev, implementerId));

    if (implementation.status === "stopped") {
      throw new StoppedError();
    }
    throwIfStopped(deps);

    if (implementation.status === "failed") {
      if (deps.paths) {
        writeTaskJson(deps.paths, taskId, {
          id: taskId,
          planIndex: task.index - 1,
          title: task.text,
          status: "failed",
          dependsOn: [],
          attempts: attempt,
          integrationAttempts: 0,
          baseSha,
          worktreePath,
          branchName,
          activeSubagentIds: [],
          lastReason: implementation.error,
          review: currentTaskReviewMetadata(deps.paths, taskId),
        });
      }
      feedback = recordSystemFailure(
        task.index,
        systemFailures,
        "system",
        `Implementer subagent failed: ${implementation.error}`,
      );
      systemFailures++;
      priorReviewRequiredChanges = undefined;
      anchoredReviewChangeRequests = 0;
      attempt++;
      continue;
    }

    if (deps.paths) {
      persistTaskArtifact(
        deps.paths,
        taskId,
        "result.md",
        implementation.result,
      );
      writeTaskJson(deps.paths, taskId, {
        id: taskId,
        planIndex: task.index - 1,
        title: task.text,
        status: "reviewing",
        dependsOn: [],
        attempts: attempt,
        integrationAttempts: 0,
        baseSha,
        worktreePath,
        branchName,
        activeSubagentIds: [],
        review: currentTaskReviewMetadata(deps.paths, taskId),
      });
    }

    // Boundary checks
    if (!worktreePath && (await deps.git.head()) !== taskHeadBefore) {
      throw new BlockedError("implementer changed HEAD");
    }
    const changedPlanArtifact = changedSnapshotPath(
      planArtifacts,
      planArtifactSnapshot,
    );
    if (changedPlanArtifact) {
      throw new BlockedError(
        `implementer changed a plan artifact: ${changedPlanArtifact}`,
      );
    }
    if (worktreePath && (await taskGit.head()) !== taskHeadBefore) {
      throw new BlockedError("implementer changed task worktree HEAD");
    }

    let parsed = parseImplementerResult(implementation.result);
    deps.updateState((prev) =>
      checkpointPatch(
        prev,
        `\u00b7 Task ${task.index}/${plan.tasks.length} implementation finished: ${parsed.ok ? parsed.result.summary : parsed.reason}`,
      ),
    );
    if (parsed.ok) {
      const verificationSummary = parsed.result.verification
        .map((v) => `${v.command}: ${v.result}`)
        .join("; ");
      deps.updateState((prev) =>
        checkpointPatch(
          prev,
          `\u00b7 Task ${task.index}/${plan.tasks.length} verification: ${verificationSummary}`,
        ),
      );
    }
    if (!parsed.ok) {
      feedback = recordSystemFailure(
        task.index,
        systemFailures,
        "system",
        parsed.reason,
      );
      systemFailures++;
      priorReviewRequiredChanges = undefined;
      anchoredReviewChangeRequests = 0;
      attempt++;
      continue;
    }
    priorSummary = parsed.result.summary;

    await taskGit.stageAllExcept(planArtifacts);
    const hasStaged = await taskGit.hasStagedChanges();

    // The implementer claimed the task was already satisfied but left staged
    // changes. The diff is the ground truth, so treat this as a `changed`
    // candidate and let the reviewer judge whether to commit it or send it
    // back for rework rather than silently dropping or blindly landing it.
    let alreadySatisfiedDiscrepancy = false;
    if (hasStaged && parsed.result.outcome === "already_satisfied") {
      alreadySatisfiedDiscrepancy = true;
      parsed = {
        ok: true,
        result: {
          outcome: "changed",
          summary: parsed.result.summary,
          verification: parsed.result.verification,
          commitMessage: isValidCommitMessage(parsed.result.commitMessage ?? "")
            ? parsed.result.commitMessage!.trim()
            : fallbackCommitMessage(task.text),
        },
      };
    }

    let fingerprintBefore: string | undefined;
    let candidatePatch: string | undefined;
    let worktreeFingerprintBefore: string | undefined;
    let reviewHeadBefore: string;
    let reviewerPrompt: string | undefined;

    if (hasStaged) {
      fingerprintBefore = await taskGit.stagedFingerprint();
      candidatePatch = await taskGit.stagedDiff();
      worktreeFingerprintBefore =
        await taskGit.worktreeFingerprintExcept(planArtifacts);

      if (deps.paths) {
        persistTaskArtifact(deps.paths, taskId, "diff.patch", candidatePatch);
      }

      reviewHeadBefore = await taskGit.head();

      const outOfScopeTasks = deps.executionManifest
        ? deps.executionManifest.tasks
            .filter((mt) => mt.planIndex !== task.index)
            .map((mt) => `- ${mt.title}`)
        : plan.tasks
            .filter((t) => t.index !== task.index)
            .map((t) => t.originalLine);
      reviewerPrompt = buildReviewerPrompt({
        compiledContract,
        worktreePath: effectiveWorktreePath,
        implementer: parsed.result,
        outOfScopeTasks,
        priorRequiredChanges: priorReviewRequiredChanges,
        baseSha: worktreePath ? baseSha : undefined,
        alreadySatisfiedDiscrepancy,
        sourceMaterial: sourceMaterialPacket?.section,
      });

      if (worktreePath) {
        const wipCommit = await taskGit.commit("pi-implement: candidate");
        if (wipCommit.exitCode !== 0) {
          await taskGit.resetHard(baseSha);
          feedback = recordSystemFailure(
            task.index,
            systemFailures,
            "commit-hook",
            `Commit failed. Fix the issue and try again.\n\n${wipCommit.stderr || wipCommit.stdout}`,
          );
          systemFailures++;
          priorReviewRequiredChanges = undefined;
          anchoredReviewChangeRequests = 0;
          attempt++;
          continue;
        }
        reviewHeadBefore = await taskGit.head();
        worktreeFingerprintBefore =
          await taskGit.worktreeFingerprintExcept(planArtifacts);
      }
    } else if (parsed.result.outcome === "already_satisfied") {
      await taskGit.reset();
      reviewHeadBefore = await taskGit.head();

      let accumulatedDiff: string | undefined;
      if (runBaseSha) {
        try {
          const diff = await taskGit.diffRange(
            runBaseSha,
            await taskGit.head(),
          );
          accumulatedDiff =
            diff.length <= MAX_ACCUMULATED_DIFF_CHARS ? diff : undefined;
        } catch {
          accumulatedDiff = undefined;
        }
      }

      const outOfScopeTasks = deps.executionManifest
        ? deps.executionManifest.tasks
            .filter((mt) => mt.planIndex !== task.index)
            .map((mt) => `- ${mt.title}`)
        : plan.tasks
            .filter((t) => t.index !== task.index)
            .map((t) => t.originalLine);
      reviewerPrompt = buildAlreadySatisfiedReviewerPrompt({
        compiledContract,
        worktreePath: effectiveWorktreePath,
        implementer: parsed.result,
        headSha: reviewHeadBefore,
        accumulatedDiff,
        outOfScopeTasks,
        priorRequiredChanges: priorReviewRequiredChanges,
        sourceMaterial: sourceMaterialPacket?.section,
      });
    } else {
      const message =
        'No committable changes were produced after excluding plan artifacts and ignored files. Likely causes: the implementer produced no candidate code changes, only plan or ignored-file changes were made, or the task may already be satisfied and should be reported with outcome: "already_satisfied".';
      feedback = recordSystemFailure(
        task.index,
        systemFailures,
        "system",
        message,
      );
      systemFailures++;
      await taskGit.reset();
      priorReviewRequiredChanges = undefined;
      anchoredReviewChangeRequests = 0;
      attempt++;
      continue;
    }
    if (schedulerTask) {
      schedulerTask.status = "reviewing";
    }
    deps.updateState({ phase: "reviewing", activeSubagentId: undefined });

    if (deps.paths) {
      persistTaskArtifact(deps.paths, taskId, "review.md", reviewerPrompt!);
    }

    {
      const reviewerId = await deps.subagents.spawn({
        type: deps.roles.reviewer.type,
        prompt: reviewerPrompt!,
        description: `review task ${task.index}/${plan.tasks.length}: ${shortTask(task.text)}`,
        model: deps.roles.reviewer.model,
        thinking: deps.roles.reviewer.thinking,
        role: "reviewer",
        taskId,
        cwd: effectiveWorktreePath,
        readOnly: true,
      });
      const reviewerRef: AgentDisplayRef = {
        id: reviewerId,
        role: "reviewer",
        label: `Task ${task.index}/${plan.tasks.length} reviewer \u00b7 ${shortTask(task.text)}`,
        startedAt: new Date().toISOString(),
        taskId,
        taskIndex: task.index,
        taskTotal: plan.tasks.length,
        taskTitle: shortTask(task.text),
      };
      setSchedulerActiveAgent(schedulerTask, reviewerRef);
      deps.updateState((prev) => addActiveAgentPatch(prev, reviewerRef));
      if (deps.paths) {
        writeTaskJson(deps.paths, taskId, {
          id: taskId,
          planIndex: task.index - 1,
          title: task.text,
          status: "reviewing",
          dependsOn: [],
          attempts: attempt,
          integrationAttempts: 0,
          baseSha,
          worktreePath,
          branchName,
          activeSubagentIds: [reviewerId],
          review: currentTaskReviewMetadata(deps.paths, taskId),
        });
      }
      const review = await deps.subagents.waitFor(reviewerId, deps.signal);
      clearSchedulerActiveAgent(schedulerTask, reviewerId);
      deps.updateState((prev) => removeActiveAgentPatch(prev, reviewerId));
      if (deps.paths) {
        writeTaskJson(deps.paths, taskId, {
          id: taskId,
          planIndex: task.index - 1,
          title: task.text,
          status: review.status === "completed" ? "reviewing" : "failed",
          dependsOn: [],
          attempts: attempt,
          integrationAttempts: 0,
          baseSha,
          worktreePath,
          branchName,
          activeSubagentIds: [],
          lastReason: review.status !== "completed" ? review.error : undefined,
          review: currentTaskReviewMetadata(deps.paths, taskId),
        });
      }
      if (review.status === "stopped") {
        await resetTaskForRetry(
          taskGit,
          worktreePath,
          reviewHeadBefore,
          planArtifacts,
        );
        throw new StoppedError();
      }
      await throwIfStoppedAndReset(deps, taskGit);
      if (review.status === "failed") {
        await resetTaskForRetry(
          taskGit,
          worktreePath,
          systemFailures + 1 >= MAX_SYSTEM_FAILURES
            ? reviewHeadBefore
            : baseSha,
          planArtifacts,
        );
        feedback = recordSystemFailure(
          task.index,
          systemFailures,
          "system",
          `Reviewer subagent failed: ${review.error}`,
        );
        systemFailures++;
        priorReviewRequiredChanges = undefined;
        anchoredReviewChangeRequests = 0;
        attempt++;
        continue;
      }

      // Boundary checks
      if (!worktreePath && (await deps.git.head()) !== taskHeadBefore) {
        throw new BlockedError("reviewer changed HEAD");
      }
      const changedPlanArtifactAfterReview = changedSnapshotPath(
        planArtifacts,
        planArtifactSnapshot,
      );
      if (changedPlanArtifactAfterReview) {
        throw new BlockedError(
          `reviewer changed a plan artifact: ${changedPlanArtifactAfterReview}`,
        );
      }
      if ((await taskGit.head()) !== reviewHeadBefore) {
        throw new BlockedError("reviewer changed HEAD");
      }

      if (
        !hasStaged &&
        !worktreePath &&
        !(await deps.git.isCleanExcept(planArtifacts))
      ) {
        throw new BlockedError("reviewer dirtied the serial checkout");
      }

      if (hasStaged) {
        await healReviewerMutations({
          taskGit,
          planArtifacts,
          stagedFingerprintBefore: fingerprintBefore!,
          candidatePatch: candidatePatch!,
          worktreeFingerprintBefore: worktreeFingerprintBefore!,
          committedSha: worktreePath ? reviewHeadBefore : undefined,
        });
      }
      const verdict = parseReviewerVerdict(review.result);
      if (verdict.verdict === "error") {
        await resetTaskForRetry(
          taskGit,
          worktreePath,
          systemFailures + 1 >= MAX_SYSTEM_FAILURES
            ? reviewHeadBefore
            : baseSha,
          planArtifacts,
        );
        feedback = recordSystemFailure(
          task.index,
          systemFailures,
          "system",
          `Reviewer produced invalid verdict: ${verdict.reason}`,
        );
        systemFailures++;
        priorReviewRequiredChanges = undefined;
        anchoredReviewChangeRequests = 0;
        attempt++;
        continue;
      }
      const isAnchoredReview = (priorReviewRequiredChanges?.length ?? 0) > 0;
      let unresolved: string[] = [];
      if (verdict.verdict === "changes_requested") {
        if (isAnchoredReview) {
          unresolved = verdict.requiredChanges.filter((change: string) =>
            priorReviewRequiredChanges!.includes(change),
          );
        } else {
          unresolved = verdict.requiredChanges;
        }
      }
      deps.updateState((prev) =>
        checkpointPatch(
          prev,
          verdict.verdict === "approved" || unresolved.length === 0
            ? `\u2713 Task ${task.index}/${plan.tasks.length} review approved`
            : `\u00b7 Task ${task.index}/${plan.tasks.length} review changes requested: ${formatRequiredChanges(unresolved)}`,
        ),
      );
      if (verdict.verdict === "changes_requested") {
        if (!isAnchoredReview) {
          await resetTaskForRetry(
            taskGit,
            worktreePath,
            baseSha,
            planArtifacts,
          );
          priorReviewRequiredChanges = verdict.requiredChanges;
          feedback = reviewerFeedback(verdict.requiredChanges);
          attempt++;
          continue;
        }
        if (unresolved.length === 0) {
          // Anchored review returned only non-matching items — treat as approved.
          // Do NOT reset so the approved candidate diff remains staged.
          priorReviewRequiredChanges = undefined;
          anchoredReviewChangeRequests = 0;
          // Fall through to approval path below
        } else {
          anchoredReviewChangeRequests++;
          if (
            anchoredReviewChangeRequests >= MAX_ANCHORED_REVIEW_CHANGE_REQUESTS
          ) {
            await taskGit.reset();
            const message = unresolved
              .map((change) => `- ${change}`)
              .join("\n");
            throw new BlockedError(
              `anchored review change request limit reached for task ${task.index}:\n${message}`,
            );
          }
          await resetTaskForRetry(
            taskGit,
            worktreePath,
            baseSha,
            planArtifacts,
          );
          priorReviewRequiredChanges = unresolved;
          feedback = reviewerFeedback(unresolved);
          attempt++;
          continue;
        }
      }
    }

    // Clear anchor on any approval path
    priorReviewRequiredChanges = undefined;
    anchoredReviewChangeRequests = 0;

    const taskReviewMeta = nextTaskReviewMetadata(deps.paths, taskId);

    // Approved
    if (
      !hasStaged &&
      parsed.result.outcome === "already_satisfied" &&
      !worktreePath
    ) {
      throwIfStopped(deps);
      if (!(await deps.git.isCleanExcept(planArtifacts))) {
        throw new BlockedError(
          "satisfied approval succeeded but worktree is dirty",
        );
      }
      markSourceCheckboxDone(deps, taskId, task);
      if (!(await deps.git.isCleanExcept(planArtifacts))) {
        markSourceCheckboxUndone(deps, taskId, task);
        throw new BlockedError(
          "satisfied task marked done but worktree became dirty",
        );
      }
      try {
        throwIfStopped(deps);
      } catch (err) {
        if (err instanceof StoppedError) {
          markSourceCheckboxUndone(deps, taskId, task);
          await taskGit.reset();
        }
        throw err;
      }
      if (deps.paths) {
        appendEvent(deps.paths, { type: "task_satisfied", taskId });
        writeTaskJson(deps.paths, taskId, {
          id: taskId,
          planIndex: task.index - 1,
          title: task.text,
          status: "satisfied",
          dependsOn: [],
          attempts: attempt,
          integrationAttempts: 0,
          baseSha,
          worktreePath,
          branchName,
          activeSubagentIds: [],
          review: taskReviewMeta,
        });
      }
      const satisfiedHead = await deps.git.head();
      deps.updateState((prev) => ({
        currentMainHead: satisfiedHead,
        ...checkpointPatch(
          prev,
          `\u2713 Task ${task.index}/${plan.tasks.length} satisfied`,
        ),
      }));
      return "satisfied";
    }

    if (
      !hasStaged &&
      parsed.result.outcome === "already_satisfied" &&
      worktreePath
    ) {
      throwIfStopped(deps);
      if (!(await taskGit.isCleanExcept(planArtifacts))) {
        throw new BlockedError(
          "satisfied approval succeeded but task worktree is dirty",
        );
      }
      try {
        throwIfStopped(deps);
      } catch (err) {
        if (err instanceof StoppedError) {
          await taskGit.reset();
        }
        throw err;
      }
      if (deps.paths) {
        writeTaskJson(deps.paths, taskId, {
          id: taskId,
          planIndex: task.index - 1,
          title: task.text,
          status: "satisfied",
          dependsOn: [],
          attempts: attempt,
          integrationAttempts: 0,
          baseSha,
          worktreePath,
          branchName,
          activeSubagentIds: [],
          review: taskReviewMeta,
        });
      }
      deps.updateState((prev) =>
        checkpointPatch(
          prev,
          `✓ Task ${task.index}/${plan.tasks.length} satisfied`,
        ),
      );
      return "satisfied";
    }

    // Approved (changed/legacy)
    if (deps.paths) {
      writeTaskJson(deps.paths, taskId, {
        id: taskId,
        planIndex: task.index - 1,
        title: task.text,
        status: "approved",
        dependsOn: [],
        attempts: attempt,
        integrationAttempts: 0,
        baseSha,
        worktreePath,
        branchName,
        activeSubagentIds: [],
        review: taskReviewMeta,
      });
    }

    const commitMessage =
      parsed.result.outcome === "changed" ? parsed.result.commitMessage : "";
    const approvedMessage = isValidCommitMessage(commitMessage)
      ? commitMessage.trim()
      : fallbackCommitMessage(task.text);
    deps.updateState((prev) => ({
      phase: "committing" as const,
      lastReason: undefined,
      ...checkpointPatch(
        prev,
        `\u00b7 Task ${task.index}/${plan.tasks.length} committing: ${approvedMessage}`,
      ),
    }));
    await throwIfStoppedAndReset(deps, taskGit);

    if (worktreePath) {
      const taskCommit = await taskGit.reword(approvedMessage);
      if (taskCommit.exitCode !== 0) {
        const headAfterFailedCommit = await taskGit.head();
        if (headAfterFailedCommit !== reviewHeadBefore) {
          throw new BlockedError(
            "task reword failed but HEAD changed; inspect manually",
          );
        }
        await taskGit.resetHard(baseSha);
        feedback = recordSystemFailure(
          task.index,
          systemFailures,
          "commit-hook",
          `Commit failed. Fix the issue and try again.\n\n${taskCommit.stderr || taskCommit.stdout}`,
        );
        systemFailures++;
        priorReviewRequiredChanges = undefined;
        anchoredReviewChangeRequests = 0;
        attempt++;
        if (deps.paths) {
          writeTaskJson(deps.paths, taskId, {
            id: taskId,
            planIndex: task.index - 1,
            title: task.text,
            status: "integration_failed",
            dependsOn: [],
            attempts: attempt,
            integrationAttempts: systemFailures,
            baseSha,
            worktreePath,
            branchName,
            activeSubagentIds: [],
            lastReason: feedback.message,
            review: currentTaskReviewMetadata(deps.paths, taskId),
          });
          appendEvent(deps.paths, {
            type: "integration_failed",
            taskId,
            reason: feedback.message,
          });
        }
        continue;
      }

      const taskCommitSha = await taskGit.head();
      if (taskCommitSha === reviewHeadBefore) {
        throw new BlockedError("task reword succeeded but HEAD did not change");
      }
      if (!(await taskGit.isCleanExcept(planArtifacts))) {
        throw new BlockedError(
          "task commit succeeded but task worktree is dirty",
        );
      }

      if (deps.paths) {
        writeTaskJson(deps.paths, taskId, {
          id: taskId,
          planIndex: task.index - 1,
          title: task.text,
          status: "approved",
          dependsOn: [],
          attempts: attempt,
          integrationAttempts: 0,
          baseSha,
          worktreePath,
          branchName,
          taskCommitSha,
          activeSubagentIds: [],
          commitMessage: approvedMessage,
          review: taskReviewMeta,
        });
        appendEvent(deps.paths, {
          type: "task_approved",
          taskId,
          commitSha: taskCommitSha,
        });
      }
      return "changed";
    }

    // Non-worktree serial mode
    markSourceCheckboxDone(deps, taskId, task);
    try {
      throwIfStopped(deps);
    } catch (err) {
      if (err instanceof StoppedError) {
        markSourceCheckboxUndone(deps, taskId, task);
        await taskGit.reset();
      }
      throw err;
    }
    const commit = await taskGit.commit(approvedMessage);
    if (commit.exitCode === 0) {
      if (!(await deps.git.isCleanExcept(planArtifacts))) {
        throw new BlockedError("commit succeeded but worktree is dirty");
      }
      const head = await deps.git.head();
      if (deps.paths) {
        appendEvent(deps.paths, {
          type: "task_approved",
          taskId,
          commitSha: head,
        });
        appendEvent(deps.paths, {
          type: "task_landed",
          taskId,
          commitSha: head,
        });
        writeTaskJson(deps.paths, taskId, {
          id: taskId,
          planIndex: task.index - 1,
          title: task.text,
          status: "landed",
          dependsOn: [],
          attempts: attempt,
          integrationAttempts: 0,
          landedCommitSha: head,
          activeSubagentIds: [],
          review: taskReviewMeta,
        });
      }
      deps.updateState((prev) => ({
        currentMainHead: head,
        ...checkpointPatch(
          prev,
          `\u2713 Task ${task.index}/${plan.tasks.length} landed @ ${head.slice(0, 7)}`,
        ),
      }));
      return "changed";
    }
    const headAfterFailedCommit = await deps.git.head();
    if (headAfterFailedCommit !== reviewHeadBefore) {
      throw new BlockedError(
        "commit failed but HEAD changed; inspect manually",
      );
    }
    markSourceCheckboxUndone(deps, taskId, task);
    await taskGit.reset();
    feedback = recordSystemFailure(
      task.index,
      systemFailures,
      "commit-hook",
      `Commit failed. Fix the issue and try again.\n\n${commit.stderr || commit.stdout}`,
    );
    systemFailures++;
    priorReviewRequiredChanges = undefined;
    anchoredReviewChangeRequests = 0;
    attempt++;
    if (deps.paths) {
      writeTaskJson(deps.paths, taskId, {
        id: taskId,
        planIndex: task.index - 1,
        title: task.text,
        status: "integration_failed",
        dependsOn: [],
        attempts: attempt,
        integrationAttempts: systemFailures,
        activeSubagentIds: [],
        lastReason: feedback.message,
        review: currentTaskReviewMetadata(deps.paths, taskId),
      });
      appendEvent(deps.paths, {
        type: "integration_failed",
        taskId,
        reason: feedback.message,
      });
    }
  }
  return false;
}

function markCompletedParallelSourceCheckboxes(
  deps: OrchestratorDeps,
  sched: SchedulerRun,
  plan: ReturnType<typeof parsePlanFile>,
): void {
  for (const task of [...sched.tasks.values()].sort(
    (a, b) => a.planIndex - b.planIndex,
  )) {
    if (task.status !== "landed" && task.status !== "satisfied") {
      continue;
    }
    const planTask = plan.tasks.find((t) => t.index === task.planIndex);
    if (!planTask) {
      continue;
    }
    markSourceCheckboxDone(deps, task.id, planTask);
  }
}

async function healReviewerMutations(args: {
  taskGit: GitClient;
  planArtifacts: string[];
  stagedFingerprintBefore: string;
  candidatePatch: string;
  worktreeFingerprintBefore: string;
  committedSha?: string;
}): Promise<void> {
  const {
    taskGit,
    planArtifacts,
    stagedFingerprintBefore,
    candidatePatch,
    worktreeFingerprintBefore,
    committedSha,
  } = args;

  if (committedSha) {
    const worktreeFingerprintAfter =
      await taskGit.worktreeFingerprintExcept(planArtifacts);
    if (worktreeFingerprintAfter === worktreeFingerprintBefore) {
      return;
    }
    await taskGit.resetHard(committedSha);
    const healedWorktreeFingerprint =
      await taskGit.worktreeFingerprintExcept(planArtifacts);
    if (healedWorktreeFingerprint !== worktreeFingerprintBefore) {
      throw new BlockedError(
        "reviewer changed the candidate diff and auto-heal failed",
      );
    }
    return;
  }

  const stagedFingerprintAfter = await taskGit.stagedFingerprint();
  const worktreeFingerprintAfter =
    await taskGit.worktreeFingerprintExcept(planArtifacts);

  if (
    stagedFingerprintAfter === stagedFingerprintBefore &&
    worktreeFingerprintAfter === worktreeFingerprintBefore
  ) {
    return;
  }

  if (stagedFingerprintAfter === stagedFingerprintBefore) {
    await taskGit.restoreWorktreeFromIndexExcept(planArtifacts);
  } else {
    await taskGit.restoreStagedPatch(candidatePatch, planArtifacts);
  }

  const healedStagedFingerprint = await taskGit.stagedFingerprint();
  const healedWorktreeFingerprint =
    await taskGit.worktreeFingerprintExcept(planArtifacts);
  if (
    healedStagedFingerprint !== stagedFingerprintBefore ||
    healedWorktreeFingerprint !== worktreeFingerprintBefore
  ) {
    throw new BlockedError(
      "reviewer changed the candidate diff and auto-heal failed",
    );
  }
}

export class BlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BlockedError";
  }
}

export class StoppedError extends Error {
  constructor() {
    super("stopped");
    this.name = "StoppedError";
  }
}

export class OverallReviewFollowupError extends Error {
  readonly artifactPath: string;
  constructor(artifactPath: string, message: string) {
    super(message);
    this.name = "OverallReviewFollowupError";
    this.artifactPath = artifactPath;
  }
}

function markSourceCheckboxDone(
  deps: OrchestratorDeps,
  taskId: string,
  planTask: PlanTask,
): void {
  if (deps.executionManifest) {
    const manifestTask = deps.executionManifest.tasks.find(
      (t) => t.planIndex === planTask.index,
    );
    const ref = manifestTask?.sourceCheckbox;
    if (ref) {
      const result = tryMarkSourceCheckboxDone(ref, {
        title: manifestTask.title,
        taskId: manifestTask.id,
        sourceRefs: manifestTask.sourceRefs,
        fallbackPath: deps.planPath,
        allowedPaths: deps.planArtifacts,
      });
      if (!result.ok && deps.paths) {
        persistTaskArtifact(
          deps.paths,
          taskId,
          "source-checkbox.md",
          `# Source checkbox update skipped\n\n${result.reason}\n`,
        );
      }
    } else {
      const result = tryMarkSourceCheckboxDone(undefined, {
        title: manifestTask?.title ?? planTask.text,
        taskId: manifestTask?.id,
        sourceRefs: manifestTask?.sourceRefs,
        fallbackPath: deps.planPath,
        allowedPaths: deps.planArtifacts,
      });
      if (!result.ok && deps.paths) {
        persistTaskArtifact(
          deps.paths,
          taskId,
          "source-checkbox.md",
          `# Source checkbox update skipped\n\n${result.reason}\n`,
        );
      }
    }
    return;
  }

  try {
    markTaskDone(deps.planPath, planTask);
  } catch (err) {
    if (deps.paths) {
      const reason = err instanceof Error ? err.message : String(err);
      persistTaskArtifact(
        deps.paths,
        taskId,
        "source-checkbox.md",
        `# Source checkbox update failed\n\n${reason}\n`,
      );
    }
  }
}

function markSourceCheckboxUndone(
  deps: OrchestratorDeps,
  taskId: string,
  planTask: PlanTask,
): void {
  if (deps.executionManifest) {
    const manifestTask = deps.executionManifest.tasks.find(
      (t) => t.planIndex === planTask.index,
    );
    const ref = manifestTask?.sourceCheckbox;
    if (ref) {
      const result = tryMarkSourceCheckboxUndone(ref, {
        title: manifestTask.title,
        taskId: manifestTask.id,
        sourceRefs: manifestTask.sourceRefs,
        fallbackPath: deps.planPath,
        allowedPaths: deps.planArtifacts,
      });
      if (!result.ok && deps.paths) {
        persistTaskArtifact(
          deps.paths,
          taskId,
          "source-checkbox.md",
          `# Source checkbox undo skipped\n\n${result.reason}\n`,
        );
      }
    } else {
      const result = tryMarkSourceCheckboxUndone(undefined, {
        title: manifestTask?.title ?? planTask.text,
        taskId: manifestTask?.id,
        sourceRefs: manifestTask?.sourceRefs,
        fallbackPath: deps.planPath,
        allowedPaths: deps.planArtifacts,
      });
      if (!result.ok && deps.paths) {
        persistTaskArtifact(
          deps.paths,
          taskId,
          "source-checkbox.md",
          `# Source checkbox undo skipped\n\n${result.reason}\n`,
        );
      }
    }
    return;
  }

  try {
    markTaskUndone(deps.planPath, planTask);
  } catch (err) {
    if (deps.paths) {
      const reason = err instanceof Error ? err.message : String(err);
      persistTaskArtifact(
        deps.paths,
        taskId,
        "source-checkbox.md",
        `# Source checkbox undo failed\n\n${reason}\n`,
      );
    }
  }
}

function persistTaskArtifact(
  paths: StatePaths,
  taskId: string,
  filename: string,
  content: string,
): void {
  const dir = join(paths.tasksDir, taskId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, filename), content, "utf-8");
}

function snapshotPlanArtifacts(
  paths: string[],
): Map<string, string | undefined> {
  return new Map(
    paths.map((path) => {
      try {
        return [path, readFileSync(path, "utf-8")];
      } catch {
        return [path, undefined];
      }
    }),
  );
}

function restorePlanArtifacts(
  paths: string[],
  snapshot: Map<string, string | undefined>,
): void {
  for (const path of paths) {
    const content = snapshot.get(path);
    if (content === undefined) {
      rmSync(path, { force: true });
    } else {
      writeFileSync(path, content, "utf-8");
    }
  }
}

function changedSnapshotPath(
  paths: string[],
  snapshot: Map<string, string | undefined>,
): string | undefined {
  for (const path of paths) {
    const content = snapshot.get(path);
    try {
      if (readFileSync(path, "utf-8") !== content) {
        return path;
      }
    } catch {
      if (content !== undefined) {
        return path;
      }
    }
  }
  return undefined;
}

function recordSystemFailure(
  taskIndex: number,
  currentFailures: number,
  source: "system" | "commit-hook",
  message: string,
): RetryFeedback {
  if (currentFailures + 1 >= MAX_SYSTEM_FAILURES) {
    throw new BlockedError(
      `system retry limit reached for task ${taskIndex}: ${message}`,
    );
  }
  return { source, message };
}

function reviewerFeedback(requiredChanges: string[]): RetryFeedback {
  const message = requiredChanges.map((change) => `- ${change}`).join("\n");
  return { source: "reviewer", message };
}

function formatFeedback(feedback: RetryFeedback): string {
  return `Source: ${feedback.source}\n${feedback.message}`;
}

function formatRequiredChanges(requiredChanges: string[]): string {
  return requiredChanges
    .map((change) => change.replace(/\s+/g, " ").trim())
    .join("; ");
}

function throwIfStopped(deps: OrchestratorDeps): void {
  if (deps.signal?.aborted || deps.shouldStop()) {
    throw new StoppedError();
  }
}

async function throwIfStoppedAndReset(
  deps: OrchestratorDeps,
  taskGit: GitClient,
): Promise<void> {
  try {
    throwIfStopped(deps);
  } catch (err) {
    if (err instanceof StoppedError) {
      await taskGit.reset();
    }
    throw err;
  }
}

async function resetTaskForRetry(
  taskGit: GitClient,
  worktreePath: string | undefined,
  resetSha: string,
  planArtifacts: string[],
): Promise<void> {
  if (worktreePath) {
    await taskGit.resetHard(resetSha);
    await taskGit.restoreWorktreeFromIndexExcept(planArtifacts);
    return;
  }
  await taskGit.reset();
}

function shortTask(text: string): string {
  return text.length <= 80 ? text : `${text.slice(0, 77)}…`;
}
