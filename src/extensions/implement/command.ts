import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import type { ConfigSnapshot } from "#lib/config";
import { resolveImplementRoles } from "./subagents.js";
import { parseCommand, usage, type ParsedCommand } from "./parser.js";
import { stopRun, startRun, type ActiveRun } from "./run.js";
import {
  cleanupCompletedRun,
  cleanupRun,
  cleanupWithLease,
  formatStatus,
  inspectRun,
  listCheckoutRuns,
  type RunListing,
} from "./controls.js";
import { createTemporaryActivity } from "./temporary-activity.js";
import type { RunState } from "./store.js";

type TemporaryActivity = ReturnType<typeof createTemporaryActivity>;

export function registerImplementCommand(
  pi: ExtensionAPI,
  config?: ConfigSnapshot,
): void {
  const roles = config && resolveImplementRoles(config.config.models);
  let active: ActiveRun | undefined;
  let activity: TemporaryActivity | undefined;

  pi.on("session_shutdown", async () => {
    activity?.clear();
    activity = undefined;
    const stopping = active;
    active = undefined;
    if (stopping) {
      await stopRun(stopping, "interrupted");
    }
  });

  pi.registerCommand("implement", {
    description: "Run and inspect strict implementation plans",
    handler: async (input: string, ctx: ExtensionCommandContext) => {
      const parsed = input.trim()
        ? parseCommand(input)
        : await showImplementMenu(ctx, active);
      if (!parsed) {
        return;
      }
      if (parsed.kind === "error") {
        ctx.ui.notify(parsed.message, "warning");
        return;
      }
      if (parsed.kind === "control") {
        await handleControl(parsed, ctx);
        return;
      }
      await handleExecution(parsed, ctx);
    },
  });

  async function handleControl(
    parsed: Extract<ParsedCommand, { kind: "control" }>,
    ctx: ExtensionCommandContext,
  ): Promise<void> {
    try {
      const checkoutRoot = await resolveCheckoutRoot(ctx.cwd);
      if (parsed.name === "stop") {
        if (!active) {
          ctx.ui.notify("Implement has no active run in this session.", "info");
          return;
        }
        const stopping = active;
        active = undefined;
        activity?.clear();
        activity = undefined;
        await stopRun(stopping);
        ctx.ui.notify("Implement stopped and failed safely.", "info");
        return;
      }
      if (parsed.name === "status") {
        if (parsed.runId) {
          const run = findRun(checkoutRoot, parsed.runId, active);
          ctx.ui.notify(formatRunListing(run), "info");
          return;
        }
        if (active) {
          ctx.ui.notify(formatStatus(active.store.read()), "info");
          return;
        }
        const runs = listCheckoutRuns(checkoutRoot);
        ctx.ui.notify(
          runs.length === 0
            ? "Implement: no runs in this checkout."
            : runs.map(formatRunListing).join("\n\n"),
          "info",
        );
        return;
      }
      if (parsed.name === "inspect") {
        if (!parsed.runId) {
          throw new Error("Inspect requires a run ID.");
        }
        ctx.ui.notify(inspectRun(checkoutRoot, parsed.runId), "info");
        return;
      }
      if (!parsed.runId) {
        throw new Error("Cleanup requires a run ID.");
      }
      const state = runState(checkoutRoot, parsed.runId, active);
      if (state.phase !== "completed") {
        if (!ctx.hasUI) {
          throw new Error(
            "Cleaning up an incomplete run requires interactive confirmation.",
          );
        }
        const confirmed = await ctx.ui.confirm(
          "Clean up incomplete run",
          `Run ${parsed.runId} is ${state.phase.replaceAll("_", " ")}. Cleaning it up terminalizes interrupted work if needed, settles exact durable transactions, preserves already-published target and plan changes, and removes only proven owned resources. Continue?`,
        );
        if (!confirmed) {
          return;
        }
      }
      const projected = await cleanup(parsed.runId, checkoutRoot);
      notifyProjectedChanges(ctx, projected);
      ctx.ui.notify(`Implement cleaned run ${parsed.runId}.`, "info");
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`Implement blocked: ${reason}`, "warning");
    }
  }

  async function cleanup(
    runId: string,
    checkoutRoot: string,
  ): Promise<string[]> {
    if (active?.runId !== runId) {
      return cleanupRun({ checkoutRoot, runId });
    }
    const owned = active;
    const state = owned.store.read();
    active = undefined;
    activity?.clear();
    activity = undefined;
    if (state.phase === "completed") {
      try {
        return await cleanupWithLease({
          lease: owned.lease,
          git: new (await import("./git.js")).ExecGitClient(checkoutRoot),
          runId,
        });
      } finally {
        await owned.lease.release();
      }
    }
    await stopRun(owned);
    return cleanupRun({ checkoutRoot, runId });
  }

  async function handleExecution(
    parsed: Extract<ParsedCommand, { kind: "execution" }>,
    ctx: ExtensionCommandContext,
  ): Promise<void> {
    if (active) {
      ctx.ui.notify(
        "Implement already has an active run in this session.",
        "warning",
      );
      return;
    }
    if (!roles || !config) {
      ctx.ui.notify(
        `Pipkin config ${config?.path ?? "is unavailable"} is missing a valid medium or high model preset.`,
        "warning",
      );
      return;
    }
    activity?.clear();
    const nextActivity = createTemporaryActivity(ctx);
    activity = nextActivity;
    nextActivity.starting(parsed.planPath);
    const onTransition = (
      state: RunState,
      event: Parameters<
        NonNullable<Parameters<typeof startRun>[0]["onTransition"]>
      >[1],
    ) => nextActivity.update(state, event);
    try {
      if (parsed.restart) {
        const checkoutRoot = await resolveCheckoutRoot(ctx.cwd);
        await cleanupCompletedRun({
          checkoutRoot,
          runId: parsed.restart.runId,
          prospectiveStart: true,
        });
      }
      const result = await startRun({
        pi,
        ctx,
        planPath: parsed.planPath,
        roles,
        workerConcurrency: config.config.implement.workerConcurrency,
        onTransition,
      });
      if (result.kind === "no-op") {
        nextActivity.clear();
        activity = undefined;
        ctx.ui.notify(
          "All plan tasks are already checked; no run was created.",
          "info",
        );
        return;
      }
      active = result.active;
      nextActivity.update(active.store.read());
      ctx.ui.notify(`Implement started run ${active.runId}.`, "info");
    } catch (error) {
      nextActivity.clear();
      activity = undefined;
      const reason = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`Implement blocked: ${reason}`, "warning");
    }
  }
}

