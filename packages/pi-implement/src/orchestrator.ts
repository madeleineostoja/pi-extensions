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
  buildAnchoredTaskReviewPrompt,
  buildInitialTaskReviewPrompt,
  buildImplementerPrompt,
  buildIntegrationReviewerPrompt,
  buildIntegrationSelfHealPrompt,
  buildInitialOverallReviewPrompt,
  buildAnchoredOverallReviewPrompt,
  buildOverallReworkPrompt,
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
import {
  captureRestoreSnapshot,
  checkpointCandidate,
  persistDiscardedBundle,
  protectedArtifactsChanged,
  restoreAndVerify,
  snapshotChanged,
  type CandidateMetadata,
  type RestoreSnapshot,
} from "./candidate.js";
import type { SubagentClient } from "./subagents.js";
import type { EffectiveRoles } from "./config.js";
import {
  persistPapercutCandidates,
  type PapercutStoreFactory,
} from "./papercuts.js";
import type {
  RunState,
  ParallelTaskState,
  AgentDisplayRef,
  StatePatch,
} from "./status.js";
import {
  fallbackCommitMessage,
  isValidCommitMessage,
  parseAnchoredReviewResult,
  parseImplementerResult,
  parseInitialReviewResult,
  parseIntegrationSelfHealResult,
  parseOverallReworkResult,
  parseSchedulerSelfHealResult,
} from "./verdict.js";
import type {
  IntegrationSelfHealResult,
  SchedulerSelfHealResult,
} from "./verdict.js";
import type { OverallReviewJson, StatePaths, TaskJson } from "./state.js";
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
import { readGraphJson, writeGraphJson } from "./graph.js";
import {
  anchoredReviewSchema,
  implementerResultSchema,
  initialTaskReviewSchema,
  integrationAnchoredReviewSchema,
  integrationInitialReviewSchema,
  integrationSelfHealSchema,
  overallReworkSchema,
  initialOverallReviewSchema,
  schedulerSelfHealSchema,
  sourceMaterialRepairSchema,
} from "./result-schemas.js";
import type { ImplementGraph } from "./graph.js";
import {
  applyAnchoredReview,
  applyNoopReview,
  createReviewConvergenceState,
  openRegressionReviewEpoch,
} from "./review-convergence.js";
import {
  completeIntegrationRound,
  createIntegrationLedger,
  reassessIntegrationGate,
  sameIntegrationPipeline,
  type IntegrationGate,
} from "./integration-ledger.js";
import type {
  ReviewConvergenceState,
  ReviewFinding,
} from "./review-convergence.js";
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

const MAX_SYSTEM_FAILURES = 2;
const MAX_SELF_HEAL_ATTEMPTS = 2;
const VALIDATION_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_BROAD_PLANNER_FULL_FILE_CHARS = 20_000;

async function recordPapercuts(
  deps: OrchestratorDeps,
  value: unknown,
  role: string,
  taskId?: string,
): Promise<void> {
  try {
    const result = await persistPapercutCandidates(
      value,
      await deps.git.mainRoot(),
      {
        kind: "pi-implement",
        runId: deps.runId,
        taskId,
        role,
      },
      deps.papercutStoreFactory,
    );
    if (!result) {
      return;
    }
    if (deps.paths) {
      appendEvent(deps.paths, {
        type: "papercuts_processed",
        role,
        taskId,
        created: result.created,
        merged: result.merged,
        suppressed: result.suppressed,
        rejected: result.rejected,
      });
      if (result.warning) {
        appendEvent(deps.paths, {
          type: "papercuts_warning",
          role,
          taskId,
          message: result.warning,
        });
      }
    }
    const summary = `Papercuts: ${result.created} created, ${result.merged} merged, ${result.suppressed} suppressed`;
    deps.updateState((prev) => checkpointPatch(prev, summary));
  } catch (error) {
    const message = `Papercut persistence failed: ${error instanceof Error ? error.message : String(error)}`;
    if (deps.paths) {
      appendEvent(deps.paths, {
        type: "papercuts_warning",
        role,
        taskId,
        message,
      });
    }
    deps.updateState((prev) => checkpointPatch(prev, message));
  }
}

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
      completion: {
        description:
          "Submit corrected source material references or a material request.",
        schema: sourceMaterialRepairSchema,
      },
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

Submit corrected references or a material request through the injected completion tool as your final action.

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

