import { resolve } from "node:path";
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

const STATUS_KEY = "pi-implement.status";

type ActiveRun = {
  state: RunState;
  stopping: boolean;
  runId: number;
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
    if (ctx.hasUI) {
      ctx.ui.setStatus(STATUS_KEY, undefined);
    }
  });

  pi.registerCommand("implement", {
    description: "Implement a /plan markdown file one task at a time",
    handler: async (args, ctx) => {
      const input = args.trim();

      if (!input) {
        ctx.ui.notify(`${usage()}\n\n${formatRunStatus(active.state)}`, "info");
        return;
      }

      if (input === "status") {
        ctx.ui.notify(formatRunStatus(active.state), "info");
        return;
      }

      if (input === "config") {
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

      if (input === "stop") {
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

      if (input.startsWith("-")) {
        ctx.ui.notify(usage(), "warning");
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

      const planPath = resolve(ctx.cwd, input);
      const runId = ++nextRunId;
      const abortController = new AbortController();
      active = {
        state: { phase: "preflight", planPath },
        stopping: false,
        runId,
        abortController,
      };
      syncStatus(ctx, active.state);
      ctx.ui.notify(`pi-implement started: ${planPath}`, "info");
      const isCurrentRun = () => active.runId === runId;
      void runImplementation({
        git: new ExecGitClient(ctx.cwd),
        subagents: new EventSubagentClient(pi.events),
        planPath,
        roles: effective.roles,
        updateState: (patch) => {
          if (isCurrentRun()) {
            setState(ctx, patch);
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
          }
          if (ctx.hasUI) {
            ctx.ui.setStatus(STATUS_KEY, undefined);
          }
        });
    },
  });
}

function syncStatus(ctx: ExtensionCommandContext, state: RunState): void {
  if (!ctx.hasUI) {
    return;
  }
  const text = formatFooterStatus(state);
  ctx.ui.setStatus(STATUS_KEY, text || undefined);
}

function usage(): string {
  return "Usage: /implement <plan.md> | /implement status | /implement stop | /implement config";
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
