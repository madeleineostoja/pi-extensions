import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  buildAnchoredTaskReviewPrompt,
  buildInitialTaskReviewPrompt,
  buildTaskFindingAdmissionPrompt,
  buildFindingAdmissionPrompt,
  FINDING_ADMISSION_SYSTEM_PROMPT,
  buildImplementerPrompt,
  buildIntegrationReviewerPrompt,
  buildIntegrationSelfHealPrompt,
  buildIntegrationRecoveryPrompt,
  buildInitialOverallReviewPrompt,
  buildAnchoredOverallReviewPrompt,
  buildOverallReworkPrompt,
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
  buildReviewResponsibilityContext,
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
import { runCommand } from "./git-process.js";
import {
  RunStore,
  StaleRunStateRevisionError,
  type CandidateRef,
  type CanonicalRunState,
} from "./canonical-state.js";
import { SchedulerActor } from "./scheduler-actor.js";
import { IntegrationEngine } from "./integration-engine.js";
import {
  approvedCandidateRef,
  TaskWorkspaceManager,
} from "./candidate-worker.js";
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
import type { SubagentClient, SubagentResult } from "./subagents.js";
import type { EffectiveRoles } from "./config.js";
import {
  persistPapercutCandidates,
  type PapercutStoreFactory,
} from "./papercuts.js";
import type {
  RunState,
  ScheduledTaskState,
  AgentDisplayRef,
  StatePatch,
  ReviewProgress,
} from "./status.js";
import {
  fallbackCommitMessage,
  isValidCommitMessage,
  parseAnchoredReviewResult,
  parseImplementerResult,
  parseInitialReviewResult,
  parseAdmissionResult,
  parseIntegrationSelfHealResult,
  parseIntegrationRecoveryResult,
  parseOverallReworkResult,
} from "./verdict.js";
import type { IntegrationSelfHealResult } from "./verdict.js";
import type { OverallReviewJson, StatePaths, TaskJson } from "./state.js";
import type { IntegrationLedger } from "./integration-ledger.js";
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
import { readGraphJson } from "./graph.js";
import {
  anchoredReviewSchema,
  implementerResultSchema,
  initialTaskReviewSchema,
  findingAdmissionBatchSchema,
  integrationAnchoredReviewSchema,
  integrationInitialReviewSchema,
  integrationSelfHealSchema,
  integrationRecoverySchema,
  overallReworkSchema,
  initialOverallReviewSchema,
  sourceMaterialRepairSchema,
} from "./result-schemas.js";
import type { ImplementGraph } from "./graph.js";
import {
  createProposalBatchId,
  evaluateFindingAdmission,
} from "./finding-admission.js";
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
  selectIntegrationTask,
  allTasksTerminal,
  anyTaskFailedBlockedStopped,
  getBlockedReason,
  type SchedulerRun,
  type SchedulerTask,
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
const MAX_INTEGRATION_SELF_HEAL_ATTEMPTS = 2;
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
  canonicalRunStore?: RunStore;
  updateState(state: StatePatch): void;
  shouldStop(): boolean;
  signal?: AbortSignal;
  verifyCommand?: string;
  papercutStoreFactory?: PapercutStoreFactory;
};

async function updateCanonicalRunPhase(
  store: RunStore | undefined,
  phase: CanonicalRunState["runtime"]["phase"],
  terminalReason?: string,
): Promise<void> {
  if (!store) {
    return;
  }
  const current = store.read();
  await store.update(current.revision, (state) => ({
    ...state,
    runtime: {
      ...state.runtime,
      phase,
      ...(terminalReason ? { terminalReason } : {}),
    },
  }));
}