function parseSourceMaterialRepairResponse(parsed: unknown):
  | {
      ok: true;
      value:
        | SourceMaterialRepairResponse
        | import("./needs-material.js").NeedsMaterialResponse;
    }
  | { ok: false; reason: string } {
  const needsMaterial = parseNeedsMaterialResponse(parsed);
  if (needsMaterial.ok) {
    return { ok: true, value: needsMaterial.value };
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
  papercutStoreFactory?: PapercutStoreFactory;
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

  if (!deps.paths || !deps.runId) {
    if (plan.tasks.some((task) => !task.checked)) {
      throw new BlockedError(
        "changed tasks require managed run state for isolated transactional landing",
      );
    }
    await runConvergentOverallReviewLoop(deps, plan, planArtifacts, runBaseSha);
    return;
  }
  const graph = readGraphJson(deps.paths.runDir);
  if (!graph) {
    await runUnmanagedImplementation(deps, plan, planArtifacts, runBaseSha);
    return;
  }
  await runParallelImplementation(deps, graph, plan, planArtifacts, runBaseSha);
}

async function runUnmanagedImplementation(
  deps: OrchestratorDeps,
  initialPlan: ReturnType<typeof parsePlanFile>,
  planArtifacts: string[],
  runBaseSha: string,
): Promise<void> {
  if (deps.paths && deps.runId) {
    const graph: ImplementGraph = {
      version: 1,
      runId: deps.runId,
      baseSha: await deps.git.head(),
      planPath: deps.planPath,
      planHash: readRunJson(deps.paths)?.planHash ?? "unmanaged",
      nodes: (deps.executionManifest?.tasks ?? []).map((task) => ({
        id: task.id,
        planIndex: task.planIndex,
        title: task.title,
        taskHash: task.taskHash,
        dependsOn: task.dependsOn,
        mode: task.mode ?? "serial",
        affectedAreas: task.affectedAreas,
        conflictHints: task.conflictHints,
        validationCommands: task.validationCommands ?? [],
        confidence: "high",
        reasons: task.reasons ?? [],
        evidencePaths: task.evidencePaths ?? [],
      })),
    };
    if (graph.nodes.length > 0) {
      await runParallelImplementation(
        deps,
        graph,
        initialPlan,
        planArtifacts,
        runBaseSha,
      );
      return;
    }
  }
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
      await runConvergentOverallReviewLoop(
        deps,
        plan,
        planArtifacts,
        runBaseSha,
      );
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
    const worktreePath =
      deps.mode === "parallel" && deps.paths
        ? join(deps.paths.worktreesDir, taskId)
        : undefined;

    if (worktreePath) {
      await deps.git.createTaskBranch(branchName, baseSha);
      await deps.git.addWorktree(worktreePath, branchName);
      writeTaskJson(deps.paths!, taskId, {
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

    const taskGit = worktreePath
      ? deps.git.forWorktree(worktreePath, await deps.git.root())
      : deps.git;
    const unmanagedTask: SchedulerTask = {
      id: taskId,
      planIndex: task.index,
      title: task.text,
      status: "coding",
      dependsOn: [],
      mode: deps.mode === "parallel" ? "parallel" : "serial",
      sourceBaseSha: baseSha,
      baseSha,
      candidateBaseSha: baseSha,
      discardedBundles: [],
      worktreePath,
      branchName,
      activeAgentIds: [],
      activeAgentRefs: [],
      integrationAttempts: 0,
      selfHealAttempts: 0,
    };

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
      schedulerTask: unmanagedTask,
    });
    if (!landed) {
      return;
    }
    if (!worktreePath) {
      continue;
    }
    if (landed === "satisfied") {
      await cleanupTaskWorkspace(deps, unmanagedTask);
      markSourceCheckboxDone(deps, taskId, task);
      continue;
    }
    const taskJson = deps.paths ? readTaskJson(deps.paths, taskId) : undefined;
    Object.assign(unmanagedTask, {
      status: "approved" as const,
      taskCommitSha:
        taskJson?.taskCommitSha ??
        unmanagedTask.candidateSha ??
        (await taskGit.head()),
      candidateSha: taskJson?.candidateSha ?? unmanagedTask.candidateSha,
      candidateBaseSha:
        taskJson?.candidateBaseSha ?? unmanagedTask.candidateBaseSha ?? baseSha,
      sourceBaseSha:
        taskJson?.sourceBaseSha ?? unmanagedTask.sourceBaseSha ?? baseSha,
      trustedCheckpoint:
        taskJson?.trustedCheckpoint ?? unmanagedTask.trustedCheckpoint,
      approvedCommitMessage:
        taskJson?.commitMessage ??
        unmanagedTask.approvedCommitMessage ??
        `chore: implement ${task.text}`,
      integrationLedger:
        taskJson?.integrationLedger ?? unmanagedTask.integrationLedger,
    });
    const scheduler: SchedulerRun = {
      runId,
      maxConcurrency: 1,
      tasks: new Map([[taskId, unmanagedTask]]),
      landedOrder: [],
      phase: "integrating",
    };
    const result = await landApprovedTask(
      deps,
      scheduler,
      taskId,
      plan,
      planArtifacts,
    );
    if (result === "landed") {
      markSourceCheckboxDone(deps, taskId, task);
      continue;
    }
    if (result === "needs_rework") {
      continue;
    }
    throw new BlockedError(
      unmanagedTask.lastReason ?? `Task ${task.index} integration failed`,
    );
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
): { planTask: PlanTask } | undefined {
  for (const manifestTask of manifest.tasks) {
    const planTask = plan.tasks.find(
      (task) => task.index === manifestTask.planIndex,
    );
    if (!planTask || planTask.checked) {
      continue;
    }
    if (paths) {
      const taskJson = readTaskJsonByPlanIndex(paths, manifestTask.planIndex);
      if (taskJson?.status === "landed" || taskJson?.status === "satisfied") {
        continue;
      }
    }
    return { planTask };
  }
  return undefined;
}

function completedPlanTaskIndex(
  plan: ReturnType<typeof parsePlanFile>,
): number | undefined {
  return plan.tasks.length > 0 ? plan.tasks.length : undefined;
}

// ── Parallel scheduler ──────────────────────────────────────────────────────

type WorkerResult = {
  taskId: string;
  outcome:
    | { kind: "approved"; taskCommitSha: string; commitMessage: string }
    | { kind: "satisfied" }
    | { kind: "stalled"; reason: string }
    | { kind: "failed"; reason: string }
    | { kind: "stopped" };
};

async function runParallelImplementation(
  deps: OrchestratorDeps,
  graph: ImplementGraph,
  initialPlan: ReturnType<typeof parsePlanFile>,
  planArtifacts: string[],
  runBaseSha: string,
): Promise<void> {
  const sched = deps.paths
    ? hydrateSchedulerRun(graph, deps.maxConcurrency ?? 1, deps.paths)
    : createSchedulerRun(graph, deps.maxConcurrency ?? 1);
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
    throwIfStopped(deps);
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
      } else if (result.outcome.kind === "stalled") {
        task.status = "stalled";
        task.lastReason = result.outcome.reason;
        task.activeAgentIds = [];
        task.activeAgentRefs = [];
        if (deps.paths) {
          const existing = readTaskJson(deps.paths, result.taskId);
          writeTaskJson(deps.paths, result.taskId, {
            ...buildTaskJsonSnapshot(existing, task),
            status: "stalled",
            activeSubagentIds: [],
            lastReason: result.outcome.reason,
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
      throwIfStopped(deps);
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
    await runConvergentOverallReviewLoop(
      deps,
      initialPlan,
      planArtifacts,
      graph.baseSha,
    );
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

function hydrateSchedulerRun(
  graph: ImplementGraph,
  maxConcurrency: number,
  paths: StatePaths,
): SchedulerRun {
  const sched = createSchedulerRun(graph, maxConcurrency);
  for (const task of sched.tasks.values()) {
    const persisted = readTaskJson(paths, task.id);
    if (!persisted) {
      continue;
    }
    Object.assign(task, {
      status:
        persisted.status === "coding" ||
        persisted.status === "reviewing" ||
        persisted.status === "stalled" ||
        persisted.status === "stopped"
          ? "needs_rework"
          : persisted.status === "integration_failed"
            ? "stalled"
            : persisted.status,
      sourceBaseSha: persisted.sourceBaseSha,
      baseSha: persisted.baseSha,
      candidateBaseSha: persisted.candidateBaseSha,
      candidateSha: persisted.candidateSha,
      candidateTree: persisted.candidateTree,
      trustedCheckpoint: persisted.trustedCheckpoint,
      discardedBundles: persisted.discardedBundles ?? [],
      worktreePath: persisted.worktreePath,
      branchName: persisted.branchName,
      taskCommitSha: persisted.taskCommitSha,
      landedCommitSha: persisted.landedCommitSha,
      integrationAttempts: persisted.integrationAttempts,
      selfHealAttempts: persisted.selfHealAttempts ?? 0,
      lastReason: persisted.lastReason,
      approvedCommitMessage: persisted.commitMessage,
      integrationLedger: persisted.integrationLedger,
    });
    if (task.status === "landed" || task.status === "satisfied") {
      sched.landedOrder.push(task.id);
    }
  }
  return sched;
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
  const existing = readTaskJson(deps.paths!, taskId);
  const baseSha =
    existing?.candidateBaseSha ?? task.baseSha ?? (await deps.git.head());
  const sourceBaseSha =
    task.sourceBaseSha ?? existing?.sourceBaseSha ?? baseSha;
  const runId = deps.runId!;
  const branchName = `pi-implement/${runId}/${taskId}`;
  const worktreePath = join(deps.paths!.worktreesDir, taskId);

  task.sourceBaseSha = sourceBaseSha;
  task.baseSha = baseSha;
  task.candidateBaseSha = existing?.candidateBaseSha ?? baseSha;
  task.candidateSha = existing?.candidateSha;
  task.candidateTree = existing?.candidateTree;
  task.integrationLedger = existing?.integrationLedger;
  task.trustedCheckpoint = existing?.trustedCheckpoint;
  task.discardedBundles = existing?.discardedBundles ?? [];
  task.worktreePath = worktreePath;
  task.branchName = branchName;
  writeTaskJson(deps.paths!, taskId, {
    ...buildTaskJsonSnapshot(existing, task),
    status: "coding",
  });

  let createdWorkspace = false;
  let createdBranch = false;
  try {
    if (wasNeedsRework && !existing?.trustedCheckpoint) {
      await deps.git.removeWorktree(worktreePath).catch(() => undefined);
      await deps.git.deleteTaskBranch(branchName).catch(() => undefined);
    }
    const registeredWorktrees = await deps.git.listWorktrees();
    if (!registeredWorktrees.includes(worktreePath)) {
      if (wasNeedsRework && existing?.trustedCheckpoint) {
        await deps.git.addWorktree(worktreePath, branchName);
      } else {
        await deps.git.createTaskBranch(branchName, baseSha);
        createdBranch = true;
        await deps.git.addWorktree(worktreePath, branchName);
      }
      createdWorkspace = true;
    }
    appendEvent(deps.paths!, { type: "task_started", taskId });
  } catch (err) {
    if (createdWorkspace || createdBranch) {
      await deps.git.removeWorktree(worktreePath).catch(() => undefined);
      await deps.git.deleteTaskBranch(branchName).catch(() => undefined);
    }
    const reason = err instanceof Error ? err.message : String(err);
    return {
      taskId,
      outcome: { kind: "failed", reason: `Worktree setup failed: ${reason}` },
    };
  }

  const mainRepoRoot = await deps.git.root();
  const taskGit = deps.git.forWorktree(worktreePath, mainRepoRoot);
  const taskPlanArtifacts = planArtifacts.map((artifact) => {
    if (!isAbsolute(artifact)) {
      return artifact;
    }
    const withinMainRoot = relative(mainRepoRoot, artifact);
    return withinMainRoot && !withinMainRoot.startsWith("..")
      ? join(worktreePath, withinMainRoot)
      : artifact;
  });
  if (wasNeedsRework && existing?.trustedCheckpoint) {
    const retainedSnapshot = await captureRestoreSnapshot(
      taskGit,
      taskPlanArtifacts,
    );
    const [actualBranch, actualHead, actualTree, checkpointTree] =
      await Promise.all([
        taskGit.currentBranch(),
        taskGit.head(),
        taskGit.tree(),
        taskGit.treeAt(existing.trustedCheckpoint),
      ]);
    if (
      actualBranch !== branchName ||
      actualHead !== existing.trustedCheckpoint ||
      actualTree !== checkpointTree ||
      retainedSnapshot.activeOperation ||
      retainedSnapshot.workingPatch ||
      retainedSnapshot.untrackedPaths.length > 0 ||
      (existing.candidateSha && retainedSnapshot.head !== existing.candidateSha)
    ) {
      throw new BlockedError(
        "retained task worktree does not match its trusted checkpoint",
      );
    }
  }

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
      planArtifacts: taskPlanArtifacts,
      schedulerTask: task,
      runBaseSha,
      wasNeedsRework,
      initialFeedback:
        wasNeedsRework && task.lastReason
          ? { source: "integration", message: task.lastReason }
          : undefined,
    });

    if (deps.shouldStop() || deps.signal?.aborted) {
      return { taskId, outcome: { kind: "stopped" } };
    }

    if (success === "satisfied") {
      await cleanupTaskWorkspace(deps, task);
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
    if (err instanceof IntegrationSafetyError) {
      throw err;
    }
    if (err instanceof TaskStalledError) {
      return { taskId, outcome: { kind: "stalled", reason: err.message } };
    }
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
  const candidateSha = task.candidateSha ?? task.taskCommitSha;
  const candidateBaseSha = task.candidateBaseSha ?? task.baseSha;
  if (!candidateSha || !candidateBaseSha) {
    return markIntegrationFailure(
      deps,
      task,
      taskId,
      "Candidate identity or base SHA missing",
    );
  }
  let candidateDelta: string;
  try {
    const candidateTree = await deps.git.treeAt(candidateSha);
    await deps.git.treeAt(candidateBaseSha);
    if (task.trustedCheckpoint && candidateSha !== task.trustedCheckpoint) {
      throw new Error("candidate SHA does not match the trusted checkpoint");
    }
    if (task.taskCommitSha && candidateSha !== task.taskCommitSha) {
      throw new Error("candidate SHA does not match the approved task commit");
    }
    if (task.candidateTree && candidateTree !== task.candidateTree) {
      throw new Error(
        "candidate tree does not match the recorded candidate tree",
      );
    }
    if (!(await deps.git.isAncestor(candidateBaseSha, candidateSha))) {
      throw new Error(
        `candidate base ${candidateBaseSha} is not an ancestor of ${candidateSha}`,
      );
    }
    candidateDelta = await deps.git.diffRange(candidateBaseSha, candidateSha);
  } catch (error) {
    return markIntegrationFailure(
      deps,
      task,
      taskId,
      `Candidate identity/base is not eligible: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  task.status = "integrating";
  deps.updateState({ phase: "integrating" });

  const planTask = plan.tasks.find((t) => t.index === task.planIndex);
  if (!planTask) {
    return markIntegrationFailure(deps, task, taskId, "Plan task not found");
  }

  const integrationStartHead = await deps.git.head();
  const validationCommands = await resolveValidationCommands(deps);
  const integrationGates: IntegrationGate[] = [
    {
      key: "apply",
      kind: "apply",
      label: "Apply or transplant candidate delta",
    },
    ...validationCommands.map((command, index) => ({
      key: `validator:${index}`,
      kind: "validator" as const,
      label: `Validator: ${command.display}`,
    })),
    { key: "hook", kind: "hook", label: "Approval hook" },
    ...(validationCommands.length === 0
      ? [
          {
            key: "fallback",
            kind: "fallback" as const,
            label: "Fallback integration review",
          },
        ]
      : []),
  ];
  if (
    !sameIntegrationPipeline(
      task.integrationLedger,
      integrationStartHead,
      integrationGates,
    )
  ) {
    task.integrationLedger = createIntegrationLedger({
      epoch: (task.integrationLedger?.epoch ?? 0) + 1,
      mainBaseSha: integrationStartHead,
      gates: integrationGates,
    });
  }
  const recordGate = (key: string, passed: boolean, evidence: string) => {
    const update = reassessIntegrationGate({
      ledger: task.integrationLedger!,
      key,
      passed,
      evidence,
    });
    task.integrationLedger = update.ledger;
    return update.outcome;
  };
  const preflightRework = async (source: "apply" | "hook", reason: string) => {
    recordGate(source, false, reason);
    const completed = completeIntegrationRound(task.integrationLedger!);
    task.integrationLedger = completed.ledger;
    task.lastReason = reason;
    task.status = completed.outcome === "stalled" ? "stalled" : "needs_rework";
    persistIntegrationState(deps, taskId, task);
    return "needs_rework" as const;
  };
  if (candidateBaseSha !== integrationStartHead) {
    const transplanted = await transplantTaskCandidate(
      deps,
      task,
      taskId,
      candidateSha,
      candidateDelta,
      integrationStartHead,
      planArtifacts,
    );
    if (!transplanted.ok) {
      if (transplanted.hardBlocked) {
        throw new BlockedError(transplanted.reason);
      }
      return await preflightRework("apply", transplanted.reason);
    }
    recordGate(
      "apply",
      true,
      "Candidate transplanted onto the current main checkout.",
    );
    task.status = "needs_rework";
    task.lastReason =
      "Candidate transplanted onto the current main checkout; run regression review before integration.";
    persistIntegrationState(deps, taskId, task);
    return "needs_rework";
  }
  const candidateHook = await verifyTaskCheckpointHooks(
    deps,
    task,
    candidateSha,
    planArtifacts,
  );
  if (!candidateHook.ok) {
    if (candidateHook.hardBlocked) {
      throw new BlockedError(candidateHook.reason);
    }
    return await preflightRework("hook", candidateHook.reason);
  }
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
  const preIntegrationSnapshot = await captureRestoreSnapshot(
    deps.git,
    planArtifacts,
  );

  const failForRework = async (
    source: string,
    reason: string,
    semanticProgress = false,
  ) => {
    const gate =
      source === "cherry-pick" || source === "transplant"
        ? "apply"
        : source.startsWith("validator:")
          ? source
          : source === "commit-hook" || source === "hook"
            ? "hook"
            : source === "fallback"
              ? "fallback"
              : undefined;
    if (
      gate &&
      task.integrationLedger?.gates.some((item) => item.key === gate)
    ) {
      recordGate(gate, false, reason);
    }
    const completedRound = semanticProgress
      ? {
          ledger: {
            ...task.integrationLedger!,
            consecutiveStalledRounds: 0,
          },
          outcome: "continue" as const,
        }
      : completeIntegrationRound(task.integrationLedger!);
    task.integrationLedger = completedRound.ledger;
    const convergence = completedRound.outcome;
    const rollback = await rollbackIntegration(
      deps,
      preIntegrationHead,
      planArtifacts,
      planArtifactSnapshot,
      preIntegrationSnapshot,
    );
    const detail = annotateRollbackReason(reason, rollback, preIntegrationHead);
    task.integrationAttempts++;
    task.lastReason = `${source}: ${detail}`;
    if (deps.paths) {
      persistTaskArtifact(
        deps.paths,
        taskId,
        "integration.md",
        `# Integration failed\n\nSource: ${source}\n\nPre-integration HEAD: ${preIntegrationHead}\n\n${detail}\n`,
      );
      appendEvent(deps.paths, {
        type: "integration_failed",
        taskId,
        reason: task.lastReason,
      });
    }
    if (!rollback.exactRestored) {
      task.status = "integration_failed";
      task.lastReason = `${task.lastReason}\n\nRollback proof failed; integration is hard-blocked.`;
      persistIntegrationState(deps, taskId, task);
      return "integration_failed" as const;
    }
    if (convergence === "stalled") {
      task.status = "stalled";
      task.lastReason = `${task.lastReason}\n\nIntegration stalled without a new low outstanding count.`;
      persistIntegrationState(deps, taskId, task);
      return "needs_rework" as const;
    }
    task.status = "needs_rework";
    persistIntegrationState(deps, taskId, task);
    return "needs_rework" as const;
  };

  const failBlocked = async (source: string, reason: string) => {
    const rollback = await rollbackIntegration(
      deps,
      preIntegrationHead,
      planArtifacts,
      planArtifactSnapshot,
      preIntegrationSnapshot,
    );
    const detail = annotateRollbackReason(reason, rollback, preIntegrationHead);
    task.integrationAttempts++;
    task.status = "integration_failed";
    task.lastReason = `${source}: ${detail}`;
    if (deps.paths) {
      persistTaskArtifact(
        deps.paths,
        taskId,
        "integration.md",
        `# Integration blocked\n\nSource: ${source}\n\nPre-integration HEAD: ${preIntegrationHead}\n\n${detail}\n`,
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

    // ── Apply the complete candidate-base-to-candidate delta ──
    let cherryPick = await deps.git.applyPatch(candidateDelta);
    let cherryPickSucceeded = cherryPick.exitCode === 0;
    if (cherryPickSucceeded) {
      recordGate("apply", true, "Candidate delta applied successfully.");
    }
    if (!cherryPickSucceeded) {
      const preHealStagedPaths = parseNameStatusPaths(
        await deps.git.stagedNameStatus(),
      );
      const preHealSnapshot: IntegrationCandidateSnapshot = {
        head: preIntegrationHead,
        tree: "",
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
        if (healResult.result.retryMode === "continue_candidate") {
          return await failForRework(
            "transplant",
            "Integration self-heal changed the candidate. Its edits were restored; explicit task rework must checkpoint and pass regression review before retry.",
          );
        }
        if (healResult.result.retryMode === "retry_cherry_pick") {
          const retryRollback = await rollbackIntegration(
            deps,
            preIntegrationHead,
            planArtifacts,
            planArtifactSnapshot,
            preIntegrationSnapshot,
          );
          if (!retryRollback.exactRestored) {
            return await failBlocked(
              "rollback",
              "Integration retry rollback could not be proved exact.",
            );
          }
          cherryPick = await deps.git.applyPatch(candidateDelta);
          cherryPickSucceeded = cherryPick.exitCode === 0;
          if (cherryPickSucceeded) {
            recordGate("apply", true, "Candidate delta applied successfully.");
          }
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
      validationCommands,
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
      const healedCandidateChanged = await integrationCandidateChanged(
        deps,
        planArtifacts,
        preHealSnapshot,
      );
      if (healedCandidateChanged) {
        return await failForRework(
          "validation",
          "Integration self-heal changed the candidate. Its edits were restored; explicit task rework must checkpoint and pass regression review before retry.",
        );
      }
      if (healResult.result.retryMode === "retry_cherry_pick") {
        const retryRollback = await rollbackIntegration(
          deps,
          preIntegrationHead,
          planArtifacts,
          planArtifactSnapshot,
          preIntegrationSnapshot,
        );
        if (!retryRollback.exactRestored) {
          return await failBlocked(
            "rollback",
            "Integration retry rollback could not be proved exact.",
          );
        }
        const cp = await deps.git.applyPatch(candidateDelta);
        if (cp.exitCode !== 0) {
          return await failForRework(
            "cherry-pick",
            cp.stderr || cp.stdout || "git cherry-pick --no-commit failed",
          );
        }
        recordGate("apply", true, "Candidate delta applied successfully.");
      } else if (healResult.result.retryMode !== "retry_validation") {
        return await failForRework(
          "validation",
          "Integration self-heal changed the candidate. Its edits were restored; explicit task rework must checkpoint and pass regression review before retry.",
        );
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
        validationCommands,
      );
    }

    for (const gate of validation.passedGates ?? []) {
      recordGate(gate, true, "Validator passed.");
    }
    if (!validation.ok) {
      if (validation.hardBlocked) {
        await failBlocked(
          validation.failedGate ?? "validation",
          validation.reason,
        );
        throw new IntegrationSafetyError(validation.reason);
      }
      return await failForRework(
        validation.failedGate ?? "validation",
        validation.reason,
        validation.semanticProgress,
      );
    }
    if (validationCommands.length === 0) {
      recordGate(
        "fallback",
        true,
        "Typed fallback integration review approved.",
      );
    }
    const mutationReason = await detectIntegrationMutation(
      deps,
      planArtifacts,
      planArtifactSnapshot,
      candidateSnapshot,
    );
    if (mutationReason) {
      await failBlocked("validation", mutationReason);
      throw new IntegrationSafetyError(mutationReason);
    }

    throwIfStopped(deps);
    const commit = await deps.git.commit(
      task.approvedCommitMessage ?? `chore: implement ${task.title}`,
    );
    if (commit.exitCode !== 0) {
      return await failForRework(
        "commit-hook",
        commit.stderr || commit.stdout || "git commit failed",
      );
    }

    recordGate("hook", true, "Approval hook passed.");
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
      return await failForRework(
        "commit-hook",
        "approval hook left content outside the reviewed candidate; restored content requires explicit rework and a fresh hook run",
      );
    }
    if ((await deps.git.treeAt(landedHead)) !== candidateSnapshot.tree) {
      return await failForRework(
        "commit-hook",
        "commit hook changed the approved candidate tree; explicit rework and a fresh hook run are required",
      );
    }

    if (task.integrationLedger!.outstandingIds.length > 0) {
      return await failForRework(
        "integration",
        "Integration ledger has outstanding obligations after validation.",
      );
    }
    task.candidateBaseSha = preIntegrationHead;
    task.candidateSha = landedHead;
    task.candidateTree = candidateSnapshot.tree;
    task.trustedCheckpoint = landedHead;
    task.taskCommitSha = landedHead;
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

    await cleanupTaskWorkspace(deps, task);

    deps.updateState((prev) => ({
      currentMainHead: landedHead,
      ...checkpointPatch(
        prev,
        `\u2713 Task ${task.planIndex + 1}/${plan.tasks.length} landed @ ${landedHead.slice(0, 7)}`,
      ),
    }));
    return "landed";
  } catch (err) {
    if (err instanceof IntegrationSafetyError) {
      await failBlocked("safety", err.message);
      throw err;
    }
    if (err instanceof BlockedError) {
      throw err;
    }
    const reason = err instanceof Error ? err.message : String(err);
    return await failForRework("integration", reason);
  }
}

async function transplantTaskCandidate(
  deps: OrchestratorDeps,
  task: SchedulerTask,
  taskId: string,
  candidateSha: string,
  candidateDelta: string,
  mainHead: string,
  planArtifacts: string[],
): Promise<
  { ok: true } | { ok: false; reason: string; hardBlocked?: boolean }
> {
  if (!task.worktreePath) {
    return {
      ok: false,
      reason: "Task candidate worktree is unavailable for transplantation",
    };
  }
  const mainRoot = await deps.git.root();
  const taskGit = deps.git.forWorktree(task.worktreePath, mainRoot);
  const taskPlanArtifacts = planArtifacts.map((artifact) =>
    isAbsolute(artifact)
      ? join(task.worktreePath!, relative(mainRoot, artifact))
      : artifact,
  );
  const snapshot = await captureRestoreSnapshot(taskGit, taskPlanArtifacts);
  try {
    await taskGit.resetHard(mainHead);
    const applied = await taskGit.applyPatch(candidateDelta);
    if (applied.exitCode !== 0) {
      throw new Error(
        applied.stderr || applied.stdout || "could not apply candidate delta",
      );
    }
    await taskGit.stageAllExcept(taskPlanArtifacts);
    const candidate = await checkpointCandidate(taskGit, {
      sourceBaseSha: task.sourceBaseSha ?? task.baseSha ?? mainHead,
      candidateBaseSha: mainHead,
      branchName: task.branchName!,
      worktreePath: task.worktreePath,
      candidateSha: undefined,
      candidateTree: undefined,
      trustedCheckpoint: undefined,
      discardedBundles: task.discardedBundles,
    });
    if (candidate.result?.exitCode !== 0 || !candidate.changed) {
      throw new Error(
        candidate.result?.stderr ||
          candidate.result?.stdout ||
          "could not checkpoint transplanted candidate",
      );
    }
    Object.assign(task, candidate.candidate, { candidateBaseSha: mainHead });
    const existing = deps.paths ? readTaskJson(deps.paths, taskId) : undefined;
    if (existing?.review?.convergence) {
      existing.review.convergence.previousCandidate = mainHead;
      existing.review.convergence.previousCandidatePatch = "";
      existing.review.convergence.latestEvidence =
        "Candidate transplanted onto the current main checkout.";
      writeTaskJson(deps.paths!, taskId, {
        ...existing,
        candidateBaseSha: mainHead,
        candidateSha: candidate.candidate.candidateSha,
        candidateTree: candidate.candidate.candidateTree,
        trustedCheckpoint: candidate.candidate.trustedCheckpoint,
        review: existing.review,
      });
    }
    if (deps.paths) {
      persistTaskArtifact(
        deps.paths,
        taskId,
        "candidate-transplant.md",
        `# Candidate transplanted\n\nPrevious candidate: ${candidateSha}\nNew base: ${mainHead}\nNew candidate: ${candidate.candidate.trustedCheckpoint}\n`,
      );
    }
    return { ok: true };
  } catch (error) {
    try {
      await restoreAndVerify(taskGit, snapshot, taskPlanArtifacts);
    } catch (restoreError) {
      return {
        ok: false,
        hardBlocked: true,
        reason: `could not transplant candidate and could not restore its trusted state: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`,
      };
    }
    return {
      ok: false,
      reason: `could not transplant candidate onto current main: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

async function verifyTaskCheckpointHooks(
  deps: OrchestratorDeps,
  task: SchedulerTask,
  checkpoint: string,
  planArtifacts: string[],
): Promise<
  { ok: true } | { ok: false; reason: string; hardBlocked?: boolean }
> {
  if (!task.worktreePath) {
    return {
      ok: false,
      reason: "Task candidate worktree is unavailable for checkpoint hooks",
    };
  }
  const mainRoot = await deps.git.root();
  const taskGit = deps.git.forWorktree(task.worktreePath, mainRoot);
  const taskPlanArtifacts = planArtifacts.map((artifact) =>
    isAbsolute(artifact)
      ? join(task.worktreePath!, relative(mainRoot, artifact))
      : artifact,
  );
  const snapshot = await captureRestoreSnapshot(taskGit, taskPlanArtifacts);
  const approvedTree = await taskGit.treeAt(checkpoint);
  const hook = await taskGit.runCheckpointHooks(checkpoint);
  const hookTree = await taskGit.tree();
  const mutated = await snapshotChanged(taskGit, snapshot, taskPlanArtifacts, {
    ignoreHead: true,
  });
  try {
    await restoreAndVerify(taskGit, snapshot, taskPlanArtifacts);
  } catch (error) {
    return {
      ok: false,
      hardBlocked: true,
      reason: `task checkpoint hook state could not be restored: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (mutated || hookTree !== approvedTree) {
    return {
      ok: false,
      reason: "task checkpoint hook changed the approved candidate",
    };
  }
  if (hook.exitCode !== 0) {
    return {
      ok: false,
      reason: hook.stderr || hook.stdout || "task checkpoint hook failed",
    };
  }
  return { ok: true };
}

async function cleanupTaskWorkspace(
  deps: OrchestratorDeps,
  task: SchedulerTask,
): Promise<void> {
  if (!task.worktreePath || !task.branchName) {
    return;
  }
  await deps.git.removeWorktree(task.worktreePath).catch(() => undefined);
  await deps.git.deleteTaskBranch(task.branchName).catch(() => undefined);
}

function persistIntegrationState(
  deps: OrchestratorDeps,
  taskId: string,
  task: SchedulerTask,
): void {
  if (!deps.paths) {
    return;
  }
  const existing = readTaskJson(deps.paths, taskId);
  writeTaskJson(deps.paths, taskId, {
    ...buildTaskJsonSnapshot(existing, task),
    status: task.status,
    lastReason: task.lastReason,
  });
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

  return {
    ok: false,
    reason: `Main checkout dirty before integration; refusing to delete unowned changes. Status:\n${statusBefore}`,
  };
}

type RollbackOutcome = {
  headRestored: boolean;
  exactRestored: boolean;
  currentHead?: string;
};

async function rollbackIntegration(
  deps: OrchestratorDeps,
  preIntegrationHead: string,
  planArtifacts: string[],
  planArtifactSnapshot: Map<string, string | undefined>,
  snapshot: RestoreSnapshot,
): Promise<RollbackOutcome> {
  try {
    await restoreAndVerify(deps.git, snapshot, planArtifacts);
    return {
      headRestored: true,
      exactRestored: true,
      currentHead: snapshot.head,
    };
  } catch {
    await deps.git.cherryPickAbort().catch(async () => {
      await deps.git.resetHard(preIntegrationHead).catch(() => undefined);
    });
    await deps.git.resetHard(preIntegrationHead).catch(() => undefined);
    await deps.git
      .restoreWorktreeFromIndexExcept(planArtifacts)
      .catch(() => undefined);
    restorePlanArtifacts(planArtifacts, planArtifactSnapshot);
    const currentHead = await deps.git.head().catch(() => undefined);
    const exactRestored = await snapshotChanged(
      deps.git,
      snapshot,
      planArtifacts,
    )
      .then((changed) => !changed)
      .catch(() => false);
    return {
      headRestored: currentHead === preIntegrationHead && exactRestored,
      exactRestored,
      currentHead,
    };
  }
}

function annotateRollbackReason(
  reason: string,
  rollback: RollbackOutcome,
  preIntegrationHead: string,
): string {
  if (rollback.exactRestored) {
    return reason;
  }
  const at = rollback.currentHead
    ? ` HEAD is at ${rollback.currentHead.slice(0, 12)}.`
    : "";
  return `${reason}\n\nWARNING: rollback did not restore HEAD to ${preIntegrationHead.slice(0, 12)}; an integration commit may still be present on the branch.${at}`;
}

type IntegrationCandidateSnapshot = {
  head: string;
  tree: string;
  stagedFingerprint: string;
  worktreeFingerprint: string;
  stagedPaths: string[];
};

async function snapshotIntegrationCandidate(
  deps: OrchestratorDeps,
  planArtifacts: string[],
): Promise<IntegrationCandidateSnapshot> {
  const [head, tree, stagedFingerprint, worktreeFingerprint, stagedNameStatus] =
    await Promise.all([
      deps.git.head(),
      deps.git.tree(),
      deps.git.stagedFingerprint(),
      deps.git.worktreeFingerprintExcept(planArtifacts),
      deps.git.stagedNameStatus(),
    ]);
  const stagedPaths = parseNameStatusPaths(stagedNameStatus);
  return { head, tree, stagedFingerprint, worktreeFingerprint, stagedPaths };
}

async function integrationCandidateChanged(
  deps: OrchestratorDeps,
  planArtifacts: string[],
  snapshot: IntegrationCandidateSnapshot,
): Promise<boolean> {
  const current = await snapshotIntegrationCandidate(deps, planArtifacts);
  return (
    current.head !== snapshot.head ||
    current.tree !== snapshot.tree ||
    current.stagedFingerprint !== snapshot.stagedFingerprint ||
    current.worktreeFingerprint !== snapshot.worktreeFingerprint ||
    current.stagedPaths.join("\u0000") !== snapshot.stagedPaths.join("\u0000")
  );
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
    completion: {
      description: "Submit the integration self-heal result.",
      schema: integrationSelfHealSchema,
    },
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
      JSON.stringify(result.result, null, 2),
    );
    appendEvent(deps.paths, {
      type: "self_heal_completed",
      taskId,
      attempt: task.selfHealAttempts,
      result: JSON.stringify(result.result, null, 2),
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

  await recordPapercuts(deps, result.result, "selfHeal", taskId);
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
      completion: {
        description: "Submit the scheduler self-heal result.",
        schema: schedulerSelfHealSchema,
      },
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
        result: JSON.stringify(result.result, null, 2),
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

    await recordPapercuts(deps, result.result, "selfHeal");
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

type ValidationResult =
  | { ok: true; passedGates?: string[] }
  | {
      ok: false;
      reason: string;
      failedGate?: string;
      passedGates?: string[];
      semanticProgress?: boolean;
      hardBlocked?: boolean;
    };

async function validateIntegratedTask(
  deps: OrchestratorDeps,
  taskId: string,
  planArtifacts: string[],
  schedulerTask?: SchedulerTask,
  commands?: ValidationCommand[],
): Promise<ValidationResult> {
  const resolvedCommands = commands ?? (await resolveValidationCommands(deps));
  if (resolvedCommands.length > 0) {
    const passedGates: string[] = [];
    for (const [index, command] of resolvedCommands.entries()) {
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
          failedGate: `validator:${index}`,
          passedGates,
        };
      }
      passedGates.push(`validator:${index}`);
    }
    return { ok: true, passedGates };
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
  reviewerSystemFailures = 0,
): Promise<ValidationResult> {
  const reviewerSnapshot = await captureRestoreSnapshot(
    deps.git,
    planArtifacts,
  );
  const diff = await deps.git.stagedDiff();
  const fallbackState = schedulerTask?.integrationLedger?.fallbackReview;
  const outstanding = fallbackState
    ? fallbackState.findings.filter((finding) =>
        fallbackState.outstandingIds.includes(finding.id),
      )
    : undefined;
  const prompt = buildIntegrationReviewerPrompt({
    diff,
    planArtifacts,
    outstandingFindings: outstanding,
  });

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
    completion: {
      description: "Submit the typed integration review result.",
      schema: fallbackState
        ? integrationAnchoredReviewSchema
        : integrationInitialReviewSchema,
    },
  });
  const ref: AgentDisplayRef = {
    id,
    role: "reviewer",
    label: `Reviewer · Integration review · ${taskId}`,
    startedAt: new Date().toISOString(),
  };
  setSchedulerActiveAgent(schedulerTask, ref);
  deps.updateState((prev) => addActiveAgentPatch(prev, ref));
  for (;;) {
    const result = await deps.subagents.waitFor(id, deps.signal).finally(() => {
      clearSchedulerActiveAgent(schedulerTask, id);
      deps.updateState((prev) => removeActiveAgentPatch(prev, id));
    });
    const reviewerMutated = await snapshotChanged(
      deps.git,
      reviewerSnapshot,
      planArtifacts,
    );
    if (reviewerMutated) {
      try {
        await restoreAndVerify(deps.git, reviewerSnapshot, planArtifacts);
      } catch (error) {
        throw new IntegrationSafetyError(
          `integration fallback reviewer mutation could not be restored: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      throw new IntegrationSafetyError(
        "integration fallback reviewer changed the staged integration diff",
      );
    }
    if (
      result.status === "stopped" ||
      deps.signal?.aborted ||
      deps.shouldStop()
    ) {
      throw new StoppedError();
    }
    if (result.status !== "completed") {
      recordSystemFailure(
        schedulerTask?.planIndex ?? 0,
        reviewerSystemFailures,
        "system",
        `Integration review ${result.status}: ${result.error}`,
      );
      reviewerSystemFailures++;
      return runIntegrationReviewFallback(
        deps,
        taskId,
        planArtifacts,
        schedulerTask,
        reviewerSystemFailures,
      );
    }
    if (deps.paths) {
      persistTaskArtifact(
        deps.paths,
        taskId,
        "integration-review.md",
        JSON.stringify(result.result, null, 2),
      );
    }
    await recordPapercuts(deps, result.result, "reviewer", taskId);
    if (!schedulerTask?.integrationLedger) {
      return {
        ok: false,
        reason: "Integration fallback ledger is unavailable.",
      };
    }
    const candidateFingerprint = await deps.git.stagedFingerprint();
    const candidatePatch = await deps.git.stagedDiff();
    if (!fallbackState) {
      const parsed = parseInitialReviewResult(result.result);
      if (!parsed.ok) {
        recordSystemFailure(
          schedulerTask.planIndex,
          reviewerSystemFailures,
          "system",
          parsed.reason,
        );
        reviewerSystemFailures++;
        return runIntegrationReviewFallback(
          deps,
          taskId,
          planArtifacts,
          schedulerTask,
          reviewerSystemFailures,
        );
      }
      if (parsed.result.verdict === "approved") {
        return { ok: true };
      }
      schedulerTask.integrationLedger = {
        ...schedulerTask.integrationLedger,
        fallbackReview: createReviewConvergenceState({
          drafts: parsed.result.findings,
          idPrefix: "IF",
        }),
        fallbackCandidateFingerprint: candidateFingerprint,
        fallbackCandidatePatch: candidatePatch,
      };
      persistIntegrationState(deps, taskId, schedulerTask);
      return {
        ok: false,
        reason: parsed.result.findings
          .map((finding) => finding.requiredChange)
          .join("\n"),
        failedGate: "fallback",
      };
    }
    const parsed = parseAnchoredReviewResult(
      result.result,
      fallbackState.outstandingIds,
    );
    if (!parsed.ok) {
      recordSystemFailure(
        schedulerTask.planIndex,
        reviewerSystemFailures,
        "system",
        parsed.reason,
      );
      reviewerSystemFailures++;
      return runIntegrationReviewFallback(
        deps,
        taskId,
        planArtifacts,
        schedulerTask,
        reviewerSystemFailures,
      );
    }
    try {
      const previousPatch =
        schedulerTask.integrationLedger.fallbackCandidatePatch ?? "";
      const latestDeltaPaths = parseNameStatusPaths(
        (await deps.git.stagedDeltaFromPatch(previousPatch)).nameStatus,
      );
      const update = applyAnchoredReview({
        state: fallbackState,
        review: parsed.result,
        latestDeltaPaths,
        idPrefix: "IF",
      });
      schedulerTask.integrationLedger = {
        ...schedulerTask.integrationLedger,
        fallbackReview: update.state,
        fallbackCandidateFingerprint: candidateFingerprint,
        fallbackCandidatePatch: candidatePatch,
      };
      persistIntegrationState(deps, taskId, schedulerTask);
      if (update.outcome === "approved") {
        return { ok: true };
      }
      return {
        ok: false,
        reason:
          update.outcome === "stalled"
            ? "Typed integration fallback review stalled."
            : "Typed integration fallback review requested changes.",
        failedGate: "fallback",
        semanticProgress:
          update.state.bestOutstandingCount <
          fallbackState.bestOutstandingCount,
      };
    } catch (error) {
      recordSystemFailure(
        schedulerTask.planIndex,
        reviewerSystemFailures,
        "system",
        `Invalid anchored integration review: ${error instanceof Error ? error.message : String(error)}`,
      );
      reviewerSystemFailures++;
      return runIntegrationReviewFallback(
        deps,
        taskId,
        planArtifacts,
        schedulerTask,
        reviewerSystemFailures,
      );
    }
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

type OverallReviewState = {
  baseSha: string;
  branchName: string;
  worktreePath: string;
  candidate: CandidateMetadata;
  convergence: ReviewConvergenceState;
  closedEpochs: Array<{ epoch: number; findings: ReviewFinding[] }>;
  epoch: number;
  previousCandidate?: string;
  previousCandidatePatch?: string;
  latestEvidence?: string;
  integrationLedger?: ReturnType<typeof createIntegrationLedger>;
};

function overallPlanContext(args: {
  deps: OrchestratorDeps;
  planContent: string;
  baseSha: string;
  headSha: string;
  fullDiff: string;
  landedTasks: Array<{ id: string; title: string; commitSha?: string }>;
  bundleMaterial?: string;
  corpusMaterial?: string;
}): string {
  return [
    `Plan: ${args.deps.planPath}`,
    `Run base: ${args.baseSha}`,
    `Post-task main HEAD: ${args.headSha}`,
    args.deps.runId ? `Run ID: ${args.deps.runId}` : "",
    "## Original Human Plan",
    args.planContent,
    args.bundleMaterial
      ? `## Referenced Plan Material\n\n${args.bundleMaterial}`
      : "",
    args.corpusMaterial ? `## Plan Corpus\n\n${args.corpusMaterial}` : "",
    formatExecutionManifestSummary(args.deps.executionManifest),
    args.landedTasks.length
      ? `## Landed Tasks\n\n${args.landedTasks.map((task) => `- ${task.id}: ${task.title}${task.commitSha ? ` @ ${task.commitSha.slice(0, 7)}` : ""}`).join("\n")}`
      : "",
    "## Full Feature Diff",
    `\`\`\`diff\n${args.fullDiff}\n\`\`\``,
  ]
    .filter(Boolean)
    .join("\n\n");
}

async function overallMaterial(deps: OrchestratorDeps): Promise<{
  bundleMaterial?: string;
  corpusMaterial?: string;
}> {
  return {
    bundleMaterial: deps.materialStore
      ? formatStoreBundleMaterial(deps.materialStore)
      : deps.manifest
        ? formatBundleMaterial(deps.manifest)
        : undefined,
    corpusMaterial: deps.materialStore
      ? formatStoreCorpusMaterial(deps.materialStore)
      : deps.corpusMaterial,
  };
}

function overallWorktreePlanArtifacts(
  worktreePath: string,
  mainRoot: string,
  planArtifacts: string[],
): string[] {
  return planArtifacts.map((artifact) =>
    isAbsolute(artifact)
      ? join(worktreePath, relative(mainRoot, artifact))
      : artifact,
  );
}

function persistOverallArtifact(
  paths: StatePaths | undefined,
  round: number,
  filename: string,
  content: string,
): void {
  if (!paths) {
    return;
  }
  const dir = join(
    paths.runDir,
    "overall-review",
    "rounds",
    String(Math.max(1, round)).padStart(3, "0"),
  );
  mkdirSync(dir, { recursive: true });
  const target = join(dir, filename);
  if (!existsSync(target)) {
    writeFileSync(target, content, "utf-8");
    return;
  }
  let ordinal = 2;
  let alternate = join(dir, filename.replace(/(\.[^.]+)?$/, `-${ordinal}$1`));
  while (existsSync(alternate)) {
    ordinal++;
    alternate = join(dir, filename.replace(/(\.[^.]+)?$/, `-${ordinal}$1`));
  }
  writeFileSync(alternate, content, "utf-8");
}

function persistOverallReviewState(
  deps: OrchestratorDeps,
  overall: OverallReviewState,
  status: OverallReviewJson["status"],
  lastReason?: string,
): void {
  if (!deps.paths) {
    return;
  }
  const run = readRunJson(deps.paths);
  if (!run) {
    return;
  }
  writeRunJson(deps.paths, {
    ...run,
    currentPhase: status,
    updatedAt: new Date().toISOString(),
    overallReview: {
      baseSha: overall.baseSha,
      branchName: overall.branchName,
      worktreePath: overall.worktreePath,
      candidate: overall.candidate,
      convergence: {
        epoch: overall.epoch,
        closedEpochs: overall.closedEpochs,
        state: overall.convergence,
        previousCandidate: overall.previousCandidate,
        previousCandidatePatch: overall.previousCandidatePatch,
        latestEvidence: overall.latestEvidence,
      },
      integrationLedger: overall.integrationLedger,
      status,
      implementationRound: overall.convergence.round,
      lastTransition: {
        at: new Date().toISOString(),
        phase: status,
        ...(lastReason ? { reason: lastReason } : {}),
      },
      lastReason,
    },
  });
}

async function restoreSnapshots(
  ...groups: Array<Array<readonly [GitClient, RestoreSnapshot, string[]]>>
): Promise<string[]> {
  const results = await Promise.all(
    groups.flat().map(async ([git, snapshot, protectedPaths]) => {
      try {
        await restoreAndVerify(git, snapshot, protectedPaths);
        return undefined;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    }),
  );
  return results.filter((result): result is string => result !== undefined);
}

async function runInitialOverallReview(args: {
  deps: OrchestratorDeps;
  planArtifacts: string[];
  planContext: string;
  candidate: string;
  fullDiff: string;
}): Promise<
  | { ok: true; convergence: ReviewConvergenceState }
  | { ok: false; reason: string; hardBlocked?: boolean }
> {
  const { deps, planArtifacts } = args;
  const snapshot = await captureRestoreSnapshot(deps.git, planArtifacts);
  const prompt = buildInitialOverallReviewPrompt({
    planContext: args.planContext,
    candidateContext: `Candidate identity: ${args.candidate}\n\n${args.fullDiff}`,
    worktreePath: await deps.git.root(),
  });
  persistOverallArtifact(deps.paths, 1, "reviewer-prompt.md", prompt);
  const id = await deps.subagents.spawn({
    type: deps.roles.reviewer.type,
    prompt,
    description: "overall review",
    model: deps.roles.reviewer.model,
    thinking: deps.roles.reviewer.thinking,
    role: "reviewer",
    cwd: await deps.git.root(),
    readOnly: true,
    completion: {
      description: "Submit the typed overall review.",
      schema: initialOverallReviewSchema,
    },
  });
  const ref: AgentDisplayRef = {
    id,
    role: "reviewer",
    label: "Reviewer · Overall review",
    startedAt: new Date().toISOString(),
  };
  deps.updateState((previous) => addActiveAgentPatch(previous, ref));
  const result = await deps.subagents.waitFor(id, deps.signal).finally(() => {
    deps.updateState((previous) => removeActiveAgentPatch(previous, id));
  });
  persistOverallArtifact(
    deps.paths,
    1,
    "reviewer-result.json",
    JSON.stringify({ result, runtime: result.runtime }, null, 2),
  );
  if (await snapshotChanged(deps.git, snapshot, planArtifacts)) {
    try {
      await restoreAndVerify(deps.git, snapshot, planArtifacts);
    } catch (error) {
      return {
        ok: false,
        hardBlocked: true,
        reason: `overall reviewer mutation could not be restored: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
  if (
    result.status === "stopped" ||
    deps.signal?.aborted ||
    deps.shouldStop()
  ) {
    throw new StoppedError();
  }
  if (result.status !== "completed") {
    return {
      ok: false,
      reason: `Overall reviewer ${result.status}: ${result.error}`,
    };
  }
  const parsed = parseInitialReviewResult(result.result, {
    allowRecommendationMarkdown: true,
  });
  if (!parsed.ok) {
    return {
      ok: false,
      reason: `Invalid initial overall review: ${parsed.reason}`,
    };
  }
  await recordPapercuts(deps, result.result, "overall-reviewer");
  return {
    ok: true,
    convergence: createReviewConvergenceState({
      drafts:
        parsed.result.verdict === "changes_requested"
          ? parsed.result.findings
          : [],
      idPrefix: "O",
    }),
  };
}

async function reviewOverallCandidate(args: {
  deps: OrchestratorDeps;
  planArtifacts: string[];
  state: OverallReviewState;
  planContext: string;
  latestDelta: string;
  latestDeltaPaths: string[];
  initial?: boolean;
}): Promise<
  | { ok: true; approved: boolean; observations: string[] }
  | { ok: false; reason: string; hardBlocked?: boolean }
> {
  const { deps, planArtifacts, state } = args;
  const mainRoot = await deps.git.root();
  const candidateGit = deps.git.forWorktree(state.worktreePath, mainRoot);
  const candidatePlanArtifacts = overallWorktreePlanArtifacts(
    state.worktreePath,
    mainRoot,
    planArtifacts,
  );
  const snapshot = await captureRestoreSnapshot(
    candidateGit,
    candidatePlanArtifacts,
  );
  const mainSnapshot = await captureRestoreSnapshot(deps.git, planArtifacts);
  const candidate = state.candidate.trustedCheckpoint!;
  const prompt = args.initial
    ? buildInitialOverallReviewPrompt({
        planContext: args.planContext,
        candidateContext: `Candidate identity: ${candidate}\n\n${args.latestDelta}`,
        worktreePath: state.worktreePath,
      })
    : buildAnchoredOverallReviewPrompt({
        planContext: args.planContext,
        candidateContext: `Candidate identity: ${candidate}`,
        outstandingFindings: state.convergence.findings.filter((finding) =>
          state.convergence.outstandingIds.includes(finding.id),
        ),
        previousCandidate: state.previousCandidate ?? state.baseSha,
        currentCandidate: candidate,
        latestDelta: args.latestDelta,
        worktreePath: state.worktreePath,
      });
  persistOverallArtifact(
    deps.paths,
    state.convergence.round + 1,
    "reviewer-prompt.md",
    prompt,
  );
  const id = await deps.subagents.spawn({
    type: deps.roles.reviewer.type,
    prompt,
    description: args.initial ? "overall review" : "anchored overall review",
    model: deps.roles.reviewer.model,
    thinking: deps.roles.reviewer.thinking,
    role: "reviewer",
    cwd: state.worktreePath,
    readOnly: true,
    completion: {
      description: "Submit the typed overall review.",
      schema: args.initial ? initialOverallReviewSchema : anchoredReviewSchema,
    },
  });
  const ref: AgentDisplayRef = {
    id,
    role: "reviewer",
    label: args.initial
      ? "Reviewer · Overall review"
      : "Reviewer · Overall re-review",
    startedAt: new Date().toISOString(),
  };
  deps.updateState((previous) => addActiveAgentPatch(previous, ref));
  const result = await deps.subagents.waitFor(id, deps.signal).finally(() => {
    deps.updateState((previous) => removeActiveAgentPatch(previous, id));
  });
  persistOverallArtifact(
    deps.paths,
    state.convergence.round + 1,
    "reviewer-result.json",
    JSON.stringify({ result, runtime: result.runtime }, null, 2),
  );
  const candidateChanged = await snapshotChanged(
    candidateGit,
    snapshot,
    candidatePlanArtifacts,
  );
  const mainChanged = await snapshotChanged(
    deps.git,
    mainSnapshot,
    planArtifacts,
  );
  if (candidateChanged || mainChanged) {
    const restoreFailures = await restoreSnapshots(
      candidateChanged
        ? [[candidateGit, snapshot, candidatePlanArtifacts] as const]
        : [],
      mainChanged ? [[deps.git, mainSnapshot, planArtifacts] as const] : [],
    );
    if (restoreFailures.length > 0) {
      return {
        ok: false,
        hardBlocked: true,
        reason: `overall reviewer mutation could not be restored: ${restoreFailures.join("; ")}`,
      };
    }
  }
  if (
    result.status === "stopped" ||
    deps.signal?.aborted ||
    deps.shouldStop()
  ) {
    throw new StoppedError();
  }
  if (result.status !== "completed") {
    return {
      ok: false,
      reason: `Overall reviewer ${result.status}: ${result.error}`,
    };
  }
  await recordPapercuts(deps, result.result, "overall-reviewer");
  if (args.initial) {
    const parsed = parseInitialReviewResult(result.result, {
      allowRecommendationMarkdown: true,
    });
    if (!parsed.ok) {
      return {
        ok: false,
        reason: `Invalid initial overall review: ${parsed.reason}`,
      };
    }
    state.convergence = createReviewConvergenceState({
      drafts:
        parsed.result.verdict === "changes_requested"
          ? parsed.result.findings
          : [],
      idPrefix: "O",
    });
    return {
      ok: true,
      approved: state.convergence.outstandingIds.length === 0,
      observations: [],
    };
  }
  const parsed = parseAnchoredReviewResult(
    result.result,
    state.convergence.outstandingIds,
  );
  if (!parsed.ok) {
    return {
      ok: false,
      reason: `Invalid anchored overall review: ${parsed.reason}`,
    };
  }
  try {
    const update =
      state.convergence.outstandingIds.length === 0
        ? openRegressionReviewEpoch({
            closedState: state.convergence,
            regressions: parsed.result.regressions,
            latestDeltaPaths: args.latestDeltaPaths,
            idPrefix: "O",
          })
        : applyAnchoredReview({
            state: state.convergence,
            review: parsed.result,
            latestDeltaPaths: args.latestDeltaPaths,
            idPrefix: "O",
          });
    const wasClosed = state.convergence.outstandingIds.length === 0;
    state.convergence = update.state;
    if (wasClosed) {
      state.epoch++;
    }
    return {
      ok: true,
      approved: state.convergence.outstandingIds.length === 0,
      observations: update.observations.map(
        (item) => `${item.summary}: ${item.evidence}`,
      ),
    };
  } catch (error) {
    return {
      ok: false,
      reason: `Overall review protocol failure: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

async function retryOverallReview<
  T extends { ok: boolean; reason?: string; hardBlocked?: boolean },
>(review: () => Promise<T>): Promise<T> {
  let result = await review();
  for (
    let failures = 1;
    !result.ok && !result.hardBlocked && failures < MAX_SYSTEM_FAILURES;
    failures++
  ) {
    result = await review();
  }
  return result;
}

async function runConvergentOverallReviewLoop(
  deps: OrchestratorDeps,
  plan: ReturnType<typeof parsePlanFile>,
  planArtifacts: string[],
  runBaseSha: string,
): Promise<void> {
  throwIfStopped(deps);
  if (!(await deps.git.isCleanExcept(planArtifacts))) {
    throw new BlockedError("dirty worktree before final review");
  }
  const mainHead = await deps.git.head();
  const retainedOverall = deps.paths
    ? readRunJson(deps.paths)?.overallReview
    : undefined;
  if (mainHead === runBaseSha && !retainedOverall) {
    return;
  }
  const planContent = readFileSync(deps.planPath, "utf-8");
  const { bundleMaterial, corpusMaterial } = await overallMaterial(deps);
  const landedTasks = deps.paths ? getLandedTasks(deps.paths) : [];
  const fullDiff = await deps.git.diffRange(runBaseSha, mainHead);
  const planContext = overallPlanContext({
    deps,
    planContent,
    baseSha: runBaseSha,
    headSha: mainHead,
    fullDiff,
    landedTasks,
    bundleMaterial,
    corpusMaterial,
  });

  const retained = retainedOverall;
  const mainRoot = await deps.git.root();
  let overall: OverallReviewState;
  let candidateGit: GitClient;
  let candidatePlanArtifacts: string[];
  if (retained?.candidate && retained.convergence) {
    if (
      !retained.candidate.trustedCheckpoint ||
      !retained.candidate.worktreePath
    ) {
      throw new BlockedError("retained overall candidate is incomplete");
    }
    const worktreePath = retained.worktreePath;
    candidateGit = deps.git.forWorktree(worktreePath, mainRoot);
    candidatePlanArtifacts = overallWorktreePlanArtifacts(
      worktreePath,
      mainRoot,
      planArtifacts,
    );
    if (
      (await candidateGit.head()) !== retained.candidate.trustedCheckpoint ||
      (retained.candidate.candidateTree &&
        (await candidateGit.tree()) !== retained.candidate.candidateTree) ||
      !(await candidateGit.isCleanExcept(candidatePlanArtifacts)) ||
      (await candidateGit.activeOperation())
    ) {
      throw new BlockedError(
        "retained overall candidate no longer matches its trusted checkpoint",
      );
    }
    overall = {
      baseSha: retained.baseSha,
      branchName: retained.branchName,
      worktreePath,
      candidate: retained.candidate,
      convergence: retained.convergence.state as ReviewConvergenceState,
      closedEpochs: retained.convergence.closedEpochs as Array<{
        epoch: number;
        findings: ReviewFinding[];
      }>,
      epoch: retained.convergence.epoch,
      previousCandidate: retained.convergence.previousCandidate,
      previousCandidatePatch: retained.convergence.previousCandidatePatch,
      latestEvidence: retained.convergence.latestEvidence,
      integrationLedger: retained.integrationLedger,
    };
  } else {
    deps.updateState({ phase: "final_review", activeSubagentId: undefined });
    const initial = await retryOverallReview(() =>
      runInitialOverallReview({
        deps,
        planArtifacts,
        planContext,
        candidate: mainHead,
        fullDiff,
      }),
    );
    if (!initial.ok) {
      throw new BlockedError(initial.reason);
    }
    if (initial.convergence.outstandingIds.length === 0) {
      deps.updateState((previous) =>
        checkpointPatch(previous, "Final overall review approved"),
      );
      if (deps.paths) {
        appendEvent(deps.paths, { type: "overall_review_approved" });
      }
      return;
    }
    const branchName = `pi-implement/${deps.runId ?? "overall"}/overall-review`;
    const worktreePath = deps.paths
      ? join(deps.paths.worktreesDir, "overall-review")
      : join(await deps.git.root(), ".pi", "implement", "overall-review");
    await deps.git.createTaskBranch(branchName, mainHead);
    try {
      await deps.git.addWorktree(worktreePath, branchName);
    } catch (error) {
      await deps.git.deleteTaskBranch(branchName).catch(() => undefined);
      throw new BlockedError(
        `Overall review worktree setup failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    candidateGit = deps.git.forWorktree(worktreePath, mainRoot);
    candidatePlanArtifacts = overallWorktreePlanArtifacts(
      worktreePath,
      mainRoot,
      planArtifacts,
    );
    overall = {
      baseSha: mainHead,
      branchName,
      worktreePath,
      candidate: {
        sourceBaseSha: runBaseSha,
        candidateBaseSha: mainHead,
        branchName,
        worktreePath,
        candidateSha: mainHead,
        candidateTree: await candidateGit.tree(),
        trustedCheckpoint: mainHead,
        discardedBundles: [],
      },
      convergence: initial.convergence,
      closedEpochs: [],
      epoch: 1,
    };
    persistOverallReviewState(deps, overall, "needs_rework");
    if (deps.paths) {
      appendEvent(deps.paths, {
        type: "overall_review_changes_requested",
        findingIds: overall.convergence.outstandingIds,
      });
    }
  }

  const worktreePath = overall.worktreePath;
  const branchName = overall.branchName;
  let attempt = overall.convergence.round;
  let systemFailures = 0;
  for (;;) {
    attempt++;
    const outstanding = overall.convergence.findings.filter((finding) =>
      overall.convergence.outstandingIds.includes(finding.id),
    );
    const candidateBefore = overall.candidate.trustedCheckpoint!;
    const snapshot = await captureRestoreSnapshot(
      candidateGit,
      candidatePlanArtifacts,
    );
    const mainSnapshot = await captureRestoreSnapshot(deps.git, planArtifacts);
    const candidateDiff = await candidateGit.diffRange(
      overall.baseSha,
      candidateBefore,
    );
    const prompt = buildOverallReworkPrompt({
      planContent,
      planPath: deps.planPath,
      baseSha: runBaseSha,
      headSha: candidateBefore,
      diff: `${fullDiff}\n${candidateDiff}`,
      runId: deps.runId,
      landedTasks,
      bundleMaterial,
      corpusMaterial,
      findings: outstanding,
      worktreePath,
      priorAttemptFailures: overall.latestEvidence
        ? [overall.latestEvidence]
        : undefined,
      executionManifest: deps.executionManifest,
    });
    deps.updateState({ phase: "final_rework", activeSubagentId: undefined });
    persistOverallArtifact(
      deps.paths,
      attempt,
      "implementer-prompt.md",
      prompt,
    );
    const id = await deps.subagents.spawn({
      type: deps.roles.implementer.type,
      prompt,
      description: `overall rework attempt ${attempt}`,
      model: deps.roles.implementer.model,
      thinking: deps.roles.implementer.thinking,
      role: "implementer",
      cwd: worktreePath,
      completion: {
        description: "Submit the overall rework result.",
        schema: overallReworkSchema,
      },
    });
    const ref: AgentDisplayRef = {
      id,
      role: "implementer",
      label: `Overall rework · attempt ${attempt}`,
      startedAt: new Date().toISOString(),
    };
    deps.updateState((previous) => addActiveAgentPatch(previous, ref));
    const result = await deps.subagents.waitFor(id, deps.signal).finally(() => {
      deps.updateState((previous) => removeActiveAgentPatch(previous, id));
    });
    persistOverallArtifact(
      deps.paths,
      attempt,
      "implementer-result.json",
      JSON.stringify({ result, runtime: result.runtime }, null, 2),
    );
    const parsedRework =
      result.status === "completed"
        ? parseOverallReworkResult(result.result)
        : undefined;
    if (result.status !== "completed" || !parsedRework?.ok) {
      const reason =
        result.status === "completed"
          ? `Invalid overall rework result: ${(parsedRework as { reason: string }).reason}`
          : `Overall rework ${result.status}: ${result.error}`;
      const bundle = await persistDiscardedBundle({
        git: candidateGit,
        destination: join(
          deps.paths?.runDir ?? dirname(worktreePath),
          "overall-review",
          "discarded",
          `${Date.now()}-${attempt}`,
        ),
        protectedPaths: candidatePlanArtifacts,
        baseSha: candidateBefore,
      });
      overall.candidate.discardedBundles.push(bundle);
      if (deps.paths) {
        appendEvent(deps.paths, {
          type: "overall_candidate_quarantined",
          bundlePath: bundle,
        });
      }
      const restoreFailures = await restoreSnapshots(
        [[candidateGit, snapshot, candidatePlanArtifacts]],
        [[deps.git, mainSnapshot, planArtifacts]],
      );
      if (restoreFailures.length > 0) {
        throw new BlockedError(
          `overall rework restoration failed: ${restoreFailures.join("; ")}`,
        );
      }
      overall.latestEvidence = reason;
      persistOverallReviewState(deps, overall, "needs_rework", reason);
      if (++systemFailures >= MAX_SYSTEM_FAILURES) {
        throw new BlockedError(reason);
      }
      continue;
    }
    if (
      protectedArtifactsChanged(snapshot) ||
      (await candidateGit.head()) !== snapshot.head ||
      (await snapshotChanged(deps.git, mainSnapshot, planArtifacts))
    ) {
      const restoreFailures = await restoreSnapshots(
        [[candidateGit, snapshot, candidatePlanArtifacts]],
        [[deps.git, mainSnapshot, planArtifacts]],
      );
      throw new BlockedError(
        restoreFailures.length > 0
          ? `overall rework implementer violated the candidate safety boundary and rollback failed: ${restoreFailures.join("; ")}`
          : "overall rework implementer violated the candidate safety boundary",
      );
    }
    await recordPapercuts(deps, parsedRework, "overall-rework");
    await candidateGit.stageAllExcept(candidatePlanArtifacts);
    const checkpoint = await checkpointCandidate(
      candidateGit,
      overall.candidate,
    );
    if (checkpoint.result && checkpoint.result.exitCode !== 0) {
      throw new BlockedError(
        `could not checkpoint overall candidate: ${checkpoint.result.stderr || checkpoint.result.stdout}`,
      );
    }
    overall.candidate = checkpoint.candidate;
    persistOverallArtifact(
      deps.paths,
      attempt,
      "candidate.json",
      JSON.stringify(overall.candidate, null, 2),
    );
    persistOverallArtifact(
      deps.paths,
      attempt,
      "candidate.diff.patch",
      await candidateGit.diffRange(
        overall.baseSha,
        overall.candidate.trustedCheckpoint!,
      ),
    );
    persistOverallReviewState(deps, overall, "reviewing");
    if (deps.paths && checkpoint.changed) {
      appendEvent(deps.paths, {
        type: "overall_candidate_checkpointed",
        commitSha: overall.candidate.trustedCheckpoint!,
        amended: candidateBefore !== overall.baseSha,
      });
    }
    const candidateAfter = overall.candidate.trustedCheckpoint!;
    if (!checkpoint.changed || candidateAfter === candidateBefore) {
      const update = applyNoopReview(overall.convergence);
      overall.convergence = update.state;
      overall.latestEvidence = `Overall reworker did not change candidate ${candidateBefore}.`;
      const integrationNoop = overall.integrationLedger
        ? completeIntegrationRound(overall.integrationLedger)
        : undefined;
      if (integrationNoop) {
        overall.integrationLedger = integrationNoop.ledger;
      }
      const stalled =
        update.outcome === "stalled" || integrationNoop?.outcome === "stalled";
      persistOverallReviewState(
        deps,
        overall,
        stalled ? "stalled" : "needs_rework",
        overall.latestEvidence,
      );
      if (stalled) {
        break;
      }
      continue;
    }
    const validationSnapshot = await captureRestoreSnapshot(
      candidateGit,
      candidatePlanArtifacts,
    );
    let validationFailure: string | undefined;
    for (const command of await resolveValidationCommands(deps)) {
      const validation = await runValidationCommand(command, worktreePath);
      if (validation.exitCode !== 0) {
        validationFailure = `Validation failed: ${command.display}\n${validation.stderr || validation.stdout}`;
        break;
      }
    }
    if (
      (await snapshotChanged(
        candidateGit,
        validationSnapshot,
        candidatePlanArtifacts,
      )) ||
      (await snapshotChanged(deps.git, mainSnapshot, planArtifacts))
    ) {
      const restoreFailures = await restoreSnapshots(
        [[candidateGit, validationSnapshot, candidatePlanArtifacts]],
        [[deps.git, mainSnapshot, planArtifacts]],
      );
      if (restoreFailures.length > 0) {
        throw new BlockedError(
          `overall validation mutation could not be restored: ${restoreFailures.join("; ")}`,
        );
      }
      throw new BlockedError("validation changed the overall candidate");
    }
    if (validationFailure) {
      persistOverallArtifact(
        deps.paths,
        attempt,
        "validation.txt",
        validationFailure,
      );
      overall.latestEvidence = validationFailure;
      persistOverallReviewState(
        deps,
        overall,
        "needs_rework",
        validationFailure,
      );
    }
    const reviewBase = overall.previousCandidate ?? overall.baseSha;
    const latestDelta = await candidateGit.diffRange(
      reviewBase,
      candidateAfter,
    );
    const latestDeltaPaths = parseNameStatusPaths(
      await candidateGit.diffRangeNameStatus(reviewBase, candidateAfter),
    );
    const review = await retryOverallReview(() =>
      reviewOverallCandidate({
        deps,
        planArtifacts,
        state: overall,
        planContext,
        latestDelta,
        latestDeltaPaths,
      }),
    );
    if (!review.ok) {
      throw new BlockedError(review.reason);
    }
    persistOverallArtifact(
      deps.paths,
      attempt,
      "finding-transition.json",
      JSON.stringify(
        {
          outstandingIds: overall.convergence.outstandingIds,
          bestOutstandingCount: overall.convergence.bestOutstandingCount,
          consecutiveStalledRounds:
            overall.convergence.consecutiveStalledRounds,
        },
        null,
        2,
      ),
    );
    overall.previousCandidate = candidateAfter;
    overall.previousCandidatePatch = await candidateGit.diffRange(
      overall.baseSha,
      candidateAfter,
    );
    overall.latestEvidence =
      [validationFailure, ...review.observations].filter(Boolean).join("\n") ||
      undefined;
    if (!review.approved || validationFailure) {
      if (overall.convergence.consecutiveStalledRounds >= 2) {
        break;
      }
      persistOverallReviewState(
        deps,
        overall,
        "needs_rework",
        overall.latestEvidence,
      );
      continue;
    }
    overall.closedEpochs.push({
      epoch: overall.epoch,
      findings: overall.convergence.findings,
    });
    const integrated = await integrateOverallCandidate(
      deps,
      planArtifacts,
      overall,
    );
    if (integrated.ok) {
      await deps.git.removeWorktree(worktreePath).catch(() => undefined);
      await deps.git.deleteTaskBranch(branchName).catch(() => undefined);
      deps.updateState((previous) =>
        checkpointPatch(previous, "Final overall review approved"),
      );
      if (deps.paths) {
        appendEvent(deps.paths, { type: "overall_review_approved" });
      }
      return;
    }
    overall.latestEvidence = integrated.reason;
    persistOverallReviewState(
      deps,
      overall,
      integrated.stalled || integrated.hardBlocked ? "blocked" : "needs_rework",
      integrated.reason,
    );
    if (integrated.hardBlocked) {
      throw new BlockedError(integrated.reason);
    }
    if (integrated.stalled) {
      break;
    }
  }
  persistOverallReviewState(
    deps,
    overall,
    "stalled",
    "overall review stalled without a new low outstanding count",
  );
  if (deps.paths) {
    appendEvent(deps.paths, {
      type: "overall_review_stalled",
      findingIds: overall.convergence.outstandingIds,
    });
  }
  const artifactPath = deps.paths
    ? join(deps.paths.runDir, "overall-review", "stall.md")
    : nextOverallReviewArtifactPath(deps.planPath);
  mkdirSync(dirname(artifactPath), { recursive: true });
  writeFileSync(
    artifactPath,
    `# Overall review stalled\n\nInspect retained run state: ${deps.paths?.runDir ?? "(unmanaged)"}\n\nOutstanding findings: ${overall.convergence.outstandingIds.join(", ")}\n`,
    "utf-8",
  );
  throw new OverallReviewFollowupError(
    artifactPath,
    `Overall review stalled: ${overall.convergence.outstandingIds.join(", ")}`,
  );
}

async function integrateOverallCandidate(
  deps: OrchestratorDeps,
  planArtifacts: string[],
  overall: OverallReviewState,
): Promise<
  | { ok: true }
  | { ok: false; reason: string; stalled?: boolean; hardBlocked?: boolean }
> {
  const mainRoot = await deps.git.root();
  const candidateGit = deps.git.forWorktree(overall.worktreePath, mainRoot);
  const candidatePlanArtifacts = overallWorktreePlanArtifacts(
    overall.worktreePath,
    mainRoot,
    planArtifacts,
  );
  const candidateSha = overall.candidate.trustedCheckpoint!;
  const candidateDelta = await candidateGit.diffRange(
    overall.baseSha,
    candidateSha,
  );
  const gates: IntegrationGate[] = [
    { key: "apply", kind: "apply", label: "Apply overall candidate delta" },
    ...(await resolveValidationCommands(deps)).map((command, index) => ({
      key: `validator:${index}`,
      kind: "validator" as const,
      label: `Validator: ${command.display}`,
    })),
    { key: "hook", kind: "hook", label: "Approval hook" },
    ...((await resolveValidationCommands(deps)).length === 0
      ? [
          {
            key: "fallback",
            kind: "fallback" as const,
            label: "Typed overall review approval",
          },
        ]
      : []),
  ];
  const mainBase = await deps.git.head();
  if (
    mainBase !== overall.baseSha ||
    !(await deps.git.isCleanExcept(planArtifacts))
  ) {
    return {
      ok: false,
      reason: "main checkout changed before overall integration",
    };
  }
  if (!sameIntegrationPipeline(overall.integrationLedger, mainBase, gates)) {
    overall.integrationLedger = createIntegrationLedger({
      epoch: (overall.integrationLedger?.epoch ?? 0) + 1,
      mainBaseSha: mainBase,
      gates,
      idPrefix: "OI",
    });
  }
  const snapshot = await captureRestoreSnapshot(deps.git, planArtifacts);
  persistOverallReviewState(deps, overall, "integrating");
  const fail = async (key: string, reason: string) => {
    const update = reassessIntegrationGate({
      ledger: overall.integrationLedger!,
      key,
      passed: false,
      evidence: reason,
    });
    const completed = completeIntegrationRound(update.ledger);
    overall.integrationLedger = completed.ledger;
    persistOverallReviewState(
      deps,
      overall,
      completed.outcome === "stalled" ? "stalled" : "needs_rework",
      reason,
    );
    try {
      await restoreAndVerify(deps.git, snapshot, planArtifacts);
    } catch (error) {
      return {
        ok: false as const,
        hardBlocked: true,
        reason: `${reason}\nRollback failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    return {
      ok: false as const,
      reason:
        completed.outcome === "stalled"
          ? `${reason}\nOverall integration stalled without a new low outstanding count.`
          : reason,
      stalled: completed.outcome === "stalled",
    };
  };
  const apply = await deps.git.applyPatch(candidateDelta);
  if (apply.exitCode !== 0) {
    return fail(
      "apply",
      apply.stderr || apply.stdout || "could not apply overall candidate",
    );
  }
  overall.integrationLedger = reassessIntegrationGate({
    ledger: overall.integrationLedger!,
    key: "apply",
    passed: true,
    evidence: "Overall candidate delta applied.",
  }).ledger;
  persistOverallReviewState(deps, overall, "integrating");
  const appliedSnapshot = await captureRestoreSnapshot(deps.git, planArtifacts);
  const validationCommands = await resolveValidationCommands(deps);
  for (let index = 0; index < validationCommands.length; index++) {
    const command = validationCommands[index]!;
    const result = await runValidationCommand(command, await deps.git.root());
    if (await snapshotChanged(deps.git, appliedSnapshot, planArtifacts)) {
      return fail(
        `validator:${index}`,
        `Validator changed the integration candidate: ${command.display}`,
      );
    }
    if (result.exitCode !== 0) {
      return fail(
        `validator:${index}`,
        result.stderr ||
          result.stdout ||
          `Validation failed: ${command.display}`,
      );
    }
    overall.integrationLedger = reassessIntegrationGate({
      ledger: overall.integrationLedger!,
      key: `validator:${index}`,
      passed: true,
      evidence: "Validator passed.",
    }).ledger;
  }
  if (validationCommands.length === 0) {
    overall.integrationLedger = reassessIntegrationGate({
      ledger: overall.integrationLedger!,
      key: "fallback",
      passed: true,
      evidence: "Typed overall review approved the candidate.",
    }).ledger;
  }
  const beforeHook = await captureRestoreSnapshot(
    candidateGit,
    candidatePlanArtifacts,
  );
  const approvedTree = await candidateGit.treeAt(candidateSha);
  const hook = await candidateGit.runCheckpointHooks(candidateSha);
  const hookTree = await candidateGit.tree();
  const hookMutated = await snapshotChanged(
    candidateGit,
    beforeHook,
    candidatePlanArtifacts,
    { ignoreHead: true },
  );
  try {
    await restoreAndVerify(candidateGit, beforeHook, candidatePlanArtifacts);
  } catch (error) {
    const rollback = await restoreSnapshots(
      [[candidateGit, beforeHook, candidatePlanArtifacts]],
      [[deps.git, snapshot, planArtifacts]],
    );
    return {
      ok: false,
      hardBlocked: true,
      reason: `Approval hook state could not be restored: ${error instanceof Error ? error.message : String(error)}${rollback.length > 0 ? `; main rollback also failed: ${rollback.join("; ")}` : ""}`,
    };
  }
  if (hookMutated || hookTree !== approvedTree) {
    return fail(
      "hook",
      "Approval hook changed the reviewed overall candidate.",
    );
  }
  if (hook.exitCode !== 0) {
    return fail("hook", hook.stderr || hook.stdout || "Approval hook failed");
  }
  const commit = await deps.git.commit("fix: address overall review");
  if (commit.exitCode !== 0) {
    return fail(
      "hook",
      commit.stderr || commit.stdout || "Overall integration commit failed",
    );
  }
  overall.integrationLedger = reassessIntegrationGate({
    ledger: overall.integrationLedger!,
    key: "hook",
    passed: true,
    evidence: "Approval hook passed.",
  }).ledger;
  const landedHead = await deps.git.head();
  if (
    landedHead === mainBase ||
    (await deps.git.treeAt(landedHead)) !== approvedTree ||
    !(await deps.git.isCleanExcept(planArtifacts)) ||
    (await deps.git.activeOperation())
  ) {
    return fail(
      "hook",
      "Overall integration did not leave an exact clean commit.",
    );
  }
  persistOverallReviewState(deps, overall, "approved");
  if (overall.integrationLedger.outstandingIds.length > 0) {
    return fail("hook", "Overall integration ledger remains outstanding.");
  }
  return { ok: true };
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
      candidateSha: taskMeta?.candidateSha ?? task.candidateSha,
      lastTransition: taskMeta?.lastTransition,
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
    sourceBaseSha: task.sourceBaseSha,
    baseSha: task.baseSha,
    candidateBaseSha: task.candidateBaseSha,
    candidateSha: task.candidateSha,
    candidateTree: task.candidateTree,
    trustedCheckpoint: task.trustedCheckpoint,
    discardedBundles: task.discardedBundles,
    worktreePath: task.worktreePath,
    branchName: task.branchName,
    taskCommitSha: task.taskCommitSha,
    landedCommitSha: task.landedCommitSha,
    activeSubagentIds: task.activeAgentIds,
    lastReason: task.lastReason,
    commitMessage: task.approvedCommitMessage,
    selfHealAttempts: task.selfHealAttempts,
    integrationLedger: task.integrationLedger,
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
    candidateBaseSha: task.candidateBaseSha ?? existing?.candidateBaseSha,
    candidateSha: task.candidateSha ?? existing?.candidateSha,
    candidateTree: task.candidateTree ?? existing?.candidateTree,
    trustedCheckpoint: task.trustedCheckpoint ?? existing?.trustedCheckpoint,
    discardedBundles: task.discardedBundles ?? existing?.discardedBundles,
    attempts: existing?.attempts ?? 0,
    review: existing?.review,
    implementationRound: existing?.implementationRound,
    lastTransition: existing?.lastTransition,
    runtimeHealth: existing?.runtimeHealth,
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
}): Promise<"changed" | "satisfied" | false> {
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
    initialFeedback,
  } = args;

  let feedback: RetryFeedback | undefined = initialFeedback;
  let priorSummary: string | undefined;
  let attempt =
    (readTaskJson(deps.paths!, taskId)?.implementationRound ??
      readTaskJson(deps.paths!, taskId)?.attempts ??
      0) + 1;
  let systemFailures = 0;
  let convergence = currentTaskReviewMetadata(deps.paths, taskId)?.convergence;
  let reviewState = convergence?.state as ReviewConvergenceState | undefined;
  let reviewEpoch = convergence?.epoch ?? 1;
  let closedEpochs = convergence?.closedEpochs ?? [];
  let previousCandidate = convergence?.previousCandidate;
  let previousCandidatePatch = convergence?.previousCandidatePatch;
  let latestEvidence = convergence?.latestEvidence;
  let verificationFailures = convergence?.verificationFailures ?? [];
  let candidate: CandidateMetadata = {
    sourceBaseSha: schedulerTask?.sourceBaseSha ?? baseSha,
    candidateBaseSha: schedulerTask?.candidateBaseSha ?? baseSha,
    branchName,
    worktreePath,
    candidateSha: schedulerTask?.candidateSha,
    candidateTree: schedulerTask?.candidateTree,
    trustedCheckpoint: schedulerTask?.trustedCheckpoint,
    discardedBundles: schedulerTask?.discardedBundles ?? [],
  };
  const persistReview = (
    lastDecision: "reviewed" | "required" = "required",
  ) => ({
    lastDecision,
    reviewedCount:
      lastDecision === "reviewed"
        ? (currentTaskReviewMetadata(deps.paths, taskId)?.reviewedCount ?? 0) +
          1
        : currentTaskReviewMetadata(deps.paths, taskId)?.reviewedCount,
    convergence: reviewState
      ? {
          epoch: reviewEpoch,
          closedEpochs,
          state: reviewState,
          previousCandidate,
          previousCandidatePatch,
          latestEvidence,
          verificationFailures,
        }
      : undefined,
  });
  const persistCandidate = (status: TaskJson["status"], reason?: string) => {
    if (schedulerTask) {
      Object.assign(schedulerTask, candidate);
    }
    if (deps.paths) {
      const existing = readTaskJson(deps.paths, taskId);
      writeTaskJson(deps.paths, taskId, {
        id: taskId,
        planIndex: task.index - 1,
        title: task.text,
        status,
        dependsOn: [],
        attempts: attempt,
        integrationAttempts: schedulerTask?.integrationAttempts ?? 0,
        sourceBaseSha: candidate.sourceBaseSha,
        baseSha: candidate.candidateBaseSha,
        candidateBaseSha: candidate.candidateBaseSha,
        candidateSha: candidate.candidateSha,
        candidateTree: candidate.candidateTree,
        trustedCheckpoint: candidate.trustedCheckpoint,
        discardedBundles: candidate.discardedBundles,
        worktreePath,
        branchName,
        activeSubagentIds: [],
        lastReason: reason,
        implementationRound: attempt,
        lastTransition: {
          at: new Date().toISOString(),
          phase: status,
          ...(reason ? { reason } : {}),
        },
        review: reviewState ? persistReview() : existing?.review,
      });
      if (reviewState) {
        persistTaskArtifact(
          deps.paths,
          taskId,
          "finding-transition.json",
          JSON.stringify(
            {
              epoch: reviewEpoch,
              outstandingIds: reviewState.outstandingIds,
              bestOutstandingCount: reviewState.bestOutstandingCount,
              consecutiveStalledRounds: reviewState.consecutiveStalledRounds,
              latestEvidence,
            },
            null,
            2,
          ),
        );
      }
    }
  };
  let trustedSnapshot: RestoreSnapshot | undefined;
  const quarantineAndRestore = async (reason: string) => {
    if (!worktreePath) {
      return;
    }
    const trusted = candidate.trustedCheckpoint ?? candidate.candidateBaseSha;
    const bundlePath = join(
      deps.paths!.tasksDir,
      taskId,
      "discarded",
      `${Date.now()}-${attempt}`,
    );
    const bundle = await persistDiscardedBundle({
      git: taskGit,
      destination: bundlePath,
      protectedPaths: planArtifacts,
      baseSha: trusted,
    });
    candidate = {
      ...candidate,
      discardedBundles: [...candidate.discardedBundles, bundle],
    };
    persistCandidate("needs_rework", reason);
    appendEvent(deps.paths!, {
      type: "candidate_quarantined",
      taskId,
      bundlePath: bundle,
    });
    const snapshot = trustedSnapshot ?? {
      ...(await captureRestoreSnapshot(taskGit, planArtifacts)),
      head: trusted,
      stagedPatch: "",
      workingPatch: "",
      untrackedArtifacts: new Map(),
    };
    await restoreAndVerify(taskGit, snapshot, planArtifacts);
  };
  workerLoop: for (;;) {
    throwIfStopped(deps);
    const taskHeadBefore = worktreePath
      ? await taskGit.head()
      : await deps.git.head();
    trustedSnapshot = worktreePath
      ? await captureRestoreSnapshot(taskGit, planArtifacts)
      : undefined;
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
      writeTaskJson(deps.paths, taskId, {
        ...(readTaskJson(deps.paths, taskId) ?? {
          id: taskId,
          planIndex: task.index - 1,
          title: task.text,
          status: "coding" as const,
          dependsOn: [],
          attempts: attempt,
          integrationAttempts: schedulerTask?.integrationAttempts ?? 0,
        }),
        implementationRound: attempt,
        lastTransition: {
          at: new Date().toISOString(),
          phase: "coding",
          ...(feedback ? { reason: formatFeedback(feedback) } : {}),
        },
      });
      persistTaskArtifact(
        deps.paths,
        taskId,
        "implementer-prompt.md",
        implementerPrompt,
      );
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
      completion: {
        description: "Submit the implementation result.",
        schema: implementerResultSchema,
      },
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
        integrationAttempts: schedulerTask?.integrationAttempts ?? 0,
        baseSha: candidate.candidateBaseSha,
        candidateBaseSha: candidate.candidateBaseSha,
        candidateSha: candidate.candidateSha,
        candidateTree: candidate.candidateTree,
        trustedCheckpoint: candidate.trustedCheckpoint,
        discardedBundles: candidate.discardedBundles,
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
    if (deps.paths && implementation.runtime) {
      const existing = readTaskJson(deps.paths, taskId);
      if (existing) {
        writeTaskJson(deps.paths, taskId, {
          ...existing,
          runtimeHealth: {
            status: implementation.runtime.status,
            model: implementation.runtime.model,
            thinking: implementation.runtime.thinking,
            toolUses: implementation.runtime.toolUses,
            tokensTotal: implementation.runtime.tokensTotal,
            compactionCount: implementation.runtime.compactionCount,
          },
        });
      }
    }

    if (
      implementation.status === "stopped" ||
      deps.shouldStop() ||
      deps.signal?.aborted
    ) {
      await quarantineAndRestore("implementer stopped before completion");
      throw new StoppedError();
    }
    throwIfStopped(deps);

    if (implementation.status === "failed") {
      await quarantineAndRestore(
        "implementer provider failure before completion",
      );
      if (deps.paths) {
        writeTaskJson(deps.paths, taskId, {
          id: taskId,
          planIndex: task.index - 1,
          title: task.text,
          status: "failed",
          dependsOn: [],
          attempts: attempt,
          integrationAttempts: schedulerTask?.integrationAttempts ?? 0,
          baseSha: candidate.candidateBaseSha,
          candidateBaseSha: candidate.candidateBaseSha,
          candidateSha: candidate.candidateSha,
          candidateTree: candidate.candidateTree,
          trustedCheckpoint: candidate.trustedCheckpoint,
          discardedBundles: candidate.discardedBundles,
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
      attempt++;
      continue;
    }

    if (deps.paths) {
      persistTaskArtifact(
        deps.paths,
        taskId,
        "implementer-result.json",
        JSON.stringify(
          { result: implementation.result, runtime: implementation.runtime },
          null,
          2,
        ),
      );
      writeTaskJson(deps.paths, taskId, {
        id: taskId,
        planIndex: task.index - 1,
        title: task.text,
        status: "reviewing",
        dependsOn: [],
        attempts: attempt,
        integrationAttempts: schedulerTask?.integrationAttempts ?? 0,
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
    const protectedArtifactChanged =
      worktreePath && trustedSnapshot
        ? protectedArtifactsChanged(trustedSnapshot)
        : false;
    if (changedPlanArtifact || protectedArtifactChanged) {
      const artifact = changedPlanArtifact ?? "protected artifact state";
      await quarantineAndRestore(
        `implementer changed a plan artifact: ${artifact}`,
      );
      throw new BlockedError(
        `implementer changed a plan artifact: ${artifact}`,
      );
    }
    if (worktreePath && (await taskGit.head()) !== taskHeadBefore) {
      await quarantineAndRestore("implementer changed task worktree HEAD");
      throw new BlockedError("implementer changed task worktree HEAD");
    }

    let parsed = parseImplementerResult(implementation.result);
    if (!parsed.ok) {
      await quarantineAndRestore("implementer returned an invalid completion");
    }
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
      attempt++;
      continue;
    }
    priorSummary = parsed.result.summary;
    verificationFailures = parsed.result.verification
      .filter((step) => verificationFailed(step.result))
      .map(
        (step) =>
          `${step.command}: ${step.result}${step.rationale ? ` (${step.rationale})` : ""}`,
      );
    await recordPapercuts(deps, implementation.result, "implementer", taskId);

    await taskGit.stageAllExcept(planArtifacts);
    const hasImplementationDelta = await taskGit.hasStagedChanges();
    const hasStaged =
      hasImplementationDelta ||
      (Boolean(worktreePath && candidate.trustedCheckpoint) &&
        (await taskGit.head()) === candidate.trustedCheckpoint);

    // The implementer claimed the task was already satisfied but left staged
    // changes. The diff is the ground truth, so treat this as a `changed`
    // candidate and let the reviewer judge whether to commit it or send it
    // back for rework rather than silently dropping or blindly landing it.
    let alreadySatisfiedDiscrepancy = false;
    if (
      hasImplementationDelta &&
      parsed.result.outcome === "already_satisfied"
    ) {
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
    let reviewerPrompt: string;
    let candidateIdentity: string;
    let latestDeltaPaths: string[] = [];
    let latestDelta = "(no candidate delta)";
    let semanticNoop = false;

    if (hasStaged) {
      fingerprintBefore = await taskGit.stagedFingerprint();
      candidatePatch = await taskGit.stagedDiff();
      if (reviewState && previousCandidatePatch !== undefined) {
        const delta = await taskGit.stagedDeltaFromPatch(
          previousCandidatePatch,
        );
        latestDeltaPaths = parseNameStatusPaths(delta.nameStatus);
        latestDelta = delta.diff;
      } else {
        latestDeltaPaths = parseNameStatusPaths(
          await taskGit.stagedNameStatus(),
        );
        latestDelta = candidatePatch;
      }
      worktreeFingerprintBefore =
        await taskGit.worktreeFingerprintExcept(planArtifacts);

      if (deps.paths) {
        persistTaskArtifact(deps.paths, taskId, "diff.patch", candidatePatch);
      }

      reviewHeadBefore = await taskGit.head();
      if (worktreePath) {
        const checkpoint = await checkpointCandidate(taskGit, candidate);
        if (checkpoint.result && checkpoint.result.exitCode !== 0) {
          await quarantineAndRestore(
            `Unable to checkpoint implementation: ${checkpoint.result.stderr || checkpoint.result.stdout}`,
          );
          feedback = recordSystemFailure(
            task.index,
            systemFailures,
            "system",
            `Unable to checkpoint implementation. Fix the issue and try again.\n\n${checkpoint.result.stderr || checkpoint.result.stdout}`,
          );
          systemFailures++;
          attempt++;
          continue;
        }
        candidate = checkpoint.candidate;
        if (reviewState && previousCandidate) {
          latestDeltaPaths = parseNameStatusPaths(
            await taskGit.diffRangeNameStatus(
              previousCandidate,
              candidate.trustedCheckpoint!,
            ),
          );
        }
        semanticNoop = Boolean(
          reviewState &&
          !checkpoint.changed &&
          previousCandidate === candidate.trustedCheckpoint,
        );
        if (checkpoint.changed) {
          trustedSnapshot = await captureRestoreSnapshot(
            taskGit,
            planArtifacts,
          );
          appendEvent(deps.paths!, {
            type: "candidate_checkpointed",
            taskId,
            commitSha: candidate.trustedCheckpoint!,
            amended: Boolean(reviewHeadBefore !== candidate.candidateBaseSha),
          });
        } else {
          appendEvent(deps.paths!, { type: "candidate_noop", taskId });
        }
        persistCandidate("reviewing");
        reviewHeadBefore = await taskGit.head();
        worktreeFingerprintBefore =
          await taskGit.worktreeFingerprintExcept(planArtifacts);
      }
      candidateIdentity = worktreePath
        ? candidate.trustedCheckpoint!
        : fingerprintBefore;
      semanticNoop ||= Boolean(
        reviewState && previousCandidate === candidateIdentity,
      );
    } else if (parsed.result.outcome === "already_satisfied") {
      await taskGit.reset();
      reviewHeadBefore = await taskGit.head();
      candidateIdentity = reviewHeadBefore;
      semanticNoop = Boolean(
        reviewState && previousCandidate === candidateIdentity,
      );
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
      attempt++;
      continue;
    }

    if (semanticNoop && reviewState) {
      const update = applyNoopReview(reviewState);
      reviewState = update.state;
      latestEvidence = `Implementer reported rework without changing candidate ${candidateIdentity}.`;
      if (update.outcome === "stalled") {
        persistCandidate("stalled", latestEvidence);
        throw new TaskStalledError(
          `task ${task.index} stalled after unchanged candidate rework`,
        );
      }
      feedback = typedReviewerFeedback(
        reviewState.findings,
        reviewState.outstandingIds,
        latestEvidence,
        verificationFailures,
      );
      persistCandidate("needs_rework", latestEvidence);
      attempt++;
      continue;
    }

    const candidateContext = [
      `Candidate identity: ${candidateIdentity}`,
      `Implementer summary: ${parsed.result.summary}`,
      parsed.result.outcome === "already_satisfied"
        ? `There is no staged candidate diff; the implementer reports the task is already satisfied.\nCurrent HEAD: ${candidateIdentity}`
        : "",
      alreadySatisfiedDiscrepancy
        ? "## Outcome Discrepancy\nThe implementer reported already_satisfied while producing a candidate delta; assess the delta as the ground truth."
        : "",
      "Implementer verification:",
      ...parsed.result.verification.map(
        (step) => `- ${step.command}: ${step.result} (${step.rationale})`,
      ),
      verificationFailures.length
        ? `Prior verification failures:\n${verificationFailures.map((failure) => `- ${failure}`).join("\n")}`
        : "",
      sourceMaterialPacket?.section
        ? `## Referenced Source Material\n\n${sourceMaterialPacket.section}`
        : "",
      `Latest candidate delta:\n${latestDelta}`,
    ]
      .filter(Boolean)
      .join("\n\n");
    const outOfScopeTasks = deps.executionManifest
      ? deps.executionManifest.tasks
          .filter((manifestTask) => manifestTask.planIndex !== task.index)
          .map((manifestTask) => `- ${manifestTask.title}`)
      : plan.tasks
          .filter((planTask) => planTask.index !== task.index)
          .map((planTask) => planTask.originalLine);
    reviewerPrompt = reviewState
      ? buildAnchoredTaskReviewPrompt({
          compiledContract,
          worktreePath: effectiveWorktreePath,
          candidateContext,
          outstandingFindings: reviewState.findings.filter((finding) =>
            reviewState!.outstandingIds.includes(finding.id),
          ),
          previousCandidate: previousCandidate ?? "(initial candidate)",
          currentCandidate: candidateIdentity,
          latestDelta,
        })
      : buildInitialTaskReviewPrompt({
          compiledContract,
          worktreePath: effectiveWorktreePath,
          candidateContext,
          outOfScopeTasks,
        });
    if (schedulerTask) {
      schedulerTask.status = "reviewing";
    }
    deps.updateState({ phase: "reviewing", activeSubagentId: undefined });

    if (deps.paths) {
      persistTaskArtifact(
        deps.paths,
        taskId,
        "reviewer-prompt.md",
        reviewerPrompt!,
      );
    }

    {
      const reviewerSnapshot = await captureRestoreSnapshot(
        taskGit,
        planArtifacts,
      );
      let reviewerSystemFailures = 0;
      reviewerLoop: for (;;) {
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
          completion: {
            description: "Submit the typed task review.",
            schema: reviewState
              ? anchoredReviewSchema
              : initialTaskReviewSchema,
          },
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
            integrationAttempts: schedulerTask?.integrationAttempts ?? 0,
            baseSha: candidate.candidateBaseSha,
            candidateBaseSha: candidate.candidateBaseSha,
            candidateSha: candidate.candidateSha,
            candidateTree: candidate.candidateTree,
            trustedCheckpoint: candidate.trustedCheckpoint,
            discardedBundles: candidate.discardedBundles,
            worktreePath,
            branchName,
            activeSubagentIds: [reviewerId],
            review: currentTaskReviewMetadata(deps.paths, taskId),
          });
        }
        const review = await deps.subagents.waitFor(reviewerId, deps.signal);
        if (deps.paths) {
          persistTaskArtifact(
            deps.paths,
            taskId,
            "reviewer-result.json",
            JSON.stringify(
              { result: review, runtime: review.runtime },
              null,
              2,
            ),
          );
        }
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
            integrationAttempts: schedulerTask?.integrationAttempts ?? 0,
            baseSha: candidate.candidateBaseSha,
            candidateBaseSha: candidate.candidateBaseSha,
            candidateSha: candidate.candidateSha,
            candidateTree: candidate.candidateTree,
            trustedCheckpoint: candidate.trustedCheckpoint,
            discardedBundles: candidate.discardedBundles,
            worktreePath,
            branchName,
            activeSubagentIds: [],
            lastReason:
              review.status !== "completed" ? review.error : undefined,
            review: currentTaskReviewMetadata(deps.paths, taskId),
          });
        }
        if (review.status === "stopped") {
          await resetTaskForRetry(
            taskGit,
            worktreePath,
            candidate.trustedCheckpoint ?? reviewHeadBefore,
            planArtifacts,
            reviewerSnapshot,
          );
          throw new StoppedError();
        }
        if (deps.signal?.aborted || deps.shouldStop()) {
          await resetTaskForRetry(
            taskGit,
            worktreePath,
            candidate.trustedCheckpoint ?? reviewHeadBefore,
            planArtifacts,
            reviewerSnapshot,
          );
          throw new StoppedError();
        }
        if (review.status === "failed") {
          try {
            await restoreAndVerify(taskGit, reviewerSnapshot, planArtifacts);
          } catch (error) {
            throw new BlockedError(
              `reviewer mutation could not be restored: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
          recordSystemFailure(
            task.index,
            reviewerSystemFailures,
            "system",
            `Reviewer subagent failed: ${review.error}`,
          );
          reviewerSystemFailures++;
          continue reviewerLoop;
        }

        // Boundary checks
        if (!worktreePath && (await deps.git.head()) !== taskHeadBefore) {
          throw new BlockedError("reviewer changed HEAD");
        }
        const changedPlanArtifactAfterReview = changedSnapshotPath(
          planArtifacts,
          planArtifactSnapshot,
        );
        if (
          changedPlanArtifactAfterReview ||
          (worktreePath &&
            (await snapshotChanged(taskGit, reviewerSnapshot!, planArtifacts)))
        ) {
          try {
            await restoreAndVerify(taskGit, reviewerSnapshot!, planArtifacts);
          } catch (err) {
            throw new BlockedError(
              `reviewer mutation could not be restored: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
          if (changedPlanArtifactAfterReview) {
            throw new BlockedError(
              `reviewer changed a plan artifact: ${changedPlanArtifactAfterReview}`,
            );
          }
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
            snapshot: reviewerSnapshot,
          });
        }
        const anchoredReviewState = reviewState;
        if (anchoredReviewState) {
          const parsedReview = parseAnchoredReviewResult(
            review.result,
            anchoredReviewState.outstandingIds,
          );
          if (!parsedReview.ok) {
            recordSystemFailure(
              task.index,
              reviewerSystemFailures,
              "system",
              `Reviewer produced invalid typed completion: ${parsedReview.reason}`,
            );
            reviewerSystemFailures++;
            continue reviewerLoop;
          }
          let update;
          try {
            if (anchoredReviewState.outstandingIds.length === 0) {
              const regressionEpoch = openRegressionReviewEpoch({
                closedState: anchoredReviewState,
                regressions: parsedReview.result.regressions,
                latestDeltaPaths,
              });
              reviewEpoch++;
              reviewState = regressionEpoch.state;
              update = {
                state: reviewState,
                outcome:
                  reviewState.outstandingIds.length === 0
                    ? "approved"
                    : "continue",
                observations: [
                  ...(parsedReview.result.observations ?? []),
                  ...regressionEpoch.observations,
                ],
              };
            } else {
              update = applyAnchoredReview({
                state: anchoredReviewState,
                review: parsedReview.result,
                latestDeltaPaths,
              });
            }
          } catch (error) {
            recordSystemFailure(
              task.index,
              reviewerSystemFailures,
              "system",
              `Reviewer protocol failure: ${error instanceof Error ? error.message : String(error)}`,
            );
            reviewerSystemFailures++;
            continue reviewerLoop;
          }
          reviewState = update.state;
          latestEvidence =
            update.observations
              .map(
                (observation) =>
                  `${observation.summary}: ${observation.evidence}`,
              )
              .join("\n") || undefined;
          if (update.outcome === "stalled") {
            persistCandidate(
              "stalled",
              "task review stalled without a new low outstanding count",
            );
            throw new TaskStalledError(
              `task ${task.index} review stalled without a new low outstanding count`,
            );
          }
        } else {
          const parsedReview = parseInitialReviewResult(review.result);
          if (!parsedReview.ok) {
            recordSystemFailure(
              task.index,
              reviewerSystemFailures,
              "system",
              `Reviewer produced invalid typed completion: ${parsedReview.reason}`,
            );
            reviewerSystemFailures++;
            continue reviewerLoop;
          }
          reviewState = createReviewConvergenceState({
            drafts:
              parsedReview.result.verdict === "changes_requested"
                ? parsedReview.result.findings
                : [],
          });
        }
        await recordPapercuts(deps, review.result, "reviewer", taskId);

        previousCandidate = candidateIdentity;
        previousCandidatePatch = candidatePatch;
        persistCandidate("reviewing", latestEvidence);
        const outstanding = reviewState.outstandingIds;
        deps.updateState((prev) =>
          checkpointPatch(
            prev,
            outstanding.length === 0
              ? `\u2713 Task ${task.index}/${plan.tasks.length} review approved`
              : `\u00b7 Task ${task.index}/${plan.tasks.length} review changes requested: ${reviewState!.findings
                  .filter((finding) => outstanding.includes(finding.id))
                  .map((finding) => finding.summary)
                  .join("; ")}`,
          ),
        );
        if (outstanding.length > 0) {
          latestEvidence = assessmentEvidence(
            reviewState.findings,
            outstanding,
            "The reviewer returned no assessment evidence.",
          );
          feedback = typedReviewerFeedback(
            reviewState.findings,
            outstanding,
            latestEvidence,
            verificationFailures,
          );
          await resetTaskForRetry(
            taskGit,
            worktreePath,
            candidate.trustedCheckpoint ?? reviewHeadBefore,
            planArtifacts,
            reviewerSnapshot,
          );
          persistCandidate("needs_rework", latestEvidence);
          attempt++;
          continue workerLoop;
        }
        closedEpochs.push({
          epoch: reviewEpoch,
          findings: reviewState.findings,
        });
        break reviewerLoop;
      }
    }

    const taskReviewMeta = {
      ...nextTaskReviewMetadata(deps.paths, taskId),
      ...persistReview("reviewed"),
    };

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
          integrationAttempts: schedulerTask?.integrationAttempts ?? 0,
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
          integrationAttempts: schedulerTask?.integrationAttempts ?? 0,
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

    // Approved changed candidate
    if (deps.paths) {
      writeTaskJson(deps.paths, taskId, {
        id: taskId,
        planIndex: task.index - 1,
        title: task.text,
        status: "approved",
        dependsOn: [],
        attempts: attempt,
        integrationAttempts: schedulerTask?.integrationAttempts ?? 0,
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
      const taskCommit = await taskGit.rewordInternal(approvedMessage);
      if (taskCommit.exitCode !== 0) {
        throw new BlockedError(
          `could not finalize approved checkpoint: ${taskCommit.stderr || taskCommit.stdout}`,
        );
      }
      const taskCommitSha = await taskGit.head();
      candidate = {
        ...candidate,
        candidateSha: taskCommitSha,
        trustedCheckpoint: taskCommitSha,
      };
      persistCandidate("approved");
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
          integrationAttempts: schedulerTask?.integrationAttempts ?? 0,
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
          integrationAttempts: schedulerTask?.integrationAttempts ?? 0,
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
  snapshot?: RestoreSnapshot;
}): Promise<void> {
  const {
    taskGit,
    planArtifacts,
    stagedFingerprintBefore,
    candidatePatch,
    worktreeFingerprintBefore,
    committedSha,
    snapshot,
  } = args;

  if (committedSha && snapshot) {
    if (!(await snapshotChanged(taskGit, snapshot, planArtifacts))) {
      return;
    }
    try {
      await restoreAndVerify(taskGit, snapshot, planArtifacts);
    } catch (err) {
      throw new BlockedError(
        `reviewer changed the candidate and exact auto-heal failed: ${err instanceof Error ? err.message : String(err)}`,
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

class IntegrationSafetyError extends BlockedError {}

class TaskStalledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskStalledError";
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
  const task = readTaskJson(paths, taskId);
  const round = Math.max(1, task?.implementationRound ?? task?.attempts ?? 1);
  const dir = join(
    paths.tasksDir,
    taskId,
    "rounds",
    String(round).padStart(3, "0"),
  );
  mkdirSync(dir, { recursive: true });
  const target = join(dir, filename);
  if (!existsSync(target)) {
    writeFileSync(target, content, "utf-8");
    return;
  }
  let ordinal = 2;
  let alternate = join(dir, filename.replace(/(\.[^.]+)?$/, `-${ordinal}$1`));
  while (existsSync(alternate)) {
    ordinal++;
    alternate = join(dir, filename.replace(/(\.[^.]+)?$/, `-${ordinal}$1`));
  }
  writeFileSync(alternate, content, "utf-8");
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

function verificationFailed(result: string): boolean {
  return /\b(fail(?:ed|ure)?|error|not\s+(?:pass|successful|clean|ok)|did not pass|unsuccessful)\b/i.test(
    result,
  );
}

function assessmentEvidence(
  findings: readonly ReviewFinding[],
  outstandingIds: readonly string[],
  fallback: string,
): string {
  const evidenceById = new Map(
    findings.map((finding) => [finding.id, finding.evidence]),
  );
  const evidence = outstandingIds
    .map((id) => `${id}: ${evidenceById.get(id) ?? fallback}`)
    .join("\n");
  return evidence || fallback;
}

function typedReviewerFeedback(
  findings: readonly ReviewFinding[],
  outstandingIds: readonly string[],
  latestEvidence: string | undefined,
  verificationFailures: readonly string[],
): RetryFeedback {
  const outstanding = findings.filter((finding) =>
    outstandingIds.includes(finding.id),
  );
  return {
    source: "reviewer",
    message: [
      "Outstanding findings:",
      ...outstanding.map(
        (finding) =>
          `- ${finding.id}: ${finding.summary}\n  Evidence: ${finding.evidence}\n  Required change: ${finding.requiredChange}\n  Acceptance criteria:\n${finding.acceptanceCriteria.map((criterion) => `  - ${criterion}`).join("\n")}`,
      ),
      latestEvidence ? `Latest review evidence:\n${latestEvidence}` : "",
      verificationFailures.length
        ? `Prior verification failures:\n${verificationFailures.map((failure) => `- ${failure}`).join("\n")}`
        : "",
    ]
      .filter(Boolean)
      .join("\n\n"),
  };
}

function formatFeedback(feedback: RetryFeedback): string {
  return `Source: ${feedback.source}\n${feedback.message}`;
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
  snapshot?: RestoreSnapshot,
): Promise<void> {
  if (worktreePath) {
    if (snapshot) {
      await restoreAndVerify(taskGit, snapshot, planArtifacts);
    } else {
      await taskGit.resetHard(resetSha);
      await taskGit.restoreWorktreeFromIndexExcept(planArtifacts);
    }
    return;
  }
  await taskGit.reset();
}

function shortTask(text: string): string {
  return text.length <= 80 ? text : `${text.slice(0, 77)}…`;
}
