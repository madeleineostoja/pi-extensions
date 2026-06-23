import { readFileSync, readdirSync, existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { isModelRef } from "@pi-extensions/lib";
import {
  readConfig,
  resolveEffectiveRoles,
  formatConfigStatus,
  resolveMaxParallel,
  reviewerDefaultTypeWarning,
} from "./config.js";
import { ExecGitClient } from "./git.js";
import {
  RuntimeSubagentClient,
  type SpawnArgs,
  type SubagentClient,
  type SubagentResult,
} from "./subagents.js";
import {
  runImplementation,
  BlockedError,
  StoppedError,
  OverallReviewFollowupError,
} from "./orchestrator.js";
import type { RunState, AgentDisplayRef, StatePatch } from "./status.js";
import {
  formatFooterStatusParts,
  formatRunStatus,
  formatWidgetLines,
} from "./status.js";
import { parseCommand } from "./parser.js";
import { selectStrategy } from "./strategy.js";
import { nextUncheckedTask, parsePlanFile } from "./plan.js";
import {
  buildPlanBundleManifest,
  manifestFromStore,
  validatePlanMaterialSizes,
} from "./manifest.js";
import { ingestPlanCorpus, ingestPlanCorpusFromStore } from "./corpus.js";
import { buildMaterialStore, type MaterialStore } from "./material-store.js";
import { buildPhase1MaterialInventory } from "./material-inventory.js";
import { diffProgress } from "./progress.js";
import {
  getStatePaths,
  makeRunId,
  makeRunIdWithSuffix,
  createRunState,
  writeRunJson,
  readRunJson,
  readTaskJson,
  appendEvent,
  cleanupRun,
  listRunIds,
  acquireRunLock,
  releaseRunLock,
  checkRunLocks,
  sweepRunArtifacts,
} from "./state.js";

const STATUS_KEY = "pi-implement.status";
const WIDGET_KEY = "pi-implement.progress";
let currentSnapshotClient: SubagentClient | undefined;

type ActiveRun = {
  state: RunState;
  stopping: boolean;
  runId: number;
  runDir?: string;
  abortController?: AbortController;
  activeSubagentIds?: string[];
};

const ACTIVE_PHASES = new Set<RunState["phase"]>([
  "preflight",
  "strategy",
  "scheduling",
  "coding",
  "reviewing",
  "committing",
  "integrating",
  "reworking",
  "final_review",
  "final_rework",
  "stopping",
]);

const STARTABLE_PHASES = new Set([
  "idle",
  "done",
  "stopped",
  "blocked",
  "followup_required",
]);

export function isActiveImplementPhase(phase: RunState["phase"]): boolean {
  return ACTIVE_PHASES.has(phase);
}

export function canStartImplementRun(phase: RunState["phase"]): boolean {
  return STARTABLE_PHASES.has(phase);
}

function isWarningTerminalPhase(phase: RunState["phase"]): boolean {
  return (
    phase === "blocked" || phase === "followup_required" || phase === "stopped"
  );
}

export function registerImplementCommand(pi: ExtensionAPI): void {
  let active: ActiveRun = {
    state: { phase: "idle" },
    stopping: false,
    runId: 0,
  };
  let nextRunId = 0;
  let lastStoppedState: RunState | undefined;
  let widgetTick: ReturnType<typeof setInterval> | undefined;

  const startWidgetTick = (ctx: ExtensionCommandContext) => {
    if (widgetTick || ctx.mode !== "tui") {
      return;
    }
    widgetTick = setInterval(() => {
      if (activeSubagentIds(active).length === 0) {
        stopWidgetTick();
        return;
      }
      syncWidget(ctx, active.state);
    }, 1000);
  };

  const stopWidgetTick = () => {
    if (widgetTick) {
      clearInterval(widgetTick);
      widgetTick = undefined;
    }
  };

  const setState = (ctx: ExtensionCommandContext, patch: Partial<RunState>) => {
    active.state = { ...active.state, ...patch };
    syncStatus(ctx, active.state);
    syncWidget(ctx, active.state);
    if (activeSubagentIds(active).length > 0) {
      startWidgetTick(ctx);
    } else {
      stopWidgetTick();
    }
  };

  pi.on("session_shutdown", async (_event, ctx) => {
    active.stopping = true;
    active.abortController?.abort();
    const ids = activeSubagentIds(active);
    for (const id of ids) {
      try {
        await currentSnapshotClient?.stop(id);
      } catch {
        // Best-effort: session is shutting down anyway.
      }
    }
    stopWidgetTick();
    if (ctx.mode === "tui") {
      ctx.ui.setStatus(STATUS_KEY, undefined);
      ctx.ui.setWidget(WIDGET_KEY, undefined);
    }
  });

  pi.on("turn_start", async (_event, ctx) => {
    if (ctx.mode === "tui" && isWarningTerminalPhase(active.state.phase)) {
      ctx.ui.setStatus(STATUS_KEY, undefined);
    }
  });

  const implementCommand = {
    description: "Implement a /plan markdown file one task at a time",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const parsed = parseCommand(args.trim());

      if (parsed.kind === "error") {
        ctx.ui.notify(parsed.message, "warning");
        return;
      }

      if (parsed.kind === "subcommand") {
        if (parsed.name === "status") {
          // If idle but we have a last stopped/failed/blocked state, show it
          const stateToShow =
            active.state.phase === "idle" && lastStoppedState
              ? lastStoppedState
              : active.state;
          ctx.ui.notify(formatRunStatus(stateToShow), "info");
          if (
            stateToShow.phase === "blocked" ||
            stateToShow.phase === "stopped"
          ) {
            ctx.ui.notify(
              "Use `/implement cleanup` to remove preserved artifacts.",
              "info",
            );
          }
          return;
        }

        if (parsed.name === "config") {
          const config = readConfig(getAgentDir());
          const effective = resolveEffectiveRoles(config.config, ctx);
          const roles = effective.ok ? effective.roles : undefined;
          ctx.ui.notify(
            formatConfigStatus(config, roles),
            config.warning || (roles && reviewerDefaultTypeWarning(roles))
              ? "warning"
              : "info",
          );
          return;
        }

        if (parsed.name === "stop") {
          if (!isActiveImplementPhase(active.state.phase)) {
            ctx.ui.notify(
              `pi-implement is not running (phase: ${active.state.phase}).`,
              "info",
            );
            return;
          }
          active.stopping = true;
          active.abortController?.abort();
          setState(ctx, { phase: "stopping" });

          const ids = activeSubagentIds(active);
          const failedStops: string[] = [];
          if (ids.length > 0) {
            for (const id of ids) {
              try {
                await currentSnapshotClient?.stop(id);
              } catch (err) {
                const reason = err instanceof Error ? err.message : String(err);
                failedStops.push(`${id} (${reason})`);
              }
            }
          }

          const newState: RunState = {
            ...active.state,
            phase: "stopped",
            activeSubagentId: undefined,
            activeSubagentIds: [],
            lastReason: "Stopped by user.",
          };
          active.state = newState;
          lastStoppedState = newState;
          syncStatus(ctx, newState);

          if (failedStops.length > 0) {
            ctx.ui.notify(
              `pi-implement stopped, but some subagent stop requests failed: ${failedStops.join(", ")}`,
              "warning",
            );
          }
          ctx.ui.notify("pi-implement stopped.", "warning");
          stopWidgetTick();
          if (ctx.mode === "tui") {
            ctx.ui.setWidget(WIDGET_KEY, undefined);
          }
          return;
        }

        if (parsed.name === "view") {
          const refs = activeAgentRefs(active.state);
          if (refs.length === 0) {
            ctx.ui.notify(
              `pi-implement view: no active subagents\n\n${formatRunStatus(active.state)}`,
              "info",
            );
            return;
          }
          if (refs.length === 1) {
            const ref = refs[0];
            ctx.ui.notify(
              `Active pi-implement agents:\n- ${ref.label}\n  agent id: ${ref.id}\n\nOpen /agents \u2192 Running agents \u2192 select "${ref.label}" or agent id ${ref.id}.`,
              "info",
            );
            return;
          }
          const selected = await ctx.ui.select(
            "Select an active pi-implement agent to view",
            refs.map((r) => r.label),
          );
          if (!selected) {
            return;
          }
          const ref = refs.find((r) => r.label === selected);
          if (!ref) {
            return;
          }
          ctx.ui.notify(
            `Active pi-implement agents:\n- ${ref.label}\n  agent id: ${ref.id}\n\nOpen /agents \u2192 Running agents \u2192 select "${ref.label}" or agent id ${ref.id}.`,
            "info",
          );
          return;
        }

        if (parsed.name === "inspect") {
          const git = new ExecGitClient(ctx.cwd);
          const repoRoot = await git.mainRoot();
          let runId: string | undefined;
          if (active.state.runId) {
            runId = active.state.runId;
          } else {
            const runIds = listRunIds(repoRoot);
            if (runIds.length > 0) {
              runId = runIds.reduce((a, b) => (a > b ? a : b));
            }
          }
          if (!runId) {
            ctx.ui.notify("pi-implement inspect: no run found.", "info");
            return;
          }
          const paths = getStatePaths(repoRoot, runId);
          const run = readRunJson(paths);
          if (!run) {
            ctx.ui.notify(
              `pi-implement inspect: run ${runId} metadata not found.`,
              "warning",
            );
            return;
          }
          const lines: string[] = [];
          lines.push(`Run: ${runId}`);
          lines.push(`Run dir: ${paths.runDir}`);
          lines.push(`Worktrees dir: ${paths.worktreesDir}`);
          if (existsSync(paths.tasksDir)) {
            const taskIds = readdirSync(paths.tasksDir, { withFileTypes: true })
              .filter((d) => d.isDirectory())
              .map((d) => d.name);
            for (const taskId of taskIds) {
              const task = readTaskJson(paths, taskId);
              if (!task) {
                continue;
              }
              const wt = task.worktreePath ?? "—";
              const review = task.review
                ? ` (${task.review.lastDecision})`
                : "";
              let line = `${task.id} [${task.status}${review}] → ${wt}`;
              lines.push(line);
            }
          }
          ctx.ui.notify(lines.join("\n"), "info");
          return;
        }

        if (parsed.name === "cleanup") {
          if (isActiveImplementPhase(active.state.phase)) {
            ctx.ui.notify(
              "pi-implement cleanup refused: a run is currently active. Use `/implement stop` first.",
              "warning",
            );
            return;
          }
          const git = new ExecGitClient(ctx.cwd);
          const repoRoot = await git.mainRoot();
          const checkoutRoot = await git.root();
          const lockCheck = checkRunLocks(
            getStatePaths(repoRoot, "lock-check", checkoutRoot),
          );
          if (lockCheck.active.length > 0) {
            const activeLocks = lockCheck.active
              .map((lock) => lock.reason)
              .join("\n- ");
            ctx.ui.notify(
              `pi-implement cleanup refused: active run lock(s) found:\n- ${activeLocks}\nUse /implement stop in the owning session first.`,
              "warning",
            );
            return;
          }
          for (const stale of lockCheck.staleRemoved) {
            ctx.ui.notify(`Removed stale pi-implement lock: ${stale}.`, "info");
          }
          const runIds = listRunIds(repoRoot);
          let cleaned = 0;
          for (const runId of runIds) {
            const paths = getStatePaths(repoRoot, runId);
            try {
              cleanupRun(paths);
              cleaned++;
            } catch (err) {
              const reason = err instanceof Error ? err.message : String(err);
              ctx.ui.notify(
                `Cleanup warning for ${runId}: ${reason}`,
                "warning",
              );
            }
          }
          const { worktrees, branches } = sweepRunArtifacts(repoRoot);
          const parts = [`removed ${cleaned} run(s)`];
          if (worktrees) {
            parts.push(`pruned ${worktrees} worktree(s)`);
          }
          if (branches) {
            parts.push(`deleted ${branches} orphaned branch(es)`);
          }
          ctx.ui.notify(`pi-implement cleanup: ${parts.join("; ")}.`, "info");
          return;
        }

        return;
      }

      if (!canStartImplementRun(active.state.phase)) {
        ctx.ui.notify(
          `pi-implement is already running.\n\n${formatRunStatus(active.state)}`,
          "warning",
        );
        return;
      }

      const config = readConfig(getAgentDir());
      if (config.warning) {
        ctx.ui.notify(config.warning, "warning");
      }
      const effective = resolveEffectiveRoles(config.config, ctx);
      if (!effective.ok) {
        ctx.ui.notify(effective.reason, "warning");
        return;
      }
      const reviewerWarning = reviewerDefaultTypeWarning(effective.roles);
      if (reviewerWarning) {
        ctx.ui.notify(reviewerWarning, "warning");
      }

      const planPath = resolve(ctx.cwd, parsed.mode.planPath);
      const forceSerial = parsed.mode.forceSerial;

      const configuredWorkerModels = [
        effective.roles.implementer.model,
        effective.roles.reviewer.model,
        effective.roles.planner.model,
        effective.roles.selfHeal.model,
      ].filter((model): model is string => model !== undefined);
      const invalid = configuredWorkerModels.filter(
        (model) => !isModelRef(model),
      );
      if (invalid.length) {
        ctx.ui.notify(
          `Invalid model reference(s): ${invalid.join(", ")}. Expected provider/model-id.`,
          "warning",
        );
        return;
      }
      const missing = configuredWorkerModels.filter(
        (model) => !modelExists(ctx, model),
      );
      if (missing.length) {
        ctx.ui.notify(
          `Model not found: ${[...new Set(missing)].join(", ")}`,
          "warning",
        );
        return;
      }

      let git: ExecGitClient;
      let repoRoot: string;
      let checkoutRoot: string;
      let checkoutIdentity: string;
      let baseSha: string;
      let planContent: string;
      let plan: ReturnType<typeof parsePlanFile>;
      let planArtifacts: string[];
      let planHash: string;
      let manifest: ReturnType<typeof buildPlanBundleManifest>;
      let corpus: ReturnType<typeof ingestPlanCorpus>;
      let corpusFileRecords: Array<{ path: string; hash: string }>;
      let materialInventory: ReturnType<typeof buildPhase1MaterialInventory>;
      let materialStore: MaterialStore | undefined;
      try {
        git = new ExecGitClient(ctx.cwd);
        repoRoot = await git.mainRoot();
        checkoutRoot = await git.root();
        checkoutIdentity = await git.checkoutIdentity();
        await git.ensureInfoExclude("/.pi/implement/");
        baseSha = await git.head();
        planContent = readFileSync(planPath, "utf-8");
        plan = parsePlanFile(planPath);
        materialStore = buildMaterialStore({
          plan,
          planPath,
          repoRoot,
        });
        manifest = manifestFromStore(materialStore, plan);
        if (manifest.validationErrors.length > 0) {
          ctx.ui.notify(
            `pi-implement blocked: plan bundle validation failed:\n${manifest.validationErrors.join("\n")}`,
            "warning",
          );
          return;
        }
        const materialSizeErrors = validatePlanMaterialSizes(manifest);
        if (materialSizeErrors.length > 0) {
          ctx.ui.notify(
            `pi-implement blocked: plan material too large:\n${materialSizeErrors.join("\n")}`,
            "warning",
          );
          return;
        }

        corpus = ingestPlanCorpusFromStore(materialStore);
        if (corpus.validationErrors.length > 0) {
          ctx.ui.notify(
            `pi-implement blocked: corpus validation failed:\n${corpus.validationErrors.join("\n")}`,
            "warning",
          );
          return;
        }

        corpusFileRecords = corpus.files.map((f) => ({
          path: f.absolutePath,
          hash: f.hash,
        }));
        materialInventory = buildPhase1MaterialInventory({
          plan,
          planPath,
          store: materialStore,
        });

        planArtifacts = [
          planPath,
          ...materialStore.files
            .filter((file) => file.absolutePath !== planPath)
            .map((file) => file.absolutePath),
        ];
        planHash = createHash("sha256").update(planContent).digest("hex");
        if (!(await git.isCleanExcept(planArtifacts))) {
          ctx.ui.notify("pi-implement blocked: dirty worktree", "warning");
          return;
        }
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        ctx.ui.notify(`pi-implement blocked: ${reason}`, "warning");
        return;
      }

      const runIdNum = ++nextRunId;
      const abortController = new AbortController();

      const maxConcurrency = resolveMaxParallel(config.config);
      const initialStrategyReason = describeStrategy(maxConcurrency);
      let runId = "";
      let paths: ReturnType<typeof getStatePaths> | undefined;
      let now = "";
      for (let attempt = 0; attempt < 10; attempt++) {
        runId = makeRunIdWithSuffix(makeRunId(), new Set(listRunIds(repoRoot)));
        paths = getStatePaths(repoRoot, runId, checkoutIdentity);
        now = new Date().toISOString();
        const runJson = {
          version: 1 as const,
          runId,
          mode: "auto" as const,
          strategyReason: initialStrategyReason,
          repoRoot,
          checkoutRoot,
          planPath,
          planHash,
          corpusHash: corpus.corpusHash,
          corpusFiles: corpusFileRecords,
          baseSha,
          currentPhase: "preflight" as const,
          maxConcurrency,
          startedAt: now,
          updatedAt: now,
        };

        const lock = acquireRunLock(paths, runJson);
        if (!lock.ok) {
          ctx.ui.notify(`pi-implement blocked: ${lock.reason}`, "warning");
          return;
        }
        if (lock.staleRemoved) {
          ctx.ui.notify(
            `Removed stale pi-implement lock: ${lock.staleRemoved}.`,
            "info",
          );
        }
        try {
          createRunState(paths, runJson, planContent);
          writeFileSync(
            paths.corpusJson,
            JSON.stringify(
              {
                entryPath: corpus.entryPath,
                corpusHash: corpus.corpusHash,
                files: corpusFileRecords,
              },
              null,
              2,
            ),
            "utf-8",
          );
          appendEvent(paths, { type: "run_started", runId });
          break;
        } catch (err) {
          releaseRunLock(paths, runId);
          const nodeError = err as NodeJS.ErrnoException;
          if (nodeError.code === "EEXIST" && attempt < 9) {
            continue;
          }
          const reason = err instanceof Error ? err.message : String(err);
          ctx.ui.notify(`pi-implement blocked: ${reason}`, "warning");
          return;
        }
      }
      if (!paths) {
        ctx.ui.notify(
          "pi-implement blocked: could not allocate run state",
          "warning",
        );
        return;
      }

      const modeSource = "auto" as const;
      const initialTaskIndex =
        nextUncheckedTask(plan)?.index ??
        (plan.tasks.length > 0 ? plan.tasks.length : undefined);
      stopWidgetTick();
      active = {
        state: {
          phase: "preflight",
          planPath,
          runId,
          mode: "auto",
          modeSource,
          baseSha,
          currentMainHead: baseSha,
          maxConcurrency,
          startedAt: now,
          taskIndex: initialTaskIndex,
          totalTasks: plan.tasks.length,
        },
        stopping: false,
        runId: runIdNum,
        runDir: paths.runDir,
        abortController,
        activeSubagentIds: [],
      };
      lastStoppedState = undefined;
      syncStatus(ctx, active.state);
      ctx.ui.notify(`pi-implement started: ${planPath}`, "info");

      const taskTitles = plan.tasks.map((t) => t.text);

      pi.sendMessage({
        customType: "pi-implement-guidance",
        content: `pi-implement is now running and will autonomously implement the plan task-by-task using its own subagents. It owns the full implement → review → commit loop, including deciding what runs next.

Stay idle until the run ends or the user asks you something directly. Do not respond to pi-implement's internal progress updates, do not call get_subagent_result, do not start/stop/steer agents, and do not narrate or summarize progress yourself. pi-implement emits its own authoritative progress updates and a final completion/blocked notice.`,
        display: false,
      });

      const isCurrentRun = () => active.runId === runIdNum;
      const rawClient = new RuntimeSubagentClient(pi, ctx, runId);
      const client = new TrackingSubagentClient(
        rawClient,
        abortController.signal,
        (ids) => {
          if (!isCurrentRun()) {
            return;
          }
          active.activeSubagentIds = ids;
          setState(ctx, {
            activeSubagentIds: ids,
            activeSubagentId: ids.at(-1),
          });
        },
      );

      currentSnapshotClient = client;

      const updateState = (patch: StatePatch) => {
        if (!isCurrentRun()) {
          return;
        }
        const resolved =
          typeof patch === "function" ? patch(active.state) : patch;
        if ("activeSubagentIds" in resolved) {
          active.activeSubagentIds = resolved.activeSubagentIds ?? [];
        }
        const prevState = active.state;
        setState(ctx, resolved);
        for (const line of diffProgress(prevState, active.state, taskTitles)) {
          pi.sendMessage({
            customType: "pi-implement",
            content: line,
            display: true,
          });
        }
        const current = readRunJson(paths);
        if (current) {
          writeRunJson(paths, {
            ...current,
            currentPhase: resolved.phase ?? current.currentPhase,
            updatedAt: new Date().toISOString(),
          });
        }
      };

      void (async () => {
        updateState({ phase: "strategy" });
        const strategy = await selectStrategy({
          plan,
          planContent,
          planHash,
          repoRoot,
          baseSha,
          config: config.config,
          roles: effective.roles,
          subagents: client,
          paths,
          runId,
          signal: abortController.signal,
          updateState,
          materialStore,
          forceSerial,
        });
        if (strategy.mode === "blocked") {
          throw new BlockedError(strategy.reason);
        }
        throwIfCommandStopped(isCurrentRun, active, abortController);
        appendEvent(paths, {
          type: "strategy_selected",
          reason: strategy.reason,
          mode: strategy.mode,
        });
        const current = readRunJson(paths);
        if (current) {
          writeRunJson(paths, {
            ...current,
            mode: strategy.mode,
            strategyReason: strategy.reason,
            maxConcurrency: strategy.maxConcurrency,
            currentPhase: "preflight",
            updatedAt: new Date().toISOString(),
          });
        }
        updateState({
          phase: "preflight",
          mode: strategy.mode,
          maxConcurrency: strategy.maxConcurrency,
          lastReason: strategy.reason,
        });

        await runImplementation({
          git,
          subagents: client,
          planPath,
          planArtifacts,
          manifest,
          materialInventory,
          materialStore,
          roles: effective.roles,
          mode: strategy.mode,
          maxConcurrency: strategy.maxConcurrency,
          runId,
          paths,
          updateState,
          shouldStop: () =>
            !isCurrentRun() ||
            active.stopping ||
            abortController.signal.aborted,
          signal: abortController.signal,
          verifyCommand: config.config.verifyCommand,
        });
      })()
        .then(() => {
          currentSnapshotClient = undefined;
          if (!isCurrentRun()) {
            return;
          }
          setState(ctx, {
            phase: "done",
            activeSubagentId: undefined,
            activeSubagentIds: [],
          });
          ctx.ui.notify("pi-implement done.", "info");
          stopWidgetTick();
          if (ctx.mode === "tui") {
            ctx.ui.setStatus(STATUS_KEY, undefined);
            ctx.ui.setWidget(WIDGET_KEY, undefined);
          }
          // Auto-clean successful runs
          if (paths) {
            appendEvent(paths, { type: "run_done" });
            try {
              cleanupRun(paths);
            } catch (err) {
              const reason = err instanceof Error ? err.message : String(err);
              appendEvent(paths, { type: "cleanup_failed", reason });
              releaseRunLock(paths, runId);
              ctx.ui.notify(
                `pi-implement auto-cleanup warning: ${reason}`,
                "warning",
              );
            }
          }
        })
        .catch((err: unknown) => {
          currentSnapshotClient = undefined;
          if (!isCurrentRun()) {
            return;
          }
          if (err instanceof StoppedError) {
            const stoppedState: RunState = {
              ...active.state,
              phase: "stopped",
              activeSubagentId: undefined,
              activeSubagentIds: [],
              lastReason: "Stopped by user.",
            };
            active.state = stoppedState;
            lastStoppedState = stoppedState;
            syncStatus(ctx, stoppedState);
            if (paths) {
              appendEvent(paths, { type: "run_stopped" });
              releaseRunLock(paths, runId);
            }
          } else if (err instanceof OverallReviewFollowupError) {
            const followupState: RunState = {
              ...active.state,
              phase: "followup_required",
              activeSubagentId: undefined,
              activeSubagentIds: [],
              lastReason: err.message,
            };
            active.state = followupState;
            lastStoppedState = followupState;
            setState(ctx, followupState);
            ctx.ui.notify(
              `pi-implement follow-up required: ${err.message}`,
              "warning",
            );
            ctx.ui.notify(`Review artifact: ${err.artifactPath}`, "info");
            if (paths) {
              appendEvent(paths, {
                type: "run_blocked",
                reason: err.message,
              });
              try {
                cleanupRun(paths);
              } catch (cleanupErr) {
                const reason =
                  cleanupErr instanceof Error
                    ? cleanupErr.message
                    : String(cleanupErr);
                appendEvent(paths, { type: "cleanup_failed", reason });
                releaseRunLock(paths, runId);
                ctx.ui.notify(
                  `pi-implement auto-cleanup warning: ${reason}`,
                  "warning",
                );
              }
            }
            if (ctx.mode === "tui") {
              ctx.ui.setWidget(WIDGET_KEY, undefined);
            }
          } else {
            const reason =
              err instanceof BlockedError || err instanceof Error
                ? err.message
                : String(err);
            const blockedState: RunState = {
              ...active.state,
              phase: "blocked",
              activeSubagentId: undefined,
              activeSubagentIds: [],
              lastReason: reason,
            };
            active.state = blockedState;
            lastStoppedState = blockedState;
            setState(ctx, blockedState);
            ctx.ui.notify(`pi-implement blocked: ${reason}`, "warning");
            if (paths) {
              appendEvent(paths, { type: "run_blocked", reason });
              releaseRunLock(paths, runId);
            }
          }
          stopWidgetTick();
          if (ctx.mode === "tui") {
            ctx.ui.setWidget(WIDGET_KEY, undefined);
          }
        });
    },
  };

  pi.registerCommand("implement", implementCommand);
  pi.registerCommand("build", {
    ...implementCommand,
    description: "Alias for /implement",
  });
}

