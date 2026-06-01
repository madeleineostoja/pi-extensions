import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import {
  getGlobalReviewAgentPath,
  globalReviewAgentExists,
  scaffoldGlobalReviewAgent,
} from "./agents.js";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  readConfig,
  resolveEffectiveRoles,
  formatConfigStatus,
  isModelRef,
  resolveMaxParallel,
} from "./config.js";
import { ExecGitClient } from "./git.js";
import {
  EventSubagentClient,
  type SpawnArgs,
  type SubagentClient,
  type SubagentResult,
} from "./subagents.js";
import {
  runImplementation,
  BlockedError,
  StoppedError,
} from "./orchestrator.js";
import type { RunState } from "./status.js";
import { formatFooterStatus, formatRunStatus } from "./status.js";
import { parseCommand } from "./parser.js";
import { selectStrategy } from "./strategy.js";
import type { ExecutionMode } from "./parser.js";
import { resolvePlanArtifacts } from "./artifacts.js";
import { parsePlanFile } from "./plan.js";
import {
  getStatePaths,
  makeRunId,
  makeRunIdWithSuffix,
  createRunState,
  writeRunJson,
  readRunJson,
  appendEvent,
  cleanupRun,
  listRunIds,
  acquireRunLock,
  releaseRunLock,
  checkRunLock,
} from "./state.js";

const STATUS_KEY = "pi-implement.status";

type ActiveRun = {
  state: RunState;
  stopping: boolean;
  runId: number;
  runDir?: string;
  abortController?: AbortController;
  activeSubagentIds?: string[];
};

const ACTIVE_PHASES = new Set([
  "preflight",
  "strategy",
  "scheduling",
  "coding",
  "reviewing",
  "committing",
  "integrating",
  "reworking",
  "stopping",
]);

