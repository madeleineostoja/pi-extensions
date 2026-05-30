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
import { EventSubagentClient } from "./subagents.js";
import {
  runImplementation,
  BlockedError,
  StoppedError,
} from "./orchestrator.js";
import type { RunState } from "./status.js";
import { formatFooterStatus, formatRunStatus } from "./status.js";
import { parseCommand } from "./parser.js";
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
} from "./state.js";

const STATUS_KEY = "pi-implement.status";

type ActiveRun = {
  state: RunState;
  stopping: boolean;
  runId: number;
  runDir?: string;
  abortController?: AbortController;
};

export function registerImplementCommand(pi: ExtensionAPI): void {
  let active: ActiveRun = {
    state: { phase: "idle" },
    stopping: false,
    runId: 0,
  };
  let nextRunId = 0;

  const setState = (ctx: ExtensionCommandContext, patch: Partial<RunState>) => {
    active.state = { ...active.state, ...patch };
    syncStatus(ctx, active.state);
  };

  pi.on("session_shutdown", async (_event, ctx) => {
    active.stopping = true;
    active.abortController?.abort();
    const activeSubagentId = active.state.activeSubagentId;
    if (activeSubagentId) {
      try {
        await new EventSubagentClient(pi.events).stop(activeSubagentId);
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
          ctx.ui.notify(formatRunStatus(active.state), "info");
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
          active.stopping = true;
          active.abortController?.abort();
          if (active.state.activeSubagentId) {
            setState(ctx, { phase: "stopping" });
            try {
              await new EventSubagentClient(pi.events).stop(
                active.state.activeSubagentId,
              );
            } catch (err) {
              const reason = err instanceof Error ? err.message : String(err);
              ctx.ui.notify(
                `pi-implement local run stopped, but stopping the active subagent failed: ${reason}`,
                "warning",
              );
            }
          }
          setState(ctx, {
            phase: "stopped",
            activeSubagentId: undefined,
            lastReason:
              "Stopped by user. Worktree may need manual cleanup before rerunning /implement.",
          });
          ctx.ui.notify(
            "pi-implement stopped. The worktree may need manual cleanup before rerunning /implement <plan.md>.",
            "warning",
          );
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
          const git = new ExecGitClient(ctx.cwd);
          const repoRoot = await git.root();
          const runIds = listRunIds(repoRoot);
          const activeNonTerminalPhases = new Set([
            "preflight",
            "coding",
            "reviewing",
            "committing",
            "stopping",
          ]);
          const skipDir =
            active.runDir && activeNonTerminalPhases.has(active.state.phase)
              ? active.runDir
              : undefined;
          let cleaned = 0;
          let skipped = 0;
          for (const runId of runIds) {
            const paths = getStatePaths(repoRoot, runId);
            if (skipDir && paths.runDir === skipDir) {
              skipped++;
              continue;
            }
            try {
              cleanupRun(paths);
              cleaned++;
            } catch (err) {
              const reason = err instanceof Error ? err.message : String(err);
              ctx.ui.notify(
                `Cleanup failed for ${runId}: ${reason}`,
                "warning",
              );
            }
          }
          const suffix = skipped
            ? ` (skipped ${skipped} active run${skipped === 1 ? "" : "s"}).`
            : ".";
          ctx.ui.notify(
            `pi-implement cleanup: removed ${cleaned} run(s)${suffix}`,
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
      let planArtifacts: string[];
      let planHash: string;
      try {
        git = new ExecGitClient(ctx.cwd);
        repoRoot = await git.root();
        baseSha = await git.head();
        planContent = readFileSync(planPath, "utf-8");
        const plan = parsePlanFile(planPath);
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

      // Compute effective concurrency
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

      const strategyReason = describeStrategy(parsed.mode, maxConcurrency);
      const now = new Date().toISOString();
      const runJson = {
        version: 1 as const,
        runId,
        mode,
        strategyReason,
        repoRoot,
        planPath,
        planHash,
        baseSha,
        currentPhase: "preflight",
        maxConcurrency,
        startedAt: now,
        updatedAt: now,
      };

      createRunState(paths, runJson, planContent);
      appendEvent(paths, { type: "run_started", runId });
      appendEvent(paths, {
        type: "strategy_selected",
        reason: strategyReason,
        mode,
      });

      active = {
        state: { phase: "preflight", planPath },
        stopping: false,
        runId: runIdNum,
        runDir: paths.runDir,
        abortController,
      };
      syncStatus(ctx, active.state);
      ctx.ui.notify(`pi-implement started: ${planPath}`, "info");

      const isCurrentRun = () => active.runId === runIdNum;

      void runImplementation({
        git,
        subagents: new EventSubagentClient(pi.events),
        planPath,
        planArtifacts,
        roles: effective.roles,
        mode,
        maxConcurrency,
        runId,
        paths,
        updateState: (patch) => {
          if (isCurrentRun()) {
            setState(ctx, patch);
            if (paths) {
              const current = readRunJson(paths);
              if (current) {
                writeRunJson(paths, {
                  ...current,
                  currentPhase: patch.phase ?? current.currentPhase,
                  updatedAt: new Date().toISOString(),
                });
              }
            }
          }
        },
        shouldStop: () =>
          !isCurrentRun() || active.stopping || abortController.signal.aborted,
        signal: abortController.signal,
      })
        .then(() => {
          if (!isCurrentRun()) {
            return;
          }
          setState(ctx, { phase: "done", activeSubagentId: undefined });
          ctx.ui.notify("pi-implement done.", "info");
          if (ctx.hasUI) {
            ctx.ui.setStatus(STATUS_KEY, undefined);
          }
          // Auto-clean successful serial runs
          if (paths) {
            appendEvent(paths, { type: "run_done" });
            cleanupRun(paths);
          }
        })
        .catch((err: unknown) => {
          if (!isCurrentRun()) {
            return;
          }
          if (err instanceof StoppedError) {
            setState(ctx, {
              phase: "stopped",
              activeSubagentId: undefined,
              lastReason: "Stopped by user.",
            });
            if (paths) {
              appendEvent(paths, { type: "run_stopped" });
            }
          } else {
            const reason =
              err instanceof BlockedError || err instanceof Error
                ? err.message
                : String(err);
            setState(ctx, {
              phase: "blocked",
              activeSubagentId: undefined,
              lastReason: reason,
            });
            ctx.ui.notify(`pi-implement blocked: ${reason}`, "warning");
            if (paths) {
              appendEvent(paths, { type: "run_blocked", reason });
            }
          }
          if (ctx.hasUI) {
            ctx.ui.setStatus(STATUS_KEY, undefined);
          }
        });
    },
  });
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