class TrackingSubagentClient implements SubagentClient {
  private readonly activeIds = new Set<string>();

  constructor(
    private readonly inner: SubagentClient,
    private readonly signal: AbortSignal,
    private readonly onChange: (ids: string[]) => void,
  ) {}

  probe(timeoutMs?: number) {
    return this.inner.probe(timeoutMs);
  }

  async spawn(args: SpawnArgs): Promise<string> {
    const id = await this.inner.spawn(args);
    this.activeIds.add(id);
    this.emitChange();
    return id;
  }

  async stop(id: string): Promise<void> {
    await this.inner.stop(id);
  }

  async waitFor(id: string, signal?: AbortSignal): Promise<SubagentResult> {
    try {
      return await this.inner.waitFor(id, signal ?? this.signal);
    } finally {
      this.activeIds.delete(id);
      this.emitChange();
    }
  }

  snapshots(ids?: string[]) {
    return this.inner.snapshots?.(ids) ?? [];
  }

  private emitChange(): void {
    this.onChange([...this.activeIds]);
  }
}

function activeSubagentIds(active: ActiveRun): string[] {
  return [
    ...(active.activeSubagentIds ?? []),
    ...(active.state.activeSubagentId ? [active.state.activeSubagentId] : []),
  ].filter((id, index, ids) => ids.indexOf(id) === index);
}