async function showImplementMenu(
  ctx: ExtensionCommandContext,
  active: ActiveRun | undefined,
): Promise<ParsedCommand | undefined> {
  if (ctx.mode !== "tui") {
    return { kind: "error", message: usage() };
  }
  let root: string;
  try {
    root = await resolveCheckoutRoot(ctx.cwd);
  } catch (error) {
    ctx.ui.notify(
      `Implement unavailable: ${error instanceof Error ? error.message : String(error)}`,
      "warning",
    );
    return;
  }

  while (true) {
    const runs = orderedRuns(root, active);
    const labels = runs.map(runMenuLabel);
    const selected = await ctx.ui.select("Implement", [
      ...labels,
      "New run",
      "Close",
    ]);
    if (!selected || selected === "Close") {
      return;
    }
    if (selected === "New run") {
      const planPath = await ctx.ui.input("Plan path", "path/to/plan.md");
      return planPath?.trim()
        ? { kind: "execution", planPath: planPath.trim() }
        : undefined;
    }
    const index = labels.indexOf(selected);
    const run = runs[index];
    if (!run || run.kind === "historical") {
      ctx.ui.notify(
        "Historical artifacts require manual inspection or removal.",
        "warning",
      );
      continue;
    }
    const action = await showRunMenu(ctx, run, active?.runId === run.runId);
    if (action === "back") {
      continue;
    }
    return action;
  }
}

async function showRunMenu(
  ctx: ExtensionCommandContext,
  run: Extract<RunListing, { kind: "run" }>,
  current: boolean,
): Promise<ParsedCommand | "back" | undefined> {
  const actions = runMenuActions(run.state.phase, current);

  const action = await ctx.ui.select(
    `${run.runId} · ${run.state.phase.replaceAll("_", " ")}`,
    actions,
  );
  if (!action) {
    return;
  }
  if (action === "Back") {
    return "back";
  }
  if (action === "Status") {
    return { kind: "control", name: "status", runId: run.runId };
  }
  if (action === "Inspect") {
    return { kind: "control", name: "inspect", runId: run.runId };
  }
  if (action === "Stop") {
    return { kind: "control", name: "stop" };
  }
  if (action === "Clean up") {
    return { kind: "control", name: "cleanup", runId: run.runId };
  }
  const planPath = await ctx.ui.input("Plan path", "path/to/plan.md");
  if (!planPath?.trim()) {
    return;
  }
  return {
    kind: "execution",
    planPath: planPath.trim(),
    restart: { runId: run.runId },
  };
}

export function runMenuActions(
  phase: RunState["phase"],
  current: boolean,
): string[] {
  const actions = ["Status", "Inspect"];
  if (current && !["completed", "failed"].includes(phase)) {
    actions.push("Stop");
  }
  if (!current && phase === "completed") {
    actions.push("Restart");
  }
  actions.push("Clean up");
  return [...actions, "Back"];
}

function orderedRuns(
  checkoutRoot: string,
  active: ActiveRun | undefined,
): RunListing[] {
  const runs = listCheckoutRuns(checkoutRoot);
  if (!active) {
    return runs;
  }
  const current: RunListing = {
    kind: "run",
    runId: active.runId,
    state: active.store.read(),
  };
  return [current, ...runs.filter((run) => run.runId !== active.runId)];
}

function runMenuLabel(run: RunListing): string {
  return run.kind === "historical"
    ? `${run.runId} · historical`
    : `${run.runId} · ${run.state.phase.replaceAll("_", " ")}`;
}

function findRun(
  checkoutRoot: string,
  runId: string,
  active: ActiveRun | undefined,
): RunListing {
  if (active?.runId === runId) {
    return { kind: "run", runId, state: active.store.read() };
  }
  const run = listCheckoutRuns(checkoutRoot).find(
    (candidate) => candidate.runId === runId,
  );
  if (!run) {
    throw new Error(`Run ${runId} is unavailable in this checkout.`);
  }
  return run;
}

function runState(
  checkoutRoot: string,
  runId: string,
  active: ActiveRun | undefined,
): RunState {
  const run = findRun(checkoutRoot, runId, active);
  if (run.kind === "historical") {
    throw new Error("Historical artifacts require manual cleanup.");
  }
  return run.state;
}

function formatRunListing(run: RunListing): string {
  return run.kind === "run"
    ? formatStatus(run.state)
    : `Historical artifact: ${run.runId} (manual inspection/removal only)`;
}

function notifyProjectedChanges(
  ctx: ExtensionCommandContext,
  projected: string[],
): void {
  if (projected.length > 0) {
    ctx.ui.notify(
      `Projected tracked files are now ordinary working changes; commit or revert before the next run: ${projected.join(", ")}`,
      "warning",
    );
  }
}

async function resolveCheckoutRoot(cwd: string): Promise<string> {
  return new (await import("./git.js")).ExecGitClient(cwd).root();
}

export { usage };