export function registerImplementCommand(pi: ExtensionAPI): void {
  let active: ActiveRun = {
    state: { phase: "idle" },
    stopping: false,
    runId: 0,
  };
  let nextRunId = 0;
  let lastStoppedState: RunState | undefined;

  const setState = (ctx: ExtensionCommandContext, patch: Partial<RunState>) => {
    active.state = { ...active.state, ...patch };
    syncStatus(ctx, active.state);
  };

  pi.on("session_shutdown", async (_event, ctx) => {
    active.stopping = true;
    active.abortController?.abort();
    const ids = activeSubagentIds(active);
    const client = new EventSubagentClient(pi.events);
    for (const id of ids) {
      try {
        await client.stop(id);
      } catch {
        // Best-effort: session is shutting down anyway.
      }
    }
    if (ctx.hasUI) {
      ctx.ui.setStatus(STATUS_KEY, undefined);
    }
  });

  pi.registerCommand("implement", {
    description: "Implement a /plan markdown file one task at a time",
    handler: async (args, ctx) => {
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
          ctx.ui.notify(
            formatConfigStatus(
              config,
              effective.ok ? effective.roles : undefined,
            ),
            config.warning ? "warning" : "info",
          );
          return;
        }

        if (parsed.name === "stop") {
          if (!ACTIVE_PHASES.has(active.state.phase)) {
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
            const client = new EventSubagentClient(pi.events);
            for (const id of ids) {
              try {
                await client.stop(id);
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
          if (ctx.hasUI) {
            ctx.ui.setStatus(STATUS_KEY, undefined);
          }
          return;
        }

        if (parsed.name === "agents") {
          const agentDir = getAgentDir();
          const targetPath = getGlobalReviewAgentPath(agentDir);
          if (globalReviewAgentExists(agentDir)) {
            ctx.ui.notify(
              `A global review agent already exists at ${targetPath}.`,
              "warning",
            );
            return;
          }
          const confirmed = await ctx.ui.confirm(
            "Install pi-implement review agent?",
            `Create global pi-subagents agent "review" at ${targetPath}?`,
          );
          if (!confirmed) {
            ctx.ui.notify("pi-implement agents cancelled.", "info");
            return;
          }
          const result = scaffoldGlobalReviewAgent(agentDir);
          if (!result.ok) {
            ctx.ui.notify(result.reason, "warning");
            return;
          }
          ctx.ui.notify(
            `Created global review agent at ${result.path}. Configure pi-implement with reviewer.type = "review" to use it.`,
            "info",
          );
          return;
        }

        if (parsed.name === "cleanup") {
          if (ACTIVE_PHASES.has(active.state.phase)) {
            ctx.ui.notify(
              "pi-implement cleanup refused: a run is currently active. Use `/implement stop` first.",
              "warning",
            );
            return;
          }
          const git = new ExecGitClient(ctx.cwd);
          const repoRoot = await git.root();
          const lockCheck = checkRunLock(getStatePaths(repoRoot, "lock-check"));
          if (lockCheck.active) {
            ctx.ui.notify(
              `pi-implement cleanup refused: ${lockCheck.reason}. Use /implement stop in that session first.`,
              "warning",
            );
            return;
          }
          if (lockCheck.staleRemoved) {
            ctx.ui.notify(
              `Removed stale pi-implement lock: ${lockCheck.staleRemoved}.`,
              "info",
            );
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
          ctx.ui.notify(
            `pi-implement cleanup: removed ${cleaned} run(s).`,
            "info",
          );
          return;
        }

        return;
      }

      if (
        !["idle", "done", "stopped", "blocked"].includes(active.state.phase)
      ) {
        ctx.ui.notify(
          `pi-implement is already running.\n\n${formatRunStatus(active.state)}`,
          "warning",
        );
        return;
      }

      const probe = await new EventSubagentClient(pi.events).probe();
      if (!probe.ok) {
        ctx.ui.notify(
          "pi-implement requires the pi-subagents extension, which is not installed or not responding. Install @tintinweb/pi-subagents and reload.",
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

      const mode = parsed.mode.kind;
      const planPath = resolve(ctx.cwd, parsed.mode.planPath);

      const invalid = [
        effective.roles.implementer.model,
        effective.roles.reviewer.model,
      ].filter((model) => !isModelRef(model));
      if (invalid.length) {
        ctx.ui.notify(
          `Invalid model reference(s): ${invalid.join(", ")}. Expected provider/model-id.`,
          "warning",
        );
        return;
      }
      const missing = [
        effective.roles.implementer.model,
        effective.roles.reviewer.model,
      ].filter((model) => !modelExists(ctx, model));
      if (missing.length) {
        ctx.ui.notify(
          `Model not found: ${[...new Set(missing)].join(", ")}`,
          "warning",
        );
        return;
      }

      if (mode !== "serial") {
        if (!isModelRef(effective.roles.planner.model)) {
          ctx.ui.notify(
            `Invalid planner model reference: ${effective.roles.planner.model}. Expected provider/model-id.`,
            "warning",
          );
          return;
        }
        if (!modelExists(ctx, effective.roles.planner.model)) {
          ctx.ui.notify(
            `Planner model not found: ${effective.roles.planner.model}`,
            "warning",
          );
          return;
        }
      }

      let git: ExecGitClient;
      let repoRoot: string;
      let baseSha: string;
      let planContent: string;
      let plan: ReturnType<typeof parsePlanFile>;
      let planArtifacts: string[];
      let planHash: string;
      try {
        git = new ExecGitClient(ctx.cwd);
        repoRoot = await git.root();
        baseSha = await git.head();
        planContent = readFileSync(planPath, "utf-8");
        plan = parsePlanFile(planPath);
        planArtifacts = resolvePlanArtifacts(planPath, plan);
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

      const requestedConcurrency =
        mode === "parallel" ? parsed.mode.concurrency : undefined;
      const maxConcurrency = resolveMaxParallel(
        config.config,
        requestedConcurrency,
      );

      const runId = makeRunIdWithSuffix(
        makeRunId(),
        new Set(listRunIds(repoRoot)),
      );
      const paths = getStatePaths(repoRoot, runId);

      const initialStrategyReason = describeStrategy(
        parsed.mode,
        maxConcurrency,
      );
      const now = new Date().toISOString();
      const runJson = {
        version: 1 as const,
        runId,
        mode,
        strategyReason: initialStrategyReason,
        repoRoot,
        planPath,
        planHash,
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
        appendEvent(paths, { type: "run_started", runId });
      } catch (err) {
        releaseRunLock(paths, runId);
        const reason = err instanceof Error ? err.message : String(err);
        ctx.ui.notify(`pi-implement blocked: ${reason}`, "warning");
        return;
      }

      const modeSource = parsed.mode.kind === "auto" ? "auto" : "cli";
      active = {
        state: {
          phase: "preflight",
          planPath,
          runId,
          mode,
          modeSource,
          baseSha,
          currentMainHead: baseSha,
          maxConcurrency,
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

      const isCurrentRun = () => active.runId === runIdNum;
      const rawClient = new EventSubagentClient(pi.events);
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

      const updateState = (patch: Partial<RunState>) => {
        if (!isCurrentRun()) {
          return;
        }
        if ("activeSubagentIds" in patch) {
          active.activeSubagentIds = patch.activeSubagentIds ?? [];
        }
        setState(ctx, patch);
        const current = readRunJson(paths);
        if (current) {
          writeRunJson(paths, {
            ...current,
            currentPhase: patch.phase ?? current.currentPhase,
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
          requestedMode: mode,
          requestedConcurrency,
          signal: abortController.signal,
        });
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
          if (!isCurrentRun()) {
            return;
          }
          setState(ctx, {
            phase: "done",
            activeSubagentId: undefined,
            activeSubagentIds: [],
          });
          ctx.ui.notify("pi-implement done.", "info");
          if (ctx.hasUI) {
            ctx.ui.setStatus(STATUS_KEY, undefined);
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
          if (ctx.hasUI) {
            ctx.ui.setStatus(STATUS_KEY, undefined);
          }
        });
    },
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

function describeStrategy(mode: ExecutionMode, maxConcurrency: number): string {
  if (mode.kind === "serial") {
    return "Serial mode requested via --serial.";
  }
  if (mode.kind === "parallel") {
    return `Parallel mode requested via --parallel ${mode.concurrency}; effective concurrency ${maxConcurrency}.`;
  }
  return `Auto mode selected; effective max concurrency ${maxConcurrency}.`;
}

function syncStatus(ctx: ExtensionCommandContext, state: RunState): void {
  if (!ctx.hasUI) {
    return;
  }
  const text = formatFooterStatus(state);
  ctx.ui.setStatus(STATUS_KEY, text || undefined);
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