function throwIfCommandStopped(
  isCurrentRun: () => boolean,
  active: ActiveRun,
  abortController: AbortController,
): void {
  if (!isCurrentRun() || active.stopping || abortController.signal.aborted) {
    throw new StoppedError();
  }
}

function describeStrategy(maxConcurrency: number): string {
  return `Auto mode selected; effective max concurrency ${maxConcurrency}.`;
}

function syncStatus(ctx: ExtensionCommandContext, state: RunState): void {
  if (ctx.mode !== "tui") {
    return;
  }
  const parts = formatFooterStatusParts(state);
  if (!parts) {
    ctx.ui.setStatus(STATUS_KEY, undefined);
    return;
  }
  const color = parts.tone === "warning" ? "warning" : "success";
  const textColor = parts.tone === "warning" ? "warning" : "muted";
  ctx.ui.setStatus(
    STATUS_KEY,
    `${ctx.ui.theme.fg(color, parts.glyph)} ${ctx.ui.theme.fg(textColor, parts.text)}`,
  );
}

function syncWidget(ctx: ExtensionCommandContext, state: RunState): void {
  if (ctx.mode !== "tui") {
    return;
  }
  const ids = [
    ...(state.activeSubagentIds ?? []),
    ...(state.activeSubagentId ? [state.activeSubagentId] : []),
  ].filter((id, index, arr) => arr.indexOf(id) === index);
  const snapshots = currentSnapshotClient?.snapshots?.(ids) ?? [];
  const lines = formatWidgetLines(state, Date.now(), snapshots);
  ctx.ui.setWidget(WIDGET_KEY, lines.length > 0 ? lines : undefined);
}

function activeAgentRefs(state: RunState): AgentDisplayRef[] {
  const refs = (state.activeAgentRefs ?? []).filter((ref) =>
    state.activeSubagentIds === undefined
      ? true
      : state.activeSubagentIds.includes(ref.id),
  );
  const activeIds =
    state.activeSubagentIds ??
    (state.activeSubagentId ? [state.activeSubagentId] : []);
  const missingRefs = activeIds
    .filter((id) => !refs.some((ref) => ref.id === id))
    .map((id) => ({
      id,
      role: "implementer" as const,
      label: `Subagent ${id}`,
      startedAt: new Date(0).toISOString(),
    }));
  return [...refs, ...missingRefs];
}

function modelExists(ctx: ExtensionCommandContext, ref: string): boolean {
  const slash = ref.indexOf("/");
  if (slash === -1) {
    return false;
  }
  const provider = ref.slice(0, slash);
  const id = ref.slice(slash + 1);
  return Boolean(ctx.modelRegistry.find(provider, id));
}