export async function runImplementation(deps: OrchestratorDeps): Promise<void> {
  await updateCanonicalRunPhase(deps.canonicalRunStore, "preflight");
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

  const runBaseSha = deps.canonicalRunStore
    ? deps.canonicalRunStore.read().run.target.startHead
    : deps.paths
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
  await runScheduledImplementation(
    deps,
    graph,
    plan,
    planArtifacts,
    runBaseSha,
  );
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
        affectedAreas: task.affectedAreas,
        conflictHints: task.conflictHints,
        validationCommands: task.validationCommands ?? [],
        confidence: "high",
        reasons: task.reasons ?? [],
        evidencePaths: task.evidencePaths ?? [],
      })),
    };
    if (graph.nodes.length > 0) {
      await runScheduledImplementation(
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
    if (!deps.paths) {
      throw new BlockedError("task execution requires an owned run workspace");
    }
    const worktreePath = join(deps.paths.worktreesDir, taskId);
    const workspaceManager = new TaskWorkspaceManager(
      deps.git,
      deps.paths.worktreesDir,
    );

    await workspaceManager.ensure({
      taskId,
      branchName,
      worktreePath,
      baseSha,
    });
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

    const taskGit = deps.git.forWorktree(worktreePath, await deps.git.root());
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

function linkedAbortController(
  parent: AbortSignal | undefined,
): AbortController {
  const controller = new AbortController();
  if (!parent) {
    return controller;
  }
  if (parent.aborted) {
    controller.abort();
    return controller;
  }
  parent.addEventListener("abort", () => controller.abort(), { once: true });
  return controller;
}

// ── Managed scheduler ───────────────────────────────────────────────────────

type WorkerResult = {
  taskId: string;
  outcome:
    | {
        kind: "approved";
        candidate: CandidateRef;
        commitMessage: string;
      }
    | { kind: "satisfied" }
    | { kind: "stalled"; reason: string }
    | { kind: "failed"; reason: string }
    | { kind: "stopped" };
};

function schedulerWorkerOutcome(
  result: WorkerResult,
): import("./scheduler.js").SchedulerEvent extends infer _Event
  ? Extract<
      import("./scheduler.js").SchedulerEvent,
      { kind: "worker_finished" }
    >["outcome"]
  : never {
  switch (result.outcome.kind) {
    case "satisfied":
      return { kind: "satisfied" };
    case "stopped":
      return { kind: "cancelled" };
    case "stalled":
    case "failed":
      return {
        kind: "failed",
        failureKind: "unknown",
        reason: result.outcome.reason,
      };
    case "approved":
      return { kind: "candidate_ready", candidate: result.outcome.candidate };
  }
}

function legacyWorkerResult(
  completion: {
    taskId: string;
    leaseId: string;
    outcome: import("./scheduler.js").SchedulerEvent extends infer _Event
      ? Extract<
          import("./scheduler.js").SchedulerEvent,
          { kind: "worker_finished" }
        >["outcome"]
      : never;
  },
  taskFor: (taskId: string) => SchedulerTask | undefined,
): WorkerResult {
  switch (completion.outcome.kind) {
    case "candidate_ready": {
      const task = taskFor(completion.taskId)!;
      return {
        taskId: completion.taskId,
        outcome: {
          kind: "approved",
          candidate: completion.outcome.candidate,
          commitMessage:
            task.approvedCommitMessage ?? `chore: implement ${task.title}`,
        },
      };
    }
    case "satisfied":
      return { taskId: completion.taskId, outcome: { kind: "satisfied" } };
    case "cancelled":
      return { taskId: completion.taskId, outcome: { kind: "stopped" } };
    case "waiting_rework":
      return {
        taskId: completion.taskId,
        outcome: { kind: "stalled", reason: "Worker requested rework." },
      };
    case "failed":
      return {
        taskId: completion.taskId,
        outcome: { kind: "failed", reason: completion.outcome.reason },
      };
  }
}

async function runScheduledImplementation(
  deps: OrchestratorDeps,
  graph: ImplementGraph,
  initialPlan: ReturnType<typeof parsePlanFile>,
  planArtifacts: string[],
  runBaseSha: string,
): Promise<void> {
  const schedulerAbort = linkedAbortController(deps.signal);
  const outerShouldStop = deps.shouldStop;
  deps = {
    ...deps,
    signal: schedulerAbort.signal,
    shouldStop: () => outerShouldStop() || schedulerAbort.signal.aborted,
  };
  const sched = deps.canonicalRunStore
    ? schedulerRunFromCanonical(
        graph,
        deps.maxConcurrency ?? 1,
        deps.canonicalRunStore.read(),
      )
    : deps.paths
      ? hydrateSchedulerRun(graph, deps.maxConcurrency ?? 1, deps.paths)
      : createSchedulerRun(graph, deps.maxConcurrency ?? 1);
  const runningWorkers = new Map<string, Promise<WorkerResult>>();
  let plan = initialPlan;
  const reworkTaskIds = new Set<string>();
  let workerSafetyError: Error | undefined;
  let schedulerActor: SchedulerActor | undefined;
  if (deps.canonicalRunStore) {
    schedulerActor = new SchedulerActor({
      store: deps.canonicalRunStore,
      executeCleanup: async ({ debtId }) => {
        const state = deps.canonicalRunStore!.read();
        if (debtId.startsWith("overall-review:")) {
          const attemptId =
            state.runtime.overall.phase === "completed"
              ? state.runtime.overall.landingAttemptId
              : undefined;
          const attempt = state.integrationAttempts.find(
            (entry) => entry.id === attemptId && entry.owner.kind === "overall",
          );
          const candidate = attempt && state.candidates[attempt.candidateId];
          if (!attempt || !candidate) {
            throw new Error(`Cleanup debt ${debtId} has no overall candidate.`);
          }
          await new TaskWorkspaceManager(
            deps.git,
            deps.paths!.worktreesDir,
          ).remove(
            {
              taskId: attempt.id,
              branchName: candidate.branchName,
              worktreePath: candidate.worktreePath,
              baseSha: candidate.baseSha,
            },
            candidate.commitSha,
          );
          return;
        }
        const attemptId = debtId.replace(/^integration:/, "");
        const attempt = state.integrationAttempts.find(
          (entry) => entry.id === attemptId,
        );
        const candidate = attempt && state.candidates[attempt.candidateId];
        if (!attempt || !candidate || attempt.phase !== "completed") {
          throw new Error(`Cleanup debt ${debtId} has no completed attempt.`);
        }
        if (attempt.preparedCommitSha === "rework") {
          const worktreePath = join(
            deps.paths!.worktreesDir,
            "integrations",
            attempt.id,
          );
          const branchName = `pi-implement/integration/${attempt.id.replaceAll(/[^A-Za-z0-9._-]/g, "-")}`;
          const workspace = new TaskWorkspaceManager(
            deps.git,
            join(deps.paths!.worktreesDir, "integrations"),
          );
          const stagingGit = deps.git.forWorktree(worktreePath);
          await stagingGit.resetHard(attempt.targetBaseSha);
          await stagingGit.restoreWorktreeFromIndexExcept([]);
          await workspace.remove(
            {
              taskId: attempt.id,
              branchName,
              worktreePath,
              baseSha: attempt.targetBaseSha,
            },
            attempt.targetBaseSha,
          );
          return;
        }
        const targetBranch = state.run.target.branchRef.replace(
          /^refs\/heads\//,
          "",
        );
        const engine = new IntegrationEngine({
          git: deps.git,
          worktreesRoot: join(deps.paths!.worktreesDir, "integrations"),
          targetCheckoutId: state.run.target.gitDir,
          targetBranch,
          protectedPaths: planArtifacts,
        });
        const prepared = await engine.reconstructPrepared(attempt, candidate);
        if (prepared.kind !== "reconstructed") {
          throw new Error(
            `Cleanup debt ${debtId} cannot reconstruct its workspace.`,
          );
        }
        await engine.cleanup(prepared.prepared);
      },
      executeIntegration: async ({
        attemptId,
        candidateId,
        signal,
        dispatch,
      }) => {
        const state = deps.canonicalRunStore!.read();
        const attempt = state.integrationAttempts.find(
          (entry) => entry.id === attemptId,
        );
        const candidate = state.candidates[candidateId];
        if (!attempt || !candidate) {
          throw new Error(
            "Integration effect has no matching durable candidate attempt.",
          );
        }
        const integrationAttempt = attempt;
        const targetBranch = state.run.target.branchRef.replace(
          /^refs\/heads\//,
          "",
        );
        const engine = new IntegrationEngine({
          git: deps.git.withSignal?.(signal) ?? deps.git,
          worktreesRoot: join(deps.paths!.worktreesDir, "integrations"),
          targetCheckoutId: state.run.target.gitDir,
          targetBranch,
          protectedPaths: planArtifacts,
          validate: async ({
            git: stagingGit,
            worktreePath,
            signal: validationSignal,
          }) => {
            const commands = await resolveValidationCommands(deps);
            for (const command of commands) {
              const result = await runValidationCommand(
                command,
                worktreePath,
                validationSignal,
              );
              if (result.exitCode !== 0) {
                const failure = `${command.display}: ${result.stderr || result.stdout}`;
                if (integrationAttempt.recovery !== undefined) {
                  return {
                    ok: false,
                    disposition: "blocked",
                    reason: `${failure}\n\nIntegration recovery was already consumed for this attempt.`,
                  };
                }
                await dispatch({
                  kind: "integration_recovery_started",
                  attemptId,
                  now: new Date().toISOString(),
                });
                type RecoveryBoundary = {
                  head: string;
                  tree: string;
                  staged: string;
                  working: string;
                  untracked: string;
                  protectedArtifacts: Record<string, string>;
                  targetHead: string;
                  targetWorking: string;
                  targetUntracked: string;
                };
                const snapshotRecoveryBoundary =
                  async (): Promise<RecoveryBoundary> => ({
                    head: await stagingGit.head(),
                    tree: await stagingGit.tree(),
                    staged: await stagingGit.stagedFingerprint(),
                    working: await stagingGit.worktreeFingerprintExcept([]),
                    untracked:
                      await stagingGit.nonignoredUntrackedFingerprint(),
                    protectedArtifacts: await engine.protectedArtifactHashes(),
                    targetHead: await deps.git.head(),
                    targetWorking:
                      await deps.git.worktreeFingerprintExcept(planArtifacts),
                    targetUntracked:
                      await deps.git.nonignoredUntrackedFingerprint(),
                  });
                const before = await snapshotRecoveryBoundary();
                const targetSnapshot = await captureRestoreSnapshot(
                  deps.git,
                  planArtifacts,
                );
                let recovery:
                  | ReturnType<typeof parseIntegrationRecoveryResult>
                  | undefined;
                try {
                  const id = await deps.subagents.spawn({
                    type: deps.roles.selfHeal.type,
                    prompt: buildIntegrationRecoveryPrompt({
                      attemptId,
                      owner:
                        integrationAttempt.owner.kind === "task"
                          ? `task ${integrationAttempt.owner.taskId}`
                          : "overall review",
                      candidateCommitSha: candidate.commitSha,
                      candidateTreeSha: candidate.treeSha,
                      targetBaseSha: integrationAttempt.targetBaseSha,
                      worktreePath,
                      command: command.display,
                      output: result.stderr || result.stdout,
                      planArtifacts,
                    }),
                    description: `integration recovery ${attemptId}`,
                    model: deps.roles.selfHeal.model,
                    thinking: deps.roles.selfHeal.thinking,
                    role: "selfHeal",
                    stage: "integration_recovery",
                    taskId:
                      integrationAttempt.owner.kind === "task"
                        ? integrationAttempt.owner.taskId
                        : undefined,
                    cwd: worktreePath,
                    completion: {
                      description: "Submit the integration recovery result.",
                      schema: integrationRecoverySchema,
                    },
                  });
                  const response = await deps.subagents.waitFor(
                    id,
                    validationSignal,
                  );
                  recovery =
                    response.status === "completed"
                      ? parseIntegrationRecoveryResult(response.result)
                      : undefined;
                } catch {
                  recovery = undefined;
                }
                let after: RecoveryBoundary | undefined;
                try {
                  after = await snapshotRecoveryBoundary();
                } catch {
                  after = undefined;
                }
                const safe =
                  after !== undefined &&
                  before.head === after.head &&
                  before.tree === after.tree &&
                  before.staged === after.staged &&
                  before.working === after.working &&
                  before.untracked === after.untracked &&
                  JSON.stringify(before.protectedArtifacts) ===
                    JSON.stringify(after.protectedArtifacts) &&
                  before.targetHead === after.targetHead &&
                  before.targetWorking === after.targetWorking &&
                  before.targetUntracked === after.targetUntracked &&
                  after.tree === candidate.treeSha;
                if (!safe || !recovery?.ok) {
                  let targetRestored = true;
                  try {
                    await restoreAndVerify(
                      deps.git,
                      targetSnapshot,
                      planArtifacts,
                    );
                  } catch {
                    targetRestored = false;
                  }
                  let stagingDiscarded = true;
                  try {
                    await engine.discardOwnedWorkspace(integrationAttempt);
                  } catch {
                    stagingDiscarded = false;
                  }
                  const summary = !targetRestored
                    ? "Integration recovery changed the target checkout and exact restoration failed."
                    : !stagingDiscarded
                      ? "Integration recovery workspace could not be discarded safely."
                      : safe
                        ? recovery && !recovery.ok
                          ? recovery.reason
                          : "Integration recovery did not return a valid result."
                        : "Integration recovery changed protected candidate state.";
                  await dispatch({
                    kind: "integration_recovery_completed",
                    attemptId,
                    disposition: "blocked",
                    summary,
                  });
                  return { ok: false, disposition: "blocked", reason: summary };
                }
                await dispatch({
                  kind: "integration_recovery_completed",
                  attemptId,
                  disposition: recovery.result.disposition,
                  summary: recovery.result.summary,
                });
                if (recovery.result.disposition === "candidate_rework") {
                  return {
                    ok: false,
                    disposition: "needs_rework",
                    reason: recovery.result.summary,
                  };
                }
                if (recovery.result.disposition === "blocked") {
                  return {
                    ok: false,
                    disposition: "blocked",
                    reason: recovery.result.summary,
                  };
                }
                const retry = await runValidationCommand(
                  command,
                  worktreePath,
                  validationSignal,
                );
                if (retry.exitCode !== 0) {
                  return {
                    ok: false,
                    disposition: "blocked",
                    reason: `${command.display}: ${retry.stderr || retry.stdout}`,
                  };
                }
              }
            }
            if (commands.length > 0 || attempt.owner.kind !== "task") {
              return { ok: true };
            }
            const fallbackGit = (
              deps.git.withSignal?.(validationSignal) ?? deps.git
            ).forWorktree(worktreePath, await deps.git.root());
            const stagingPlanArtifacts = overallWorktreePlanArtifacts(
              worktreePath,
              await deps.git.root(),
              planArtifacts,
            );
            const schedulerTask = sched.tasks.get(attempt.owner.taskId);
            if (!schedulerTask) {
              return {
                ok: false,
                reason: "Canonical fallback review has no scheduler task.",
              };
            }
            if (!schedulerTask.integrationLedger) {
              schedulerTask.integrationLedger = createIntegrationLedger({
                mainBaseSha: integrationAttempt.targetBaseSha,
                gates: [
                  {
                    key: "fallback",
                    kind: "fallback",
                    label: "Fallback integration review",
                  },
                ],
              });
            }
            const verdict = await runIntegrationReviewFallback(
              { ...deps, git: fallbackGit },
              attempt.owner.taskId,
              stagingPlanArtifacts,
              schedulerTask,
            );
            return verdict.ok
              ? { ok: true }
              : {
                  ok: false,
                  disposition: "needs_rework",
                  reason: verdict.reason,
                };
          },
        });
        const preparation =
          integrationAttempt.phase === "preparing"
            ? await engine.prepare(integrationAttempt, candidate, signal)
            : await engine.reconstructPrepared(integrationAttempt, candidate);
        if (
          preparation.kind !== "prepared" &&
          preparation.kind !== "reconstructed"
        ) {
          if (preparation.kind === "target_moved") {
            await transplantMovedTaskCandidate({
              deps,
              sched,
              attempt,
              candidate,
              actualTargetHead: preparation.actual,
              planArtifacts,
            });
            await dispatch({
              kind: "integration_needs_rework",
              attemptId,
              candidateId,
              reason: `Integration target moved from ${preparation.expected} to ${preparation.actual}.`,
            });
            return;
          }
          if (preparation.kind === "needs_rework") {
            await dispatch({
              kind: "integration_needs_rework",
              attemptId,
              candidateId,
              reason: preparation.reason,
            });
            return;
          }
          await dispatch({
            kind: "integration_paused",
            attemptId,
            reason:
              "reason" in preparation
                ? preparation.reason
                : "Integration preparation was cancelled.",
          });
          return;
        }
        const prepared = preparation.prepared;
        const protectedArtifactHashes =
          integrationAttempt.phase === "publishing" ||
          (integrationAttempt.phase === "paused" &&
            integrationAttempt.resumePhase === "publishing")
            ? (integrationAttempt.protectedArtifactHashes ??
              (await engine.protectedArtifactHashes()))
            : await engine.protectedArtifactHashes();
        if (integrationAttempt.phase === "preparing") {
          await dispatch({
            kind: "integration_prepared",
            attemptId,
            preparedCommitSha: prepared.preparedCommitSha,
          });
          await dispatch({
            kind: "integration_publishing",
            attemptId,
            protectedArtifactHashes,
          });
        } else if (integrationAttempt.phase === "prepared") {
          await dispatch({
            kind: "integration_publishing",
            attemptId,
            protectedArtifactHashes,
          });
        }
        const published = await engine.publish(
          integrationAttempt,
          prepared,
          candidate,
          signal,
          protectedArtifactHashes,
        );
        if (published.kind === "landed") {
          await dispatch({
            kind: "integration_landed",
            attemptId,
            receipt: published.receipt,
          });
          try {
            await engine.cleanup(prepared);
            await dispatch({
              kind: "cleanup_completed",
              debtId: `integration:${attemptId}`,
            });
          } catch {
            // Cleanup debt remains durable until a later idempotent cleanup succeeds.
          }
          return;
        }
        if (published.kind === "target_moved") {
          await transplantMovedTaskCandidate({
            deps,
            sched,
            attempt,
            candidate,
            actualTargetHead: published.actual,
            planArtifacts,
          });
          await dispatch({
            kind: "integration_needs_rework",
            attemptId,
            candidateId,
            reason: `Integration target moved from ${published.expected} to ${published.actual}.`,
          });
          return;
        }
        if (published.kind === "needs_rework") {
          await dispatch({
            kind: "integration_needs_rework",
            attemptId,
            candidateId,
            reason: published.reason,
          });
          return;
        }
        await dispatch({
          kind: "integration_paused",
          attemptId,
          reason:
            "reason" in published
              ? published.reason
              : "Integration publication was cancelled.",
        });
      },
      executeWorker: async ({ taskId, signal }) => {
        const canonical = deps.canonicalRunStore!.read();
        const task = sched.tasks.get(taskId)!;
        const execution = canonical.taskExecution[taskId];
        if (execution) {
          Object.assign(task, execution);
        }
        const planTask = plan.tasks.find(
          (entry) => entry.index === task.planIndex,
        );
        if (!planTask) {
          return {
            kind: "failed",
            failureKind: "spawn",
            reason: `Plan task ${task.planIndex} not found`,
          };
        }
        const wasNeedsRework =
          canonical.runtime.tasks[taskId]?.phase === "waiting_rework";
        task.status = wasNeedsRework ? "needs_rework" : "coding";
        try {
          const result = await launchTaskWorker(
            { ...deps, signal },
            sched,
            taskId,
            planTask,
            planArtifacts,
            runBaseSha,
            wasNeedsRework,
          );
          return schedulerWorkerOutcome(result);
        } catch (error) {
          return {
            kind: "failed",
            failureKind:
              error instanceof IntegrationSafetyError ? "safety" : "unknown",
            reason: error instanceof Error ? error.message : String(error),
          };
        }
      },
      awaitOwnedProcesses: () => deps.git.onIdle?.() ?? Promise.resolve(),
    });
    deps.signal?.addEventListener(
      "abort",
      () => {
        void schedulerActor?.stop();
      },
      { once: true },
    );
  }

  deps.updateState({
    phase: "scheduling",
    runId: deps.runId,
    mode: deps.mode,
    baseSha: graph.baseSha,
    maxConcurrency: deps.maxConcurrency,
    totalCount: graph.nodes.length,
    landedCount: 0,
  });

  try {
    await schedulerActor?.start();
    for (;;) {
      if (workerSafetyError) {
        await Promise.allSettled(runningWorkers.values());
        await deps.git.onIdle?.();
        throw new BlockedError(workerSafetyError.message);
      }
      if (outerShouldStop() || deps.signal?.aborted) {
        await schedulerActor?.stop();
        await updateCanonicalRunPhase(deps.canonicalRunStore, "stopping");
        schedulerAbort.abort();
        await Promise.allSettled(runningWorkers.values());
        await deps.git.onIdle?.();
        throw new StoppedError();
      }
      if (allTasksTerminal(sched)) {
        break;
      }

      plan = parsePlanFile(deps.planPath);
      validateRecordedPlanCorpus(deps);
      await schedulerActor?.schedule();
      if (schedulerActor) {
        const canonical = deps.canonicalRunStore!.read();
        const taskId = selectIntegrationTask(canonical);
        if (taskId) {
          await schedulerActor.requestIntegration({
            taskId,
            attemptId: `integration:${canonical.run.id}:${canonical.revision + 1}`,
            pipelineHash: integrationPipelineHash(
              await resolveValidationCommands(deps),
            ),
            protectedArtifactHashes: await protectedArtifactHashes(
              deps.git,
              planArtifacts,
            ),
          });
        }
      }

      // ── Start ready tasks ──
      const ready = schedulerActor
        ? []
        : computeReadyTasks(sched).filter((id) => canStartTask(sched, id));
      for (const taskId of ready) {
        if (runningWorkers.has(taskId)) {
          continue;
        }
        const wasNeedsRework =
          sched.tasks.get(taskId)?.status === "needs_rework";
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
        ).catch((error: unknown): WorkerResult => {
          if (error instanceof IntegrationSafetyError) {
            workerSafetyError = error;
            schedulerAbort.abort();
            return {
              taskId,
              outcome: { kind: "failed", reason: error.message },
            };
          }
          return {
            taskId,
            outcome: {
              kind: "failed",
              reason: error instanceof Error ? error.message : String(error),
            },
          };
        });
        runningWorkers.set(taskId, promise);
      }

      updateSchedulerState(deps, sched);

      const hasActiveRework = [...reworkTaskIds].some((id) =>
        runningWorkers.has(id),
      );

      // ── Try landing (serialized, plan-ordered) ──
      const toLand = schedulerActor ? undefined : nextTaskToLand(sched);
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
      if (schedulerActor || runningWorkers.size > 0) {
        // An actor settles a durable lease before reporting completion; legacy runs
        // retain this adapter until integration moves to the canonical engine.
        const completion = schedulerActor
          ? await schedulerActor.nextCompletion()
          : undefined;
        if (completion?.kind === "integration") {
          if (completion.owner.kind === "overall") {
            continue;
          }
          const task = sched.tasks.get(completion.owner.taskId)!;
          if (completion.outcome === "landed") {
            task.status = "landed";
            sched.landedOrder.push(completion.owner.taskId);
          } else {
            task.status =
              completion.outcome === "needs_rework"
                ? "needs_rework"
                : "stalled";
            task.lastReason =
              completion.outcome === "needs_rework"
                ? (deps.canonicalRunStore?.read().taskExecution[
                    completion.owner.taskId
                  ]?.lastReason ?? "Integration requires candidate rework.")
                : "Integration paused; candidate is retained for deterministic recovery.";
          }
          continue;
        }
        const result = schedulerActor
          ? legacyWorkerResult(completion!, sched.tasks.get.bind(sched.tasks))
          : await Promise.race(runningWorkers.values());
        runningWorkers.delete(result.taskId);
        reworkTaskIds.delete(result.taskId);

        const task = sched.tasks.get(result.taskId)!;
        if (result.outcome.kind === "approved") {
          task.status = "approved";
          task.taskCommitSha = result.outcome.candidate.commitSha;
          task.candidateSha = result.outcome.candidate.commitSha;
          task.candidateTree = result.outcome.candidate.treeSha;
          task.candidateBaseSha = result.outcome.candidate.baseSha;
          task.approvedCommitMessage = result.outcome.commitMessage;
          task.activeAgentIds = [];
          task.activeAgentRefs = [];
          if (deps.paths) {
            const existing = readTaskJson(deps.paths, result.taskId);
            writeTaskJson(deps.paths, result.taskId, {
              ...buildTaskJsonSnapshot(existing, task),
              status: "approved",
              taskCommitSha: result.outcome.candidate.commitSha,
              commitMessage: result.outcome.commitMessage,
              activeSubagentIds: [],
            });
            appendEvent(deps.paths, {
              type: "task_approved",
              taskId: result.taskId,
              commitSha: result.outcome.candidate.commitSha,
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
        sched.phase = "blocked";
        break;
      }
    }

    if (!allTasksTerminal(sched)) {
      const reason = stalledSchedulerReason(sched);
      deps.updateState({ phase: "blocked", lastReason: reason });
      throw new BlockedError(reason);
    }

    if (!anyTaskFailedBlockedStopped(sched)) {
      const finalValidation = await validateFinalScheduledRun(deps);
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
        schedulerActor,
      );
      await projectCompletedScheduledSourceCheckboxes(
        deps,
        sched,
        plan,
        schedulerActor,
      );
      if (schedulerActor) {
        await schedulerActor.completeRun();
      }
    }

    const landedCount = [...sched.tasks.values()].filter(
      (t) => t.status === "landed",
    ).length;
    const satisfiedCount = [...sched.tasks.values()].filter(
      (t) => t.status === "satisfied",
    ).length;
    const hasFailure = anyTaskFailedBlockedStopped(sched);
    const failureReason = hasFailure
      ? stalledSchedulerReason(sched)
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
  } finally {
    const canonical = deps.canonicalRunStore?.read();
    if (
      schedulerActor &&
      canonical?.runtime.phase === "running" &&
      Object.values(canonical.runtime.tasks).some(
        (task) => task.phase !== "completed",
      )
    ) {
      await schedulerActor.stop();
    }
    schedulerAbort.abort();
    await Promise.allSettled(runningWorkers.values());
    await deps.git.onIdle?.();
  }
}

function schedulerRunFromCanonical(
  graph: ImplementGraph,
  maxConcurrency: number,
  canonical: CanonicalRunState,
): SchedulerRun {
  const sched = createSchedulerRun(graph, maxConcurrency);
  for (const task of sched.tasks.values()) {
    const runtime = canonical.runtime.tasks[task.id];
    const execution = canonical.taskExecution[task.id];
    if (execution) {
      Object.assign(task, execution);
    }
    const canonicalFallback =
      canonical.reviewConvergence[`integration:${task.id}`];
    if (canonicalFallback) {
      const fallbackReview: ReviewConvergenceState = {
        round: canonicalFallback.round,
        findings: canonicalFallback.findings,
        outstandingIds: canonicalFallback.outstandingFindingIds,
        bestOutstandingCount: canonicalFallback.bestOutstandingCount,
        consecutiveStalledRounds: canonicalFallback.consecutiveStalledRounds,
      };
      task.integrationLedger = {
        ...(task.integrationLedger ??
          recoveredIntegrationLedger(canonicalFallback.candidate.current)),
        fallbackReview,
        fallbackCandidateFingerprint: canonicalFallback.candidate.current,
        fallbackCandidatePatch: canonicalFallback.previousCandidatePatch,
      };
    }
    if (runtime?.phase === "completed") {
      task.status = runtime.result === "landed" ? "landed" : "satisfied";
      sched.landedOrder.push(task.id);
    } else if (runtime?.phase === "waiting_rework") {
      task.status = "needs_rework";
    } else if (runtime?.phase === "candidate_ready") {
      const candidate = canonical.candidates[runtime.candidateId];
      if (candidate) {
        Object.assign(task, {
          candidateSha: candidate.commitSha,
          candidateTree: candidate.treeSha,
          candidateBaseSha: candidate.baseSha,
          sourceBaseSha: candidate.sourceBaseSha,
          trustedCheckpoint: candidate.commitSha,
          worktreePath: candidate.worktreePath,
          branchName: candidate.branchName,
        });
      }
      task.status = "approved";
    } else if (runtime?.phase === "failed" || runtime?.phase === "blocked") {
      task.status = "failed";
      task.lastReason = runtime.reason;
    }
  }
  return sched;
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
  persistCanonicalTaskExecution(deps, taskId, task);

  const workspaceManager = new TaskWorkspaceManager(
    deps.git,
    deps.paths!.worktreesDir,
  );
  let createdWorkspace = false;
  try {
    if (wasNeedsRework && !existing?.trustedCheckpoint) {
      const registered = await deps.git.listWorktrees();
      if (registered.includes(worktreePath)) {
        await workspaceManager.remove({
          taskId,
          branchName,
          worktreePath,
          baseSha,
        });
      }
    }
    const workspace = await workspaceManager.ensure(
      { taskId, branchName, worktreePath, baseSha },
      {
        existingBranch: wasNeedsRework && Boolean(existing?.trustedCheckpoint),
      },
    );
    createdWorkspace = workspace.created;
    appendEvent(deps.paths!, { type: "task_started", taskId });
  } catch (err) {
    let cleanupFailure: string | undefined;
    if (createdWorkspace) {
      try {
        await workspaceManager.remove({
          taskId,
          branchName,
          worktreePath,
          baseSha,
        });
      } catch (cleanupError) {
        cleanupFailure =
          cleanupError instanceof Error
            ? cleanupError.message
            : String(cleanupError);
      }
    }
    const reason = err instanceof Error ? err.message : String(err);
    return {
      taskId,
      outcome: {
        kind: "failed",
        reason: `Worktree setup failed: ${reason}${cleanupFailure ? `; cleanup failed: ${cleanupFailure}` : ""}`,
      },
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
  const fallbackFindings = task.integrationLedger?.fallbackReview;
  if (wasNeedsRework && fallbackFindings?.outstandingIds.length) {
    task.lastReason = typedReviewerFeedback(
      fallbackFindings.findings,
      fallbackFindings.outstandingIds,
      "Integration fallback review requested changes.",
      [],
    ).message;
  }

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

    if (success === "changed") {
      const taskJson = deps.paths
        ? readTaskJson(deps.paths, taskId)
        : undefined;
      const commitMessage =
        taskJson?.commitMessage ?? `chore: implement ${task.title}`;
      const candidate = await approvedCandidateRef({
        taskId,
        git: taskGit,
        sourceBaseSha,
        baseSha,
        branchName,
        worktreePath,
        review: taskJson?.review,
        artifactRefs: deps.paths
          ? [
              join(
                deps.paths.runDir,
                "artifacts",
                taskId,
                "implementer-result.json",
              ),
              join(
                deps.paths.runDir,
                "artifacts",
                taskId,
                "reviewer-result.json",
              ),
            ]
          : [],
        protectedPaths: taskPlanArtifacts,
        assessedAt: new Date().toISOString(),
        reviewContext: {
          contextId: deps.executionManifest
            ? buildReviewResponsibilityContext(deps.executionManifest).contextId
            : undefined,
          admittedFindingIds: deps.canonicalRunStore
            ?.read()
            .reviewConvergence[taskId]?.findings.map((finding) => finding.id),
        },
      });
      persistCanonicalTaskExecution(deps, taskId, task);
      return {
        taskId,
        outcome: { kind: "approved", candidate, commitMessage },
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
    while (
      !validation.ok &&
      task.selfHealAttempts < MAX_INTEGRATION_SELF_HEAL_ATTEMPTS
    ) {
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

async function transplantMovedTaskCandidate(args: {
  deps: OrchestratorDeps;
  sched: SchedulerRun;
  attempt: CanonicalRunState["integrationAttempts"][number];
  candidate: CandidateRef;
  actualTargetHead: string;
  planArtifacts: string[];
}): Promise<void> {
  const { deps, sched, attempt, candidate, actualTargetHead, planArtifacts } =
    args;
  if (attempt.owner.kind !== "task") {
    throw new BlockedError(
      "Overall-review candidate target movement requires explicit overall rework.",
    );
  }
  const task = sched.tasks.get(attempt.owner.taskId);
  if (!task) {
    throw new BlockedError(
      `Target moved but task ${attempt.owner.taskId} is unavailable for candidate transplantation.`,
    );
  }
  const candidateDelta = await deps.git.diffRange(
    candidate.baseSha,
    candidate.commitSha,
  );
  const transplanted = await transplantTaskCandidate(
    deps,
    task,
    attempt.owner.taskId,
    candidate.commitSha,
    candidateDelta,
    actualTargetHead,
    planArtifacts,
  );
  if (!transplanted.ok) {
    throw new BlockedError(
      `Target moved and candidate transplantation failed: ${transplanted.reason}`,
    );
  }
  const taskId = attempt.owner.taskId;
  const transplantedCandidate = await approvedCandidateRef({
    taskId,
    git: deps.git.forWorktree(task.worktreePath!, await deps.git.root()),
    sourceBaseSha: candidate.sourceBaseSha,
    baseSha: actualTargetHead,
    branchName: task.branchName!,
    worktreePath: task.worktreePath!,
    review: {
      lastDecision: "reviewed",
      convergence: {
        epoch: 1,
        closedEpochs: [],
        state: {
          round: 0,
          findings: [],
          outstandingIds: [],
          bestOutstandingCount: 0,
          consecutiveStalledRounds: 0,
        },
        previousCandidate: candidate.commitSha,
        latestEvidence:
          "Candidate transplanted onto the moved target; anchored regression review is required.",
      },
    },
    artifactRefs: [],
    protectedPaths: planArtifacts,
    assessedAt: new Date().toISOString(),
  });
  deps.canonicalRunStore?.updateSync((state) => ({
    ...state,
    candidates: {
      ...state.candidates,
      [transplantedCandidate.id]: transplantedCandidate,
    },
    taskExecution: {
      ...state.taskExecution,
      [taskId]: {
        ...(state.taskExecution[taskId] ?? {
          discardedBundles: [],
          implementationRound: 0,
        }),
        sourceBaseSha: transplantedCandidate.sourceBaseSha,
        candidateBaseSha: transplantedCandidate.baseSha,
        candidateSha: transplantedCandidate.commitSha,
        candidateTree: transplantedCandidate.treeSha,
        trustedCheckpoint: transplantedCandidate.commitSha,
        worktreePath: transplantedCandidate.worktreePath,
        branchName: transplantedCandidate.branchName,
      },
    },
  }));
  task.status = "needs_rework";
  task.lastReason =
    "Target moved; candidate was transplanted and requires anchored regression review.";
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
  await deps.git.removeWorktree(task.worktreePath);
  await deps.git.deleteTaskBranch(task.branchName);
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
  verificationError?: string;
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
  } catch (initialError) {
    const recoveryErrors: string[] = [];
    try {
      await deps.git.cherryPickAbort();
    } catch (error) {
      recoveryErrors.push(`cherry-pick abort: ${errorMessage(error)}`);
    }
    try {
      await deps.git.resetHard(preIntegrationHead);
    } catch (error) {
      recoveryErrors.push(`reset: ${errorMessage(error)}`);
    }
    try {
      await deps.git.restoreWorktreeFromIndexExcept(planArtifacts);
    } catch (error) {
      recoveryErrors.push(`worktree restore: ${errorMessage(error)}`);
    }
    try {
      restorePlanArtifacts(planArtifacts, planArtifactSnapshot);
    } catch (error) {
      recoveryErrors.push(`plan artifact restore: ${errorMessage(error)}`);
    }
    let currentHead: string | undefined;
    try {
      currentHead = await deps.git.head();
    } catch (error) {
      recoveryErrors.push(`HEAD verification: ${errorMessage(error)}`);
    }
    let exactRestored = false;
    let verificationError: string | undefined;
    try {
      exactRestored = !(await snapshotChanged(
        deps.git,
        snapshot,
        planArtifacts,
      ));
    } catch (error) {
      verificationError = errorMessage(error);
    }
    return {
      headRestored: currentHead === preIntegrationHead,
      exactRestored,
      currentHead,
      verificationError: [
        errorMessage(initialError),
        ...recoveryErrors,
        verificationError,
      ]
        .filter((value): value is string => Boolean(value))
        .join("; "),
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
  const verificationError = rollback.verificationError
    ? ` Verification error: ${rollback.verificationError}`
    : "";
  if (rollback.headRestored) {
    return `${reason}\n\nWARNING: rollback restored HEAD to ${preIntegrationHead.slice(0, 12)}, but exact index/worktree restoration could not be proved.${verificationError}`;
  }
  const at = rollback.currentHead
    ? ` HEAD is at ${rollback.currentHead.slice(0, 12)}.`
    : "";
  return `${reason}\n\nWARNING: rollback did not restore HEAD to ${preIntegrationHead.slice(0, 12)}; an integration commit may still be present on the branch.${at}${verificationError}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
  const tree = await deps.git.tree();
  const head = await deps.git.head();
  const stagedFingerprint = await deps.git.stagedFingerprint();
  const worktreeFingerprint =
    await deps.git.worktreeFingerprintExcept(planArtifacts);
  const stagedNameStatus = await deps.git.stagedNameStatus();
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
  if (task.selfHealAttempts >= MAX_INTEGRATION_SELF_HEAL_ATTEMPTS) {
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
    const path = (line.slice(3).split(" -> ").pop() ?? "").trim();
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
  return nameStatus
    .split("\n")
    .map((line) => line.trim().split("\t").at(-1))
    .filter((path): path is string => Boolean(path));
}

function normalizeStatusPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

function isPlanArtifactPath(
  path: string,
  planArtifacts: string[],
  planPath: string,
): boolean {
  const normalized = normalizeStatusPath(path);
  return planArtifacts.some((artifact) => {
    if (normalized === normalizeStatusPath(artifact)) {
      return true;
    }
    return (
      isAbsolute(artifact) &&
      normalized === normalizeStatusPath(relative(dirname(planPath), artifact))
    );
  });
}

function isPackageManagerFile(path: string): boolean {
  return [
    "package-lock.json",
    "npm-shrinkwrap.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    ".npmrc",
  ].includes(path.split("/").pop() ?? path);
}

function indicatesDependencyInstallation(
  result: IntegrationSelfHealResult | undefined,
): boolean {
  return Boolean(
    result?.commands?.some((command) =>
      /^(npm|pnpm|yarn)\s+(install|ci|add)/.test(command.trim()),
    ),
  );
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
    lines.push(`- ${node.id}: ${node.title} (plan ${node.planIndex}${deps})`);
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
      const result = await runValidationCommand(
        command,
        await deps.git.root(),
        deps.signal,
      );
      if (result.cancelled || deps.signal?.aborted) {
        throw new StoppedError();
      }
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

async function validateFinalScheduledRun(
  deps: OrchestratorDeps,
): Promise<ValidationResult> {
  const commands = await resolveValidationCommands(deps);
  for (const command of commands) {
    const result = await runValidationCommand(
      command,
      await deps.git.root(),
      deps.signal,
    );
    throwIfValidationStopped(deps, result);
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

function integrationPipelineHash(commands: ValidationCommand[]): string {
  return createHash("sha256").update(JSON.stringify(commands)).digest("hex");
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
  signal?: AbortSignal,
): Promise<CommandResult> {
  const result =
    command.kind === "shell"
      ? await runCommand(command.command, [], {
          cwd,
          env: process.env,
          timeout: VALIDATION_TIMEOUT_MS,
          signal,
          shell: true,
        })
      : await runCommand(command.file, command.args, {
          cwd,
          env: process.env,
          timeout: VALIDATION_TIMEOUT_MS,
          signal,
        });
  return {
    command: command.display,
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    cancelled: result.cancelled,
    failureKind: result.failureKind,
    cause: result.cause,
    stdout: result.stdout,
    stderr: result.signal
      ? `${result.stderr}\nTerminated by signal ${result.signal}`
      : result.stderr,
  };
}

function throwIfValidationStopped(
  deps: OrchestratorDeps,
  result: CommandResult,
): void {
  if (result.cancelled || deps.signal?.aborted || deps.shouldStop()) {
    throw new StoppedError();
  }
}

async function admitReviewProposals(args: {
  deps: OrchestratorDeps;
  scope: "task" | "overall" | "integration";
  taskId: string;
  compiledContract: string;
  candidateIdentity: string;
  latestDeltaPaths: string[];
  proposals: Array<{
    proposalId: string;
    summary: string;
    evidence: string;
    requiredChange: string;
    acceptanceCriteria: string[];
    basis:
      | { kind: "requirement"; requirementIds: string[] }
      | {
          kind: "candidate_regression";
          changedPaths: string[];
          causalEvidence: string;
        }
      | { kind: "correctness_invariant"; invariant: string };
  }>;
}): Promise<ReturnType<typeof evaluateFindingAdmission>> {
  const requirements = args.deps.executionManifest
    ? buildReviewResponsibilityContext(args.deps.executionManifest).requirements
    : [];
  const proposalBatchId = createProposalBatchId({
    scope: args.scope,
    contextId: args.compiledContract,
    candidateIdentity: args.candidateIdentity,
    latestDeltaPaths: args.latestDeltaPaths,
    proposals: args.proposals,
  });
  const prompt = buildFindingAdmissionPrompt({
    scope: args.scope,
    compiledContract: args.compiledContract,
    requirementIds: requirements,
    candidateIdentity: args.candidateIdentity,
    latestDeltaPaths: args.latestDeltaPaths,
    proposalBatchId,
    proposals: args.proposals,
  });
  let result: SubagentResult;
  try {
    const id = await args.deps.subagents.spawn({
      type: args.deps.roles.reviewer.type,
      ownerRole: "admission",
      prompt,
      description: `admit ${args.scope} review findings`,
      model: args.deps.roles.reviewer.model,
      thinking: "low",
      role: "admission",
      stage:
        args.scope === "overall"
          ? "overall_admission"
          : args.scope === "integration"
            ? "integration_admission"
            : "task_admission",
      taskId: args.taskId,
      cwd: await args.deps.git.root(),
      systemPrompt: FINDING_ADMISSION_SYSTEM_PROMPT,
      systemPromptMode: "replace",
      noTools: true,
      excludeTools: [
        "read",
        "bash",
        "grep",
        "find",
        "ls",
        "explore",
        "lsp",
        "edit",
        "write",
        "Agent",
        "get_subagent_result",
        "steer_subagent",
        "propose_papercut",
      ],
      completion: {
        description: "Submit finding admission dispositions.",
        schema: findingAdmissionBatchSchema,
      },
    });
    result = await args.deps.subagents.waitFor(id, args.deps.signal);
  } catch (error) {
    result = {
      status: "failed",
      error: `Adjudicator unavailable: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const parsed =
    result.status === "completed"
      ? parseAdmissionResult(result.result)
      : undefined;
  return evaluateFindingAdmission({
    scope: args.scope,
    proposalBatchId,
    proposals: args.proposals,
    knownRequirementIds: requirements.map((requirement) => requirement.id),
    ...(parsed?.ok
      ? { adjudication: parsed.result }
      : {
          failureReason:
            result.status === "completed"
              ? `Adjudication completion was malformed: ${parsed?.reason ?? "unknown error"}`
              : `Adjudication ${result.status}: ${result.error}`,
        }),
  });
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
  const candidateFingerprint = await deps.git.stagedFingerprint();
  const previousCandidateFingerprint =
    schedulerTask?.integrationLedger?.fallbackCandidateFingerprint;
  const previousPatch =
    schedulerTask?.integrationLedger?.fallbackCandidatePatch;
  const anchoredDelta =
    fallbackState && previousPatch !== undefined
      ? await deps.git.stagedDeltaFromPatch(previousPatch)
      : undefined;
  const latestDeltaPaths = anchoredDelta
    ? parseNameStatusPaths(anchoredDelta.nameStatus)
    : [];
  const ownerRework = deps.canonicalRunStore
    ?.read()
    .reviewConvergence[taskId]?.latestRework?.filter((completion) =>
      outstanding?.some((finding) => finding.id === completion.findingId),
    )
    .map((completion) => ({
      id: completion.findingId,
      status: completion.status,
      evidence: completion.evidence,
      changedPaths: completion.changedPaths,
      verification: completion.verification,
    }));
  const prompt = buildIntegrationReviewerPrompt({
    diff,
    planArtifacts,
    outstandingFindings: outstanding,
    previousCandidate: previousCandidateFingerprint,
    currentCandidate: candidateFingerprint,
    latestDelta: anchoredDelta?.diff,
    reworkCompletions: ownerRework,
  });

  const id = await deps.subagents.spawn({
    type: deps.roles.reviewer.type,
    prompt,
    description: `integration review ${taskId}`,
    model: deps.roles.reviewer.model,
    thinking: deps.roles.reviewer.thinking,
    role: "reviewer",
    stage: "integration_review",
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
    const candidatePatch = await deps.git.stagedDiff();
    if (!fallbackState) {
      const parsed = parseInitialReviewResult(result.result, {
        requireProposalBasis: true,
      });
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
      const integrationEpoch = schedulerTask.integrationLedger.epoch;
      if (parsed.result.verdict === "approved") {
        const approvedState = createReviewConvergenceState({
          drafts: [],
          idPrefix: "IF",
        });
        const proposalBatchId = createProposalBatchId({
          scope: "integration",
          contextId: `Integration fallback review for ${taskId}.`,
          candidateIdentity: candidateFingerprint,
          latestDeltaPaths: [],
          proposals: [],
        });
        const admission = evaluateFindingAdmission({
          scope: "integration",
          proposalBatchId,
          proposals: [],
          knownRequirementIds: [],
          adjudication: { proposalBatchId, dispositions: [] },
        });
        await persistCanonicalIntegrationAdmission({
          deps,
          taskId,
          epoch: integrationEpoch,
          candidateIdentity: candidateFingerprint,
          latestDeltaPaths: [],
          previousCandidatePatch: candidatePatch,
          proposals: [],
          admission,
          state: approvedState,
        });
        return { ok: true };
      }
      const initialProposals = parsed.result.findings.map(
        (proposal, index) => ({
          ...proposal,
          proposalId: `E${integrationEpoch}P${index + 1}`,
        }),
      );
      const admission = await admitReviewProposals({
        deps,
        scope: "integration",
        taskId,
        compiledContract: `Integration fallback review for ${taskId}.`,
        candidateIdentity: candidateFingerprint,
        latestDeltaPaths: [],
        proposals: initialProposals,
      });
      schedulerTask.integrationLedger = {
        ...schedulerTask.integrationLedger,
        fallbackReview: createReviewConvergenceState({
          drafts: admission.admittedDrafts,
          idPrefix: "IF",
        }),
        fallbackCandidateFingerprint: candidateFingerprint,
        fallbackCandidatePatch: candidatePatch,
      };
      persistIntegrationState(deps, taskId, schedulerTask);
      persistCanonicalTaskExecution(deps, taskId, schedulerTask);
      await persistCanonicalIntegrationAdmission({
        deps,
        taskId,
        candidateIdentity: candidateFingerprint,
        latestDeltaPaths: [],
        previousCandidatePatch: candidatePatch,
        epoch: integrationEpoch,
        proposals: initialProposals,
        admission,
        state: schedulerTask.integrationLedger.fallbackReview!,
      });
      if (admission.admittedDrafts.length === 0) {
        return { ok: true };
      }
      return {
        ok: false,
        reason: admission.admittedDrafts
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
      const regressionProposals = parsed.result.regressions.map(
        (regression, index) => ({
          ...regression,
          proposalId: `E${schedulerTask.integrationLedger!.epoch}R${fallbackState.round + 1}P${index + 1}`,
          basis: {
            kind: "candidate_regression" as const,
            changedPaths: regression.changedPaths,
            causalEvidence: regression.causalEvidence,
          },
        }),
      );
      const admission = await admitReviewProposals({
        deps,
        scope: "integration",
        taskId,
        compiledContract: `Integration fallback review for ${taskId}.`,
        candidateIdentity: candidateFingerprint,
        latestDeltaPaths,
        proposals: regressionProposals,
      });
      const admittedRegressionIds = new Set(
        admission.admittedDrafts.map((draft) => draft.proposalId),
      );
      const update = applyAnchoredReview({
        state: fallbackState,
        review: {
          ...parsed.result,
          regressions: regressionProposals.filter((proposal) =>
            admittedRegressionIds.has(proposal.proposalId),
          ),
        },
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
      persistCanonicalTaskExecution(deps, taskId, schedulerTask);
      await persistCanonicalIntegrationAdmission({
        deps,
        taskId,
        epoch: schedulerTask.integrationLedger.epoch,
        candidateIdentity: candidateFingerprint,
        previousCandidate: previousCandidateFingerprint,
        latestDeltaPaths,
        previousCandidatePatch: candidatePatch,
        proposals: regressionProposals,
        admission,
        state: update.state,
      });
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
  latestRework?: Array<{
    findingId: string;
    status: "addressed" | "not_addressed";
    evidence: string;
    changedPaths: string[];
    verification: Array<{ command: string; result: string; rationale: string }>;
  }>;
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

async function overallCandidateRef(args: {
  overall: OverallReviewState;
  runId: string;
  assessedAt: string;
  evidenceRefs: string[];
}): Promise<CandidateRef> {
  const commitSha = args.overall.candidate.trustedCheckpoint;
  const treeSha = args.overall.candidate.candidateTree;
  if (!commitSha || !treeSha) {
    throw new BlockedError(
      "approved overall candidate has no trusted checkpoint",
    );
  }
  const candidateId = `overall:${args.runId}:${commitSha}`;
  return {
    id: candidateId,
    sourceBaseSha: args.overall.candidate.sourceBaseSha,
    baseSha: args.overall.baseSha,
    commitSha,
    treeSha,
    branchName: args.overall.branchName,
    worktreePath: args.overall.worktreePath,
    reviewReceipt: {
      id: `overall-review:${candidateId}`,
      candidateId,
      candidateCommitSha: commitSha,
      candidateTreeSha: treeSha,
      verdict: "approved",
      convergence: {
        round: args.overall.convergence.round,
        outstandingFindingIds: [...args.overall.convergence.outstandingIds],
        bestOutstandingCount: args.overall.convergence.bestOutstandingCount,
        evidenceRefs: args.evidenceRefs,
      },
      assessedAt: args.assessedAt,
    },
  };
}

function deferredConcernsForOverall(deps: OrchestratorDeps): Array<{
  id: string;
  summary: string;
  evidence: string;
  basis: unknown;
  sourceScope?: "task" | "integration";
  sourceCandidate?: string;
  rationale?: string;
}> {
  if (!deps.canonicalRunStore) {
    return [];
  }
  return Object.values(deps.canonicalRunStore.read().reviewConvergence)
    .flatMap((review) => review.deferredConcerns)
    .filter(
      (concern) =>
        concern.sourceScope !== "integration" ||
        Boolean(concern.sourceCandidate),
    );
}

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
  const responsibilityContext = args.deps.executionManifest
    ? buildReviewResponsibilityContext(args.deps.executionManifest)
    : undefined;
  if (responsibilityContext) {
    persistOverallArtifact(
      args.deps.paths,
      1,
      "responsibility-context.json",
      `${JSON.stringify(responsibilityContext, null, 2)}\n`,
    );
  }
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
    formatExecutionManifestSummary(
      args.deps.executionManifest,
      responsibilityContext,
    ),
    args.landedTasks.length
      ? `## Landed Tasks\n\n${args.landedTasks.map((task) => `- ${task.id}: ${task.title}${task.commitSha ? ` @ ${task.commitSha.slice(0, 7)}` : ""}`).join("\n")}`
      : "",
    deferredConcernsForOverall(args.deps).length
      ? `## Deferred Review Concerns (Advisory)\n\n${deferredConcernsForOverall(
          args.deps,
        )
          .map(
            (concern) =>
              `- ${concern.id} [${concern.sourceScope ?? "task"}]${concern.sourceCandidate ? ` @ ${concern.sourceCandidate}` : ""}: ${concern.summary}\n  Evidence: ${concern.evidence}\n  Rationale: ${concern.rationale ?? "Deferred for whole-feature review."}`,
          )
          .join("\n")}`
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

function persistCanonicalOverallReview(
  deps: OrchestratorDeps,
  overall: OverallReviewState,
  status: OverallReviewJson["status"],
): void {
  if (!deps.canonicalRunStore) {
    return;
  }
  const stage =
    status === "approved" || status === "integrating"
      ? "approved"
      : status === "stalled" || status === "blocked"
        ? "stalled"
        : status === "needs_rework"
          ? "rework"
          : "initial_review";
  if (stage === "stalled" && overall.convergence.outstandingIds.length === 0) {
    return;
  }
  if (stage === "rework" && overall.convergence.outstandingIds.length === 0) {
    return;
  }
  const review: CanonicalRunState["reviewConvergence"][string] = {
    owner: { kind: "overall" },
    stage,
    candidate: {
      current:
        overall.candidate.trustedCheckpoint ??
        overall.candidate.candidateSha ??
        overall.baseSha,
      previous: overall.previousCandidate,
      latestDeltaPaths: [],
    },
    epoch: overall.epoch,
    round: overall.convergence.round,
    proposals: [],
    admissions: [],
    findings: overall.convergence.findings,
    outstandingFindingIds: overall.convergence.outstandingIds,
    deferredConcerns: [],
    observationIds: [],
    bestOutstandingCount: overall.convergence.bestOutstandingCount,
    consecutiveStalledRounds: overall.convergence.consecutiveStalledRounds,
    latestRework: overall.latestRework,
    evidenceRefs: [],
    previousCandidatePatch: overall.previousCandidatePatch,
    latestEvidence: overall.latestEvidence,
    verificationFailures: [],
  };
  deps.canonicalRunStore.updateSync((state) => ({
    ...state,
    reviewConvergence: { ...state.reviewConvergence, overall: review },
  }));
  projectReviewProgress(deps, review);
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
        latestRework: overall.latestRework,
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
  persistCanonicalOverallReview(deps, overall, status);
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
  const deferredConcerns = deferredConcernsForOverall(deps);
  const prompt = buildInitialOverallReviewPrompt({
    planContext: args.planContext,
    candidateContext: `Candidate identity: ${args.candidate}\n\n${args.fullDiff}`,
    worktreePath: await deps.git.root(),
    deferredConcerns,
  });
  persistOverallArtifact(deps.paths, 1, "reviewer-prompt.md", prompt);
  const id = await deps.subagents.spawn({
    type: deps.roles.reviewer.type,
    prompt,
    description: "overall review",
    model: deps.roles.reviewer.model,
    thinking: deps.roles.reviewer.thinking,
    role: "reviewer",
    stage: "initial_overall_review",
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
    deferredConcernIds: deferredConcerns.map((concern) => concern.id),
  });
  if (!parsed.ok) {
    return {
      ok: false,
      reason: `Invalid initial overall review: ${parsed.reason}`,
    };
  }
  await recordPapercuts(deps, result.result, "overall-reviewer");
  const proposals =
    parsed.result.verdict === "changes_requested" ? parsed.result.findings : [];
  const admission = proposals.length
    ? await admitReviewProposals({
        deps,
        scope: "overall",
        taskId: "overall-review",
        compiledContract: args.planContext,
        candidateIdentity: args.candidate,
        latestDeltaPaths: [],
        proposals,
      })
    : undefined;
  return {
    ok: true,
    convergence: createReviewConvergenceState({
      drafts: admission?.admittedDrafts ?? [],
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
        deferredConcerns: deferredConcernsForOverall(deps),
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
        reworkCompletions: state.latestRework?.map((completion) => ({
          id: completion.findingId,
          status: completion.status,
          evidence: completion.evidence,
          changedPaths: completion.changedPaths,
          verification: completion.verification,
        })),
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
    stage: args.initial ? "initial_overall_review" : "anchored_overall_review",
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
      deferredConcernIds: deferredConcernsForOverall(deps).map(
        (concern) => concern.id,
      ),
    });
    if (!parsed.ok) {
      return {
        ok: false,
        reason: `Invalid initial overall review: ${parsed.reason}`,
      };
    }
    const proposals =
      parsed.result.verdict === "changes_requested"
        ? parsed.result.findings
        : [];
    const admission = proposals.length
      ? await admitReviewProposals({
          deps,
          scope: "overall",
          taskId: "overall-review",
          compiledContract: args.planContext,
          candidateIdentity: candidate,
          latestDeltaPaths: args.latestDeltaPaths,
          proposals,
        })
      : undefined;
    state.convergence = createReviewConvergenceState({
      drafts: admission?.admittedDrafts ?? [],
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
    const regressionProposals = parsed.result.regressions.map(
      (regression, index) => ({
        ...regression,
        proposalId: `E${state.epoch}R${state.convergence.round + 1}P${index + 1}`,
        basis: {
          kind: "candidate_regression" as const,
          changedPaths: regression.changedPaths,
          causalEvidence: regression.causalEvidence,
        },
      }),
    );
    const admission = regressionProposals.length
      ? await admitReviewProposals({
          deps,
          scope: "overall",
          taskId: "overall-review",
          compiledContract: args.planContext,
          candidateIdentity: candidate,
          latestDeltaPaths: args.latestDeltaPaths,
          proposals: regressionProposals,
        })
      : undefined;
    const admittedRegressionIds = new Set(
      admission?.admittedDrafts.map((draft) => draft.proposalId) ?? [],
    );
    const admittedRegressions = regressionProposals.filter((proposal) =>
      admittedRegressionIds.has(proposal.proposalId),
    );
    const update =
      state.convergence.outstandingIds.length === 0
        ? openRegressionReviewEpoch({
            closedState: state.convergence,
            regressions: admittedRegressions,
            latestDeltaPaths: args.latestDeltaPaths,
            idPrefix: "O",
          })
        : applyAnchoredReview({
            state: state.convergence,
            review: { ...parsed.result, regressions: admittedRegressions },
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
  schedulerActor?: SchedulerActor,
): Promise<void> {
  throwIfStopped(deps);
  if (
    schedulerActor &&
    deps.canonicalRunStore?.read().runtime.overall.phase === "integrating"
  ) {
    let completion = await schedulerActor.nextCompletion();
    while (
      completion.kind !== "integration" ||
      completion.owner.kind !== "overall"
    ) {
      completion = await schedulerActor.nextCompletion();
    }
    const overall = deps.canonicalRunStore.read().runtime.overall;
    if (overall.phase === "completed") {
      return;
    }
    if (overall.phase !== "waiting_rework") {
      throw new BlockedError(
        "Overall integration is paused; the approved candidate is retained for recovery.",
      );
    }
  }
  if (!(await deps.git.isCleanExcept(planArtifacts))) {
    throw new BlockedError("dirty worktree before final review");
  }
  const mainHead = await deps.git.head();
  const retainedOverall = deps.paths
    ? readRunJson(deps.paths)?.overallReview
    : undefined;
  if (mainHead === runBaseSha && !retainedOverall) {
    if (schedulerActor) {
      await schedulerActor.completeOverallReview();
    }
    return;
  }
  if (
    schedulerActor &&
    deps.canonicalRunStore?.read().runtime.overall.phase === "completed"
  ) {
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
      latestRework: retained.convergence.latestRework,
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
      const approvedOverall: OverallReviewState = {
        baseSha: mainHead,
        branchName: "main",
        worktreePath: mainRoot,
        candidate: {
          sourceBaseSha: mainHead,
          candidateBaseSha: mainHead,
          branchName: "main",
          candidateSha: mainHead,
          trustedCheckpoint: mainHead,
          candidateTree: await deps.git.treeAt(mainHead),
          discardedBundles: [],
        },
        convergence: initial.convergence,
        closedEpochs: [],
        epoch: 1,
        latestEvidence: "initial overall review approved",
      };
      persistCanonicalOverallReview(deps, approvedOverall, "approved");
      deps.updateState((previous) =>
        checkpointPatch(previous, "Final overall review approved"),
      );
      if (schedulerActor) {
        await schedulerActor.completeOverallReview();
      }
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
      await deps.git.deleteTaskBranch(branchName);
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
    const targetHead = await deps.git.head();
    if (targetHead !== overall.baseSha) {
      const candidateSha = overall.candidate.trustedCheckpoint;
      if (!candidateSha) {
        throw new BlockedError("overall candidate has no trusted checkpoint");
      }
      const transplantPatch = await candidateGit.diffRange(
        overall.baseSha,
        candidateSha,
      );
      await candidateGit.resetHard(targetHead);
      const transplanted = await candidateGit.applyPatch(transplantPatch);
      if (transplanted.exitCode !== 0) {
        throw new BlockedError(
          transplanted.stderr ||
            transplanted.stdout ||
            "could not transplant overall candidate onto the moved target",
        );
      }
      overall.baseSha = targetHead;
      const checkpoint = await checkpointCandidate(candidateGit, {
        ...overall.candidate,
        candidateBaseSha: targetHead,
        candidateSha: targetHead,
        candidateTree: await candidateGit.treeAt(targetHead),
        trustedCheckpoint: targetHead,
      });
      if (checkpoint.result && checkpoint.result.exitCode !== 0) {
        throw new BlockedError(
          checkpoint.result.stderr ||
            checkpoint.result.stdout ||
            "could not checkpoint transplanted overall candidate",
        );
      }
      overall.candidate = checkpoint.candidate;
      overall.previousCandidate = undefined;
      overall.previousCandidatePatch = undefined;
      overall.latestEvidence =
        "Target moved; overall candidate was transplanted and requires regression review.";
      persistOverallReviewState(
        deps,
        overall,
        "needs_rework",
        overall.latestEvidence,
      );
    }
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
      findingCompletions: outstanding.map((finding) => ({
        ...finding,
        sourceScope: "task_review" as const,
      })),
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
      stage: "overall_rework",
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
        ? parseOverallReworkResult(result.result, {
            expectedFindingIds: outstanding.map((finding) => finding.id),
          })
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
    (
      overall as OverallReviewState & {
        latestRework?: Array<{
          findingId: string;
          status: "addressed" | "not_addressed";
          evidence: string;
          changedPaths: string[];
          verification: Array<{
            command: string;
            result: string;
            rationale: string;
          }>;
        }>;
      }
    ).latestRework = parsedRework.result.findingCompletions?.map(
      (completion) => ({
        findingId: completion.id,
        status: completion.status,
        evidence: completion.evidence,
        changedPaths: completion.changedPaths,
        verification: completion.verification,
      }),
    );
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
      const validation = await runValidationCommand(
        command,
        worktreePath,
        deps.signal,
      );
      throwIfValidationStopped(deps, validation);
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
    if (!schedulerActor) {
      throw new BlockedError(
        "overall candidate integration requires the managed scheduler",
      );
    }
    const canonicalCandidate = await overallCandidateRef({
      overall,
      runId: deps.runId ?? "overall",
      assessedAt: new Date().toISOString(),
      evidenceRefs: [
        "implementer-result.json",
        "reviewer-result.json",
        "finding-transition.json",
      ].map((filename) =>
        join(
          deps.paths?.runDir ?? dirname(worktreePath),
          "overall-review",
          "rounds",
          String(Math.max(1, attempt)).padStart(3, "0"),
          filename,
        ),
      ),
    });
    await schedulerActor.recordOverallCandidate(canonicalCandidate);
    const started = await schedulerActor.requestOverallIntegration({
      attemptId: `integration:${deps.runId ?? "overall"}:overall:${Date.now()}`,
      pipelineHash: integrationPipelineHash(
        await resolveValidationCommands(deps),
      ),
      protectedArtifactHashes: await protectedArtifactHashes(
        deps.git,
        planArtifacts,
      ),
    });
    if (!started) {
      throw new BlockedError("overall candidate integration was not scheduled");
    }
    let completion = await schedulerActor.nextCompletion();
    while (
      completion.kind !== "integration" ||
      completion.owner.kind !== "overall"
    ) {
      completion = await schedulerActor.nextCompletion();
    }
    const canonicalAfterIntegration = deps.canonicalRunStore?.read();
    const overallRuntime = canonicalAfterIntegration?.runtime.overall;
    if (overallRuntime?.phase === "waiting_rework") {
      const integrationReason =
        canonicalAfterIntegration?.integrationAttempts.find(
          (entry) =>
            entry.id === completion.attemptId && entry.owner.kind === "overall",
        )?.pausedReason;
      overall.latestEvidence =
        integrationReason ??
        "Overall integration requires rework; the approved candidate was retained.";
      persistOverallReviewState(
        deps,
        overall,
        "needs_rework",
        overall.latestEvidence,
      );
      continue;
    }
    if (
      completion.outcome !== "landed" ||
      overallRuntime?.phase !== "completed"
    ) {
      overall.latestEvidence =
        "Overall integration paused; the approved candidate was retained for recovery.";
      persistOverallReviewState(
        deps,
        overall,
        "blocked",
        overall.latestEvidence,
      );
      throw new BlockedError(overall.latestEvidence);
    }
    const overallCleanupDebt = {
      id: `overall-review:${canonicalCandidate.id}`,
      kind: "overall-review-worktree",
      reason: "overall candidate landed; owned workspace cleanup is pending",
    };
    await schedulerActor.recordCleanupDebt(overallCleanupDebt);
    try {
      await deps.git.removeWorktree(worktreePath);
      await deps.git.deleteTaskBranch(branchName);
      await schedulerActor.completeCleanup(overallCleanupDebt.id);
    } catch {
      // Canonical cleanup debt retains ownership for the next resume.
    }
    deps.updateState((previous) =>
      checkpointPatch(previous, "Final overall review approved"),
    );
    if (deps.paths) {
      appendEvent(deps.paths, { type: "overall_review_approved" });
    }
    return;
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
  lines.push("Scheduler blocked:");

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

async function protectedArtifactHashes(
  git: GitClient,
  paths: string[],
): Promise<Record<string, string>> {
  const root = await git.root();
  return Object.fromEntries(
    paths.map((path) => {
      const absolute = isAbsolute(path) ? path : join(root, path);
      const value = existsSync(absolute)
        ? readFileSync(absolute, "utf-8")
        : undefined;
      return [
        path,
        createHash("sha256")
          .update(value === undefined ? "missing\0" : `content\0${value}`)
          .digest("hex"),
      ];
    }),
  );
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

function updateSchedulerState(
  deps: OrchestratorDeps,
  sched: SchedulerRun,
): void {
  const tasks: ScheduledTaskState[] = [];
  const activeAgentIds: string[] = [];
  const reviews = deps.canonicalRunStore?.read().reviewConvergence ?? {};
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
      status: task.status as ScheduledTaskState["status"],
      blockedReason: getBlockedReason(task, sched),
      worktreePath: task.worktreePath,
      landedCommitSha: task.landedCommitSha,
      candidateSha: taskMeta?.candidateSha ?? task.candidateSha,
      lastTransition: taskMeta?.lastTransition,
      activeAgentIds: task.activeAgentIds,
      activeAgentRefs: task.activeAgentRefs,
      review: taskMeta?.review,
      reviewProgress: reviewProgressFor(reviews[task.id]),
      integrationReviewProgress: reviewProgressFor(
        reviews[`integration:${task.id}`],
      ),
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
    overallReviewProgress: reviewProgressFor(
      Object.values(reviews).find((review) => review.owner.kind === "overall"),
    ),
  });
}

function reviewProgressFor(
  review: CanonicalRunState["reviewConvergence"][string] | undefined,
): ReviewProgress | undefined {
  if (!review) {
    return undefined;
  }
  const findingIds = new Map(
    review.findings.map((finding) => [finding.proposalId, finding.id]),
  );
  const admissions = review.admissions;
  const admittedIds = admissions.flatMap((admission) =>
    admission.disposition === "admit"
      ? [admission.findingId ?? findingIds.get(admission.proposalId)].filter(
          (id): id is string => Boolean(id),
        )
      : [],
  );
  const rework = review.latestRework ?? [];
  const resolvedIds = review.findings
    .filter(
      (finding) =>
        finding.origin === "initial" &&
        !review.outstandingFindingIds.includes(finding.id),
    )
    .map((finding) => finding.id);
  return {
    scope: review.owner.kind,
    stage: review.stage,
    epoch: review.epoch,
    round: review.round,
    previousCandidate: review.candidate.previous,
    currentCandidate: review.candidate.current,
    admittedIds,
    resolvedIds,
    deferredIds: admissions
      .filter((admission) => admission.disposition === "defer")
      .map((admission) => admission.proposalId),
    rejectedIds: admissions
      .filter(
        (admission) =>
          admission.disposition === "reject" ||
          admission.disposition === "demote",
      )
      .map((admission) => admission.proposalId),
    addressedIds: rework
      .filter((completion) => completion.status === "addressed")
      .map((completion) => completion.findingId),
    notAddressedIds: rework
      .filter((completion) => completion.status === "not_addressed")
      .map((completion) => completion.findingId),
    unresolvedIds: review.outstandingFindingIds,
    newRegressionIds: review.findings
      .filter(
        (finding) =>
          finding.origin === "regression" &&
          finding.introducedRound === review.round,
      )
      .map((finding) => finding.id),
    previousOutstandingCount: review.previousOutstandingCount,
    currentOutstandingCount: review.outstandingFindingIds.length,
    bestOutstandingCount: review.bestOutstandingCount,
    consecutiveStalledRounds: review.consecutiveStalledRounds,
    latestEvidence: review.latestEvidence ?? review.evidenceRefs.at(-1),
  };
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

function projectReviewProgress(
  deps: OrchestratorDeps,
  review: CanonicalRunState["reviewConvergence"][string],
): void {
  const progress = reviewProgressFor(review);
  if (!progress) {
    return;
  }
  deps.updateState((prev) => {
    if (review.owner.kind === "overall") {
      return { overallReviewProgress: progress };
    }
    const taskId = review.owner.taskId;
    return {
      tasks: prev.tasks?.map((task) =>
        task.id !== taskId
          ? task
          : review.owner.kind === "integration"
            ? { ...task, integrationReviewProgress: progress }
            : { ...task, reviewProgress: progress },
      ),
    };
  });
}

async function persistCanonicalIntegrationAdmission(args: {
  deps: OrchestratorDeps;
  taskId: string;
  epoch: number;
  candidateIdentity: string;
  previousCandidate?: string;
  latestDeltaPaths: string[];
  previousCandidatePatch?: string;
  proposals: Array<{
    proposalId: string;
    summary: string;
    evidence: string;
    requiredChange: string;
    acceptanceCriteria: string[];
    basis:
      | { kind: "requirement"; requirementIds: string[] }
      | {
          kind: "candidate_regression";
          changedPaths: string[];
          causalEvidence: string;
        }
      | { kind: "correctness_invariant"; invariant: string };
  }>;
  admission: ReturnType<typeof evaluateFindingAdmission>;
  state: ReviewConvergenceState;
}): Promise<void> {
  const store = args.deps.canonicalRunStore;
  if (!store) {
    return;
  }
  for (;;) {
    const current = store.read();
    let persisted: CanonicalRunState["reviewConvergence"][string] | undefined;
    try {
      await store.update(current.revision, (run) => {
        const prior = run.reviewConvergence[`integration:${args.taskId}`];
        const sameEpochPrior = prior?.epoch === args.epoch ? prior : undefined;
        const proposalRecords = args.proposals.map((proposal) => ({
          id: proposal.proposalId,
          summary: proposal.summary,
          evidence: proposal.evidence,
          basis: proposal.basis,
          requiredChange: proposal.requiredChange,
          acceptanceCriteria: proposal.acceptanceCriteria,
        }));
        const findingIds = new Map(
          args.state.findings.map((finding) => [
            finding.proposalId,
            finding.id,
          ]),
        );
        const admissionRecords = args.admission.admissions.map((entry) => ({
          proposalId: entry.proposalId,
          disposition: entry.disposition,
          certainty: entry.certainty,
          rationale: entry.rationale,
          ...(entry.disposition === "admit"
            ? { findingId: findingIds.get(entry.proposalId) }
            : {}),
        }));
        persisted = {
          owner: { kind: "integration", taskId: args.taskId },
          stage: args.state.outstandingIds.length > 0 ? "rework" : "approved",
          candidate: {
            current: args.candidateIdentity,
            previous: args.previousCandidate,
            latestDeltaPaths: args.latestDeltaPaths,
          },
          proposalBatchId: args.admission.proposalBatchId,
          epoch: args.epoch,
          round: args.state.round,
          proposals: [...(sameEpochPrior?.proposals ?? []), ...proposalRecords],
          admissions: [
            ...(sameEpochPrior?.admissions ?? []),
            ...admissionRecords,
          ],
          findings: args.state.findings,
          outstandingFindingIds: args.state.outstandingIds,
          deferredConcerns: [
            ...(sameEpochPrior?.deferredConcerns ?? []),
            ...args.admission.deferredConcerns.map((proposal) => ({
              id: `integration:${args.taskId}:D-${proposal.proposalId}`,
              proposalId: proposal.proposalId,
              summary: proposal.summary,
              evidence: proposal.evidence,
              basis: proposal.basis,
              sourceScope: "integration" as const,
              sourceCandidate: args.candidateIdentity,
              rationale: args.admission.admissions.find(
                (entry) => entry.proposalId === proposal.proposalId,
              )?.rationale,
            })),
          ],
          observationIds: [
            ...(sameEpochPrior?.observationIds ?? []),
            ...args.admission.observations.map(
              (_observation, index) => `IO-${args.state.round}-${index + 1}`,
            ),
          ],
          bestOutstandingCount: args.state.bestOutstandingCount,
          consecutiveStalledRounds: args.state.consecutiveStalledRounds,
          evidenceRefs: sameEpochPrior?.evidenceRefs ?? [],
          previousCandidatePatch: args.previousCandidatePatch,
          verificationFailures: [],
        };
        return {
          ...run,
          reviewConvergence: {
            ...run.reviewConvergence,
            [`integration:${args.taskId}`]: persisted,
          },
        };
      });
      projectReviewProgress(args.deps, persisted!);
      return;
    } catch (error) {
      if (error instanceof StaleRunStateRevisionError) {
        continue;
      }
      throw error;
    }
  }
}

async function persistCanonicalReviewConvergence(
  deps: OrchestratorDeps,
  taskId: string,
  convergence: Omit<CanonicalRunState["reviewConvergence"][string], "owner">,
): Promise<void> {
  const store = deps.canonicalRunStore;
  if (!store) {
    return;
  }
  for (;;) {
    const current = store.read();
    let persisted: CanonicalRunState["reviewConvergence"][string] | undefined;
    try {
      await store.update(current.revision, (state) => {
        const previous = state.reviewConvergence[taskId];
        persisted = {
          owner: { kind: "task", taskId },
          ...convergence,
          ...(convergence.latestRework === undefined && previous?.latestRework
            ? { latestRework: previous.latestRework }
            : {}),
          ...(convergence.reworkObligationIds === undefined &&
          previous?.reworkObligationIds
            ? { reworkObligationIds: previous.reworkObligationIds }
            : {}),
        };
        return {
          ...state,
          reviewConvergence: {
            ...state.reviewConvergence,
            [taskId]: persisted,
          },
        };
      });
      projectReviewProgress(deps, persisted!);
      return;
    } catch (error) {
      if (error instanceof StaleRunStateRevisionError) {
        continue;
      }
      throw error;
    }
  }
}

function recoveredIntegrationLedger(mainBaseSha: string): IntegrationLedger {
  return createIntegrationLedger({
    mainBaseSha,
    gates: [
      {
        key: "fallback",
        kind: "fallback",
        label: "Fallback integration review",
      },
    ],
  });
}

function persistCanonicalTaskExecution(
  deps: OrchestratorDeps,
  taskId: string,
  task: SchedulerTask,
): void {
  if (!deps.canonicalRunStore) {
    return;
  }
  deps.canonicalRunStore.updateSync((state) => ({
    ...state,
    taskExecution: {
      ...state.taskExecution,
      [taskId]: {
        sourceBaseSha: task.sourceBaseSha,
        candidateBaseSha: task.candidateBaseSha,
        candidateSha: task.candidateSha,
        candidateTree: task.candidateTree,
        trustedCheckpoint: task.trustedCheckpoint,
        discardedBundles: task.discardedBundles,
        worktreePath: task.worktreePath,
        branchName: task.branchName,
        integrationLedger: task.integrationLedger,
        implementationRound: 0,
        lastReason: task.lastReason,
      },
    },
  }));
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
    wasNeedsRework = false,
  } = args;

  let feedback: RetryFeedback | undefined = initialFeedback;
  let priorSummary: string | undefined;
  let attempt =
    (readTaskJson(deps.paths!, taskId)?.implementationRound ??
      readTaskJson(deps.paths!, taskId)?.attempts ??
      0) + 1;
  let systemFailures = 0;
  const canonicalReview =
    deps.canonicalRunStore?.read().reviewConvergence[taskId];
  const convergence = canonicalReview
    ? {
        epoch: canonicalReview.epoch,
        state:
          canonicalReview.stage === "initial_review" &&
          canonicalReview.findings.length === 0
            ? undefined
            : {
                round: canonicalReview.round,
                findings: canonicalReview.findings,
                outstandingIds: canonicalReview.outstandingFindingIds,
                bestOutstandingCount: canonicalReview.bestOutstandingCount,
                consecutiveStalledRounds:
                  canonicalReview.consecutiveStalledRounds,
              },
        previousCandidate: canonicalReview.candidate.previous,
        previousCandidatePatch: canonicalReview.previousCandidatePatch,
        latestEvidence: canonicalReview.latestEvidence,
        verificationFailures: canonicalReview.verificationFailures,
      }
    : currentTaskReviewMetadata(deps.paths, taskId)?.convergence;
  const recoveringAdmission = canonicalReview?.stage === "admission";
  let reviewState = recoveringAdmission
    ? createReviewConvergenceState({
        drafts: (canonicalReview?.proposals ?? []).map((proposal) => ({
          proposalId: proposal.id,
          summary: proposal.summary,
          evidence: proposal.evidence,
          requiredChange: proposal.requiredChange ?? proposal.summary,
          acceptanceCriteria: proposal.acceptanceCriteria ?? [proposal.summary],
        })),
      })
    : (convergence?.state as ReviewConvergenceState | undefined);
  let reviewProposals = canonicalReview?.proposals ?? [];
  let reviewAdmissions = recoveringAdmission
    ? reviewState!.findings.map((finding) => ({
        proposalId: finding.proposalId!,
        disposition: "admit" as const,
        certainty: "uncertain" as const,
        rationale: "Recovered incomplete admission conservatively.",
        findingId: finding.id,
      }))
    : (canonicalReview?.admissions ?? []);
  let deferredConcerns = canonicalReview?.deferredConcerns ?? [];
  let reviewObservationIds = canonicalReview?.observationIds ?? [];
  let reviewProposalBatchId = canonicalReview?.proposalBatchId;
  let reviewContextId = canonicalReview?.contextId;
  let rawAdjudication = canonicalReview?.rawAdjudication;
  let reviewEpoch = convergence?.epoch ?? 1;
  let closedEpochs =
    currentTaskReviewMetadata(deps.paths, taskId)?.convergence?.closedEpochs ??
    [];
  let previousCandidate =
    args.wasNeedsRework && canonicalReview
      ? canonicalReview.candidate.current
      : recoveringAdmission
        ? canonicalReview?.candidate.current
        : convergence?.previousCandidate;
  let previousCandidatePatch = convergence?.previousCandidatePatch;
  let latestEvidence = convergence?.latestEvidence;
  let verificationFailures = convergence?.verificationFailures ?? [];
  if (recoveringAdmission && reviewState) {
    const recoveredReviewState = reviewState;
    feedback ??= typedReviewerFeedback(
      recoveredReviewState.findings,
      recoveredReviewState.outstandingIds,
      "Recovered incomplete finding admission conservatively.",
      verificationFailures,
    );
  }
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
    const recoveryGit = taskGit.withSignal?.() ?? taskGit;
    const bundlePath = join(
      deps.paths!.tasksDir,
      taskId,
      "discarded",
      `${Date.now()}-${attempt}`,
    );
    const bundle = await persistDiscardedBundle({
      git: recoveryGit,
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
      ...(await captureRestoreSnapshot(recoveryGit, planArtifacts)),
      head: trusted,
      stagedPatch: "",
      workingPatch: "",
      untrackedArtifacts: new Map(),
    };
    await restoreAndVerify(recoveryGit, snapshot, planArtifacts);
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
    const responsibilityContext = buildReviewResponsibilityContext(
      deps.executionManifest!,
    );
    const compiledContract = renderCompiledContract(
      compiledContractEntry.compiledContract,
      responsibilityContext.requirements.filter(
        (requirement) => requirement.taskId === compiledContractEntry.id,
      ),
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
    const taskReworkFindings = reviewState
      ? reviewState.findings.filter((finding) =>
          reviewState!.outstandingIds.includes(finding.id),
        )
      : [];
    const integrationReworkFindings = schedulerTask?.integrationLedger
      ?.fallbackReview
      ? schedulerTask.integrationLedger.fallbackReview.findings.filter(
          (finding) =>
            schedulerTask.integrationLedger!.fallbackReview!.outstandingIds.includes(
              finding.id,
            ),
        )
      : [];
    const reworkObligationPacket = [
      ...taskReworkFindings.map((finding) => ({
        ...finding,
        sourceScope: "task_review" as const,
      })),
      ...integrationReworkFindings.map((finding) => ({
        ...finding,
        sourceScope: "integration_fallback" as const,
      })),
    ];
    const implementerPrompt = buildImplementerPrompt({
      compiledContract,
      worktreePath: effectiveWorktreePath,
      sourceMaterial: sourceMaterialPacket?.section,
      responsibilityContext,
      selectedTaskId: compiledContractEntry.id,
      feedback: feedback ? formatFeedback(feedback) : undefined,
      priorSummary,
      findingCompletions: reworkObligationPacket,
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
              contextId: responsibilityContext.contextId,
              selectedTaskId: compiledContractEntry.id,
              requirements: responsibilityContext.requirements.filter(
                (requirement) =>
                  requirement.taskId === compiledContractEntry.id,
              ),
              responsibilities: responsibilityContext.responsibilities,
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
      stage: reviewState ? "task_rework" : "implementation",
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

    let parsed = parseImplementerResult(
      implementation.result,
      reworkObligationPacket.length > 0
        ? {
            expectedFindingIds: reworkObligationPacket.map(
              (finding) => finding.id,
            ),
          }
        : {},
    );
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
          findingCompletions: parsed.result.findingCompletions,
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
    const latestRework =
      parsed.ok && reworkObligationPacket.length > 0
        ? parsed.result.findingCompletions?.map((completion) => ({
            findingId: completion.id,
            status: completion.status,
            evidence: completion.evidence,
            changedPaths: completion.changedPaths,
            verification: completion.verification,
          }))
        : undefined;

    if (hasStaged) {
      fingerprintBefore = await taskGit.stagedFingerprint();
      candidatePatch = await taskGit.stagedDiff();
      latestDeltaPaths = parseNameStatusPaths(await taskGit.stagedNameStatus());
      latestDelta = candidatePatch;
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
          latestDelta = await taskGit.diffRange(
            previousCandidate,
            candidate.trustedCheckpoint!,
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
      if (wasNeedsRework || update.outcome === "stalled") {
        const stalledReason = [schedulerTask?.lastReason, latestEvidence]
          .filter(Boolean)
          .join("\n\n");
        persistCandidate("stalled", stalledReason);
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
          reworkCompletions: parsed.result.findingCompletions?.filter(
            (completion) => reviewState!.outstandingIds.includes(completion.id),
          ),
          responsibilityContext,
          selectedTaskId: compiledContractEntry.id,
        })
      : buildInitialTaskReviewPrompt({
          compiledContract,
          worktreePath: effectiveWorktreePath,
          candidateContext,
          responsibilityContext,
          selectedTaskId: compiledContractEntry.id,
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
    await persistCanonicalReviewConvergence(deps, taskId, {
      stage: reviewState ? "anchored_review" : "initial_review",
      candidate: {
        current: candidateIdentity,
        previous: previousCandidate,
        latestDeltaPaths: [],
      },
      contextId: reviewContextId,
      proposalBatchId: reviewProposalBatchId,
      rawAdjudication,
      epoch: reviewEpoch,
      round: reviewState?.round ?? 0,
      proposals: reviewProposals,
      admissions: reviewAdmissions,
      findings: reviewState?.findings ?? [],
      outstandingFindingIds: reviewState?.outstandingIds ?? [],
      deferredConcerns,
      observationIds: reviewObservationIds,
      bestOutstandingCount: reviewState?.bestOutstandingCount ?? 0,
      previousOutstandingCount: reviewState?.outstandingIds.length,
      consecutiveStalledRounds: reviewState?.consecutiveStalledRounds ?? 0,
      evidenceRefs: [
        join(deps.paths!.runDir, "artifacts", taskId, "reviewer-prompt.md"),
      ],
      previousCandidatePatch,
      latestEvidence,
      verificationFailures,
      latestRework,
      reworkObligationIds: reworkObligationPacket.map((finding) => finding.id),
    });

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
          stage: reviewState ? "anchored_task_review" : "initial_task_review",
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
            const regressionProposals = parsedReview.result.regressions.map(
              (regression, index) => ({
                ...regression,
                proposalId: `E${reviewEpoch}R${anchoredReviewState.round + 1}P${index + 1}`,
                basis: {
                  kind: "candidate_regression" as const,
                  changedPaths: regression.changedPaths,
                  causalEvidence: regression.causalEvidence,
                },
              }),
            );
            const regressionAdmission = regressionProposals.length
              ? await admitReviewProposals({
                  deps,
                  scope: "task",
                  taskId,
                  compiledContract,
                  candidateIdentity,
                  latestDeltaPaths,
                  proposals: regressionProposals,
                })
              : undefined;
            const admittedProposalIds = new Set(
              regressionAdmission?.admittedDrafts.map(
                (draft) => draft.proposalId,
              ) ?? [],
            );
            const admittedRegressions = regressionProposals.filter((proposal) =>
              admittedProposalIds.has(proposal.proposalId),
            );
            if (anchoredReviewState.outstandingIds.length === 0) {
              const regressionEpoch = openRegressionReviewEpoch({
                closedState: anchoredReviewState,
                regressions: admittedRegressions,
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
                review: {
                  ...parsedReview.result,
                  regressions: admittedRegressions,
                },
                latestDeltaPaths,
              });
            }
            if (regressionAdmission) {
              const findingIds = new Map(
                update.state.findings.map((finding) => [
                  finding.proposalId,
                  finding.id,
                ]),
              );
              reviewProposals = [
                ...reviewProposals,
                ...regressionProposals.map((proposal) => ({
                  id: proposal.proposalId,
                  summary: proposal.summary,
                  evidence: proposal.evidence,
                  basis: proposal.basis,
                  requiredChange: proposal.requiredChange,
                  acceptanceCriteria: proposal.acceptanceCriteria,
                })),
              ];
              reviewAdmissions = [
                ...reviewAdmissions,
                ...regressionAdmission.admissions.map((entry) => ({
                  proposalId: entry.proposalId,
                  disposition: entry.disposition,
                  certainty: entry.certainty,
                  rationale: entry.rationale,
                  ...(entry.disposition === "admit"
                    ? { findingId: findingIds.get(entry.proposalId)! }
                    : {}),
                })),
              ];
              deferredConcerns = [
                ...deferredConcerns,
                ...regressionAdmission.deferredConcerns.map((proposal) => ({
                  id: `${taskId}:D-${proposal.proposalId}`,
                  proposalId: proposal.proposalId,
                  summary: proposal.summary,
                  evidence: proposal.evidence,
                  basis: proposal.basis,
                  sourceScope: "task" as const,
                  sourceCandidate: candidateIdentity,
                  rationale: regressionAdmission.admissions.find(
                    (entry) => entry.proposalId === proposal.proposalId,
                  )?.rationale,
                })),
              ];
              reviewObservationIds = [
                ...reviewObservationIds,
                ...regressionAdmission.observations.map(
                  (_observation, index) =>
                    `O-${anchoredReviewState.round + 1}-${index + 1}`,
                ),
              ];
              reviewProposalBatchId = regressionAdmission.proposalBatchId;
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
            await persistCanonicalReviewConvergence(deps, taskId, {
              stage: "stalled",
              candidate: {
                current: candidateIdentity,
                previous: previousCandidate,
                latestDeltaPaths: [],
              },
              contextId: reviewContextId,
              proposalBatchId: reviewProposalBatchId,
              rawAdjudication,
              epoch: reviewEpoch,
              round: reviewState.round,
              proposals: reviewProposals,
              admissions: reviewAdmissions,
              findings: reviewState.findings,
              outstandingFindingIds: reviewState.outstandingIds,
              deferredConcerns,
              observationIds: reviewObservationIds,
              bestOutstandingCount: reviewState.bestOutstandingCount,
              consecutiveStalledRounds: reviewState.consecutiveStalledRounds,
              evidenceRefs: [join(deps.paths!.runDir, "artifacts", taskId)],
              previousCandidatePatch,
              latestEvidence,
              verificationFailures,
            });
            persistCandidate(
              "stalled",
              "task review stalled without a new low outstanding count",
            );
            throw new TaskStalledError(
              `task ${task.index} review stalled without a new low outstanding count`,
            );
          }
        } else {
          const parsedReview = parseInitialReviewResult(review.result, {
            requireProposalBasis: true,
          });
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
          const proposals =
            parsedReview.result.verdict === "changes_requested"
              ? parsedReview.result.findings
              : [];
          if (proposals.length === 0) {
            reviewProposals = [];
            reviewAdmissions = [];
            reviewState = createReviewConvergenceState({ drafts: [] });
          } else {
            const proposalBatchId = createProposalBatchId({
              scope: "task",
              contextId: responsibilityContext.contextId,
              candidateIdentity,
              latestDeltaPaths,
              proposals,
            });
            reviewProposals = proposals.map((proposal) => ({
              id: proposal.proposalId,
              summary: proposal.summary,
              evidence: proposal.evidence,
              basis: proposal.basis,
              requiredChange: proposal.requiredChange,
              acceptanceCriteria: proposal.acceptanceCriteria,
            }));
            reviewProposalBatchId = proposalBatchId;
            reviewContextId = responsibilityContext.contextId;
            rawAdjudication = undefined;
            if (deps.paths) {
              persistTaskArtifact(
                deps.paths,
                taskId,
                "proposal-batch.json",
                JSON.stringify(
                  {
                    proposalBatchId,
                    contextId: responsibilityContext.contextId,
                    candidateIdentity,
                    latestDeltaPaths,
                    proposals,
                  },
                  null,
                  2,
                ),
              );
            }
            await persistCanonicalReviewConvergence(deps, taskId, {
              stage: "admission",
              candidate: {
                current: candidateIdentity,
                previous: previousCandidate,
                latestDeltaPaths,
              },
              contextId: responsibilityContext.contextId,
              proposalBatchId,
              rawAdjudication,
              epoch: reviewEpoch,
              round: 0,
              proposals: reviewProposals,
              admissions: [],
              findings: [],
              outstandingFindingIds: [],
              deferredConcerns: [],
              observationIds: [],
              bestOutstandingCount: 0,
              consecutiveStalledRounds: 0,
              evidenceRefs: [join(deps.paths!.runDir, "artifacts", taskId)],
              previousCandidatePatch,
              latestEvidence,
              verificationFailures,
            });
            const admissionPrompt = buildTaskFindingAdmissionPrompt({
              compiledContract,
              responsibilityContext,
              selectedTaskId: compiledContractEntry.id,
              candidateIdentity,
              latestDeltaPaths,
              proposalBatchId,
              proposals,
            });
            if (deps.paths) {
              persistTaskArtifact(
                deps.paths,
                taskId,
                "adjudicator-prompt.md",
                admissionPrompt,
              );
            }
            let admissionResult: SubagentResult;
            let admissionId: string | undefined;
            try {
              admissionId = await deps.subagents.spawn({
                type: deps.roles.reviewer.type,
                ownerRole: "admission",
                prompt: admissionPrompt,
                description: `admit task ${task.index}/${plan.tasks.length} findings: ${shortTask(task.text)}`,
                model: deps.roles.reviewer.model,
                thinking: "low",
                role: "admission",
                stage: "task_admission",
                taskId,
                cwd: effectiveWorktreePath,
                systemPrompt: FINDING_ADMISSION_SYSTEM_PROMPT,
                systemPromptMode: "replace",
                noTools: true,
                excludeTools: [
                  "read",
                  "bash",
                  "grep",
                  "find",
                  "ls",
                  "explore",
                  "lsp",
                  "edit",
                  "write",
                  "Agent",
                  "get_subagent_result",
                  "steer_subagent",
                  "propose_papercut",
                ],
                completion: {
                  description: "Submit finding admission dispositions.",
                  schema: findingAdmissionBatchSchema,
                },
              });
              const admissionRef: AgentDisplayRef = {
                id: admissionId,
                role: "admission",
                label: `Task ${task.index}/${plan.tasks.length} finding admission · ${shortTask(task.text)}`,
                startedAt: new Date().toISOString(),
                taskId,
                taskIndex: task.index,
                taskTotal: plan.tasks.length,
                taskTitle: shortTask(task.text),
              };
              setSchedulerActiveAgent(schedulerTask, admissionRef);
              deps.updateState((prev) =>
                addActiveAgentPatch(prev, admissionRef),
              );
              admissionResult = await deps.subagents.waitFor(
                admissionId,
                deps.signal,
              );
            } catch (error) {
              admissionResult = {
                status: "failed",
                error: `Adjudicator unavailable: ${error instanceof Error ? error.message : String(error)}`,
              };
            } finally {
              if (admissionId) {
                clearSchedulerActiveAgent(schedulerTask, admissionId);
                deps.updateState((prev) =>
                  removeActiveAgentPatch(prev, admissionId!),
                );
              }
            }
            if (deps.paths) {
              persistTaskArtifact(
                deps.paths,
                taskId,
                "adjudicator-result.json",
                JSON.stringify(admissionResult, null, 2),
              );
            }
            const parsedAdmission =
              admissionResult.status === "completed"
                ? parseAdmissionResult(admissionResult.result)
                : undefined;
            rawAdjudication = admissionResult;
            const admission = evaluateFindingAdmission({
              scope: "task",
              proposalBatchId,
              proposals,
              knownRequirementIds: responsibilityContext.requirements.map(
                (requirement) => requirement.id,
              ),
              ...(parsedAdmission?.ok
                ? { adjudication: parsedAdmission.result }
                : {
                    failureReason:
                      admissionResult.status === "completed"
                        ? `Adjudication completion was malformed: ${parsedAdmission?.reason ?? "unknown error"}`
                        : `Adjudication ${admissionResult.status}: ${admissionResult.error}`,
                  }),
            });
            reviewState = createReviewConvergenceState({
              drafts: admission.admittedDrafts,
            });
            const findingIds = new Map(
              reviewState.findings.map((finding) => [
                finding.proposalId,
                finding.id,
              ]),
            );
            reviewAdmissions = admission.admissions.map((entry) => ({
              proposalId: entry.proposalId,
              disposition: entry.disposition,
              certainty: entry.certainty,
              rationale: entry.rationale,
              ...(entry.disposition === "admit"
                ? { findingId: findingIds.get(entry.proposalId)! }
                : {}),
            }));
            deferredConcerns = admission.deferredConcerns.map((proposal) => ({
              id: `${taskId}:D-${proposal.proposalId}`,
              proposalId: proposal.proposalId,
              summary: proposal.summary,
              evidence: proposal.evidence,
              basis: proposal.basis,
              sourceScope: "task",
              sourceCandidate: candidateIdentity,
              rationale: reviewAdmissions.find(
                (admission) => admission.proposalId === proposal.proposalId,
              )?.rationale,
            }));
            reviewObservationIds = admission.observations.map(
              (_observation, index) => `O-${index + 1}`,
            );
            await persistCanonicalReviewConvergence(deps, taskId, {
              stage:
                reviewState.outstandingIds.length > 0 ? "rework" : "approved",
              candidate: {
                current: candidateIdentity,
                previous: previousCandidate,
                latestDeltaPaths,
              },
              contextId: responsibilityContext.contextId,
              proposalBatchId,
              rawAdjudication,
              epoch: reviewEpoch,
              round: reviewState.round,
              proposals: reviewProposals,
              admissions: reviewAdmissions,
              findings: reviewState.findings,
              outstandingFindingIds: reviewState.outstandingIds,
              deferredConcerns,
              observationIds: reviewObservationIds,
              bestOutstandingCount: reviewState.bestOutstandingCount,
              consecutiveStalledRounds: reviewState.consecutiveStalledRounds,
              evidenceRefs: [join(deps.paths!.runDir, "artifacts", taskId)],
              previousCandidatePatch,
              latestEvidence,
              verificationFailures,
            });
            if (deps.paths) {
              persistTaskArtifact(
                deps.paths,
                taskId,
                "admission-transition.json",
                JSON.stringify({ rawAdjudication, admission }, null, 2),
              );
            }
          }
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
          await persistCanonicalReviewConvergence(deps, taskId, {
            stage: "rework",
            candidate: {
              current: candidateIdentity,
              previous: previousCandidate,
              latestDeltaPaths: [],
            },
            contextId: reviewContextId,
            proposalBatchId: reviewProposalBatchId,
            rawAdjudication,
            epoch: reviewEpoch,
            round: reviewState.round,
            proposals: reviewProposals,
            admissions: reviewAdmissions,
            findings: reviewState.findings,
            outstandingFindingIds: reviewState.outstandingIds,
            deferredConcerns,
            observationIds: reviewObservationIds,
            bestOutstandingCount: reviewState.bestOutstandingCount,
            consecutiveStalledRounds: reviewState.consecutiveStalledRounds,
            evidenceRefs: [join(deps.paths!.runDir, "artifacts", taskId)],
            previousCandidatePatch,
            latestEvidence,
            verificationFailures,
          });
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
    if (
      !worktreePath ||
      !hasStaged ||
      parsed.result.outcome === "already_satisfied"
    ) {
      await persistCanonicalReviewConvergence(deps, taskId, {
        stage: reviewState.outstandingIds.length === 0 ? "approved" : "stalled",
        candidate: {
          current:
            candidate.candidateSha ?? candidate.trustedCheckpoint ?? baseSha,
          previous: previousCandidate,
          latestDeltaPaths: [],
        },
        candidateId: undefined,
        contextId: reviewContextId,
        proposalBatchId: reviewProposalBatchId,
        rawAdjudication,
        epoch: reviewEpoch,
        round: reviewState.round,
        proposals: reviewProposals,
        admissions: reviewAdmissions,
        findings: reviewState.findings,
        outstandingFindingIds: reviewState.outstandingIds,
        deferredConcerns,
        observationIds: reviewObservationIds,
        bestOutstandingCount: reviewState.bestOutstandingCount,
        consecutiveStalledRounds: reviewState.consecutiveStalledRounds,
        evidenceRefs: [join(deps.paths!.runDir, "artifacts", taskId)],
        previousCandidatePatch,
        latestEvidence,
        verificationFailures,
      });
    }

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
      const taskCommitSha = await taskGit.head();
      if (candidate.candidateSha !== taskCommitSha) {
        throw new BlockedError(
          "approved candidate identity changed after review; rerun review before approval",
        );
      }
      const taskCommit = await taskGit.rewordInternal(approvedMessage);
      if (taskCommit.exitCode !== 0) {
        throw new BlockedError(
          `could not finalize approved checkpoint: ${taskCommit.stderr || taskCommit.stdout}`,
        );
      }
      const finalizedCommitSha = await taskGit.head();
      const finalizedTreeSha = await taskGit.treeAt(finalizedCommitSha);
      if (finalizedTreeSha !== candidate.candidateTree) {
        throw new BlockedError(
          "finalizing an approved candidate changed its reviewed tree",
        );
      }
      candidate = {
        ...candidate,
        candidateSha: finalizedCommitSha,
        trustedCheckpoint: finalizedCommitSha,
      };
      previousCandidate = finalizedCommitSha;
      const finalizedTaskReviewMeta = {
        ...nextTaskReviewMetadata(deps.paths, taskId),
        ...persistReview("reviewed"),
      };
      await persistCanonicalReviewConvergence(deps, taskId, {
        stage: "approved",
        candidate: {
          current: finalizedCommitSha,
          previous: previousCandidate,
          latestDeltaPaths: [],
        },
        candidateId: undefined,
        contextId: reviewContextId,
        proposalBatchId: reviewProposalBatchId,
        rawAdjudication,
        epoch: reviewEpoch,
        round: reviewState.round,
        proposals: reviewProposals,
        admissions: reviewAdmissions,
        findings: reviewState.findings,
        outstandingFindingIds: reviewState.outstandingIds,
        deferredConcerns,
        observationIds: reviewObservationIds,
        bestOutstandingCount: reviewState.bestOutstandingCount,
        consecutiveStalledRounds: reviewState.consecutiveStalledRounds,
        evidenceRefs: [join(deps.paths!.runDir, "artifacts", taskId)],
        previousCandidatePatch,
        latestEvidence,
        verificationFailures,
      });
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
          taskCommitSha: finalizedCommitSha,
          candidateSha: finalizedCommitSha,
          trustedCheckpoint: finalizedCommitSha,
          candidateTree: finalizedTreeSha,
          activeSubagentIds: [],
          commitMessage: approvedMessage,
          review: finalizedTaskReviewMeta,
        });
        appendEvent(deps.paths, {
          type: "task_approved",
          taskId,
          commitSha: finalizedCommitSha,
        });
      }
      return "changed";
    }

    throw new BlockedError(
      "changed task execution requires an owned task worktree",
    );
  }
  return false;
}

async function projectCompletedScheduledSourceCheckboxes(
  deps: OrchestratorDeps,
  sched: SchedulerRun,
  plan: ReturnType<typeof parsePlanFile>,
  schedulerActor?: SchedulerActor,
): Promise<void> {
  const projectionDebt = {
    id: "source-checkboxes",
    kind: "source-checkboxes",
    reason: "completed task source checkboxes need projection",
  };
  if (schedulerActor) {
    await schedulerActor.recordProjectionDebt(projectionDebt);
  }
  try {
    markCompletedScheduledSourceCheckboxes(deps, sched, plan);
    if (schedulerActor) {
      await schedulerActor.completeProjection(projectionDebt.id);
    }
  } catch (error) {
    if (!schedulerActor) {
      throw error;
    }
    throw new BlockedError(
      `Source checkbox projection failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function markCompletedScheduledSourceCheckboxes(
  deps: OrchestratorDeps,
  sched: SchedulerRun,
  plan: ReturnType<typeof parsePlanFile>,
): void {
  const canonical = deps.canonicalRunStore?.read();
  const completed = canonical
    ? canonical.graph.tasks
        .filter(
          (task) => canonical.runtime.tasks[task.id]?.phase === "completed",
        )
        .map((task) => ({ id: task.id, planIndex: task.planIndex }))
    : [...sched.tasks.values()]
        .filter(
          (task) => task.status === "landed" || task.status === "satisfied",
        )
        .map((task) => ({ id: task.id, planIndex: task.planIndex }));
  for (const task of completed.sort((a, b) => a.planIndex - b.planIndex)) {
    const planTask = plan.tasks.find((entry) => entry.index === task.planIndex);
    if (planTask) {
      markSourceCheckboxDone(deps, task.id, planTask);
    }
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
      if (!result.ok) {
        throw new BlockedError(
          `Source checkbox update skipped: ${result.reason}`,
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
      if (!result.ok) {
        throw new BlockedError(
          `Source checkbox update skipped: ${result.reason}`,
        );
      }
    }
    return;
  }

  try {
    markTaskDone(deps.planPath, planTask);
  } catch (error) {
    throw new BlockedError(
      `Source checkbox update failed: ${error instanceof Error ? error.message : String(error)}`,
    );
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
