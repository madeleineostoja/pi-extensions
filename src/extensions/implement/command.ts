import { resolve } from "node:path";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { presetIssue, type ConfigSnapshot } from "#lib/config";
import { generateSessionName } from "#personality/session-name";
import { resolveImplementRoles } from "./subagents.js";
import { parseCommand, usage, type ParsedCommand } from "./parser.js";
import {
  stopRun,
  startRun,
  type ActiveRun,
  type CompletedRunResources,
} from "./run.js";
import {
  cleanupCompletedRun,
  cleanupRun,
  cleanupWithLease,
  formatStatus,
  inspectRun,
  listCheckoutRuns,
  releaseCompletedRunResources,
  type RunListing,
} from "./controls.js";
import { createImplementActivity } from "./activity.js";
import { createTerminalHandoffPublisher } from "./terminal-handoff-publisher.js";
import type { RunState } from "./store.js";

type ImplementActivity = ReturnType<typeof createImplementActivity>;

export function registerImplementCommand(
  pi: ExtensionAPI,
  config?: ConfigSnapshot,
): void {
  const roles = config && resolveImplementRoles(config.config.models);
  let active: ActiveRun | undefined;
  let activity: ImplementActivity | undefined;
  let lifecycle = Promise.resolve();
  let sessionGeneration = 0;
  let namingAbortController: AbortController | undefined;
  const handoffPublisher = createTerminalHandoffPublisher(pi);

  pi.on("session_start", () => {
    sessionGeneration++;
    namingAbortController?.abort();
    namingAbortController = undefined;
  });

  const runLifecycle = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = lifecycle.then(operation, operation);
    lifecycle = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  pi.on("agent_settled", (_event, ctx) => {
    handoffPublisher.flush(ctx);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    sessionGeneration++;
    namingAbortController?.abort();
    namingAbortController = undefined;
    handoffPublisher.dispose();
    return runLifecycle(async () => {
      activity?.clear();
      activity = undefined;
      const stopping = active;
      active = undefined;
      if (stopping) {
        const failures: string[] = [];
        await stopRun(stopping, "interrupted", async (run) => {
          failures.push(...(await resourceReleaseFailures(run)));
        });
        notifyResourceReleaseFailures(ctx, stopping.runId, failures);
      }
    });
  });

  pi.registerCommand("implement", {
    description: "Run and inspect strict implementation plans",
    handler: (input: string, ctx: ExtensionCommandContext) =>
      runLifecycle(async () => {
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
      }),
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
        const failures: string[] = [];
        await stopRun(stopping, "stopped", async (run) => {
          failures.push(...(await resourceReleaseFailures(run)));
        });
        notifyResourceReleaseFailures(ctx, stopping.runId, failures);
        ctx.ui.notify(
          stopping.store.read().phase === "completed"
            ? `Implement completed run ${stopping.runId} before stop settled.`
            : "Implement stopped and failed safely.",
          "info",
        );
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
      if (parsed.name === "cleanup-completed") {
        const runIds = completedRunIds(orderedRuns(checkoutRoot, active));
        if (runIds.length === 0) {
          ctx.ui.notify("Implement has no completed runs to clean.", "info");
          return;
        }
        if (!ctx.hasUI) {
          throw new Error(
            "Cleaning completed run history requires interactive confirmation.",
          );
        }
        const confirmed = await ctx.ui.confirm(
          "Clean completed runs",
          `Delete retained state and evidence for ${runIds.length} completed ${runIds.length === 1 ? "run" : "runs"}? Published commits and projected plan changes remain.`,
        );
        if (!confirmed) {
          return;
        }
        const failures: string[] = [];
        let cleaned = 0;
        for (const runId of runIds) {
          try {
            await cleanup(runId, checkoutRoot);
            cleaned += 1;
          } catch (error) {
            failures.push(
              `${runId}: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
        if (failures.length > 0) {
          ctx.ui.notify(
            `Implement cleaned ${cleaned} completed ${cleaned === 1 ? "run" : "runs"}; blocked ${failures.length}: ${failures.join("; ")}`,
            "warning",
          );
          return;
        }
        ctx.ui.notify(
          `Implement cleaned ${cleaned} completed ${cleaned === 1 ? "run" : "runs"}.`,
          "info",
        );
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
      await cleanup(parsed.runId, checkoutRoot);
      ctx.ui.notify(`Implement cleaned run ${parsed.runId}.`, "info");
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`Implement blocked: ${reason}`, "warning");
    }
  }

  async function cleanup(runId: string, checkoutRoot: string): Promise<void> {
    if (active?.runId !== runId) {
      await cleanupRun({ checkoutRoot, runId });
      return;
    }
    const owned = active;
    const state = owned.store.read();
    active = undefined;
    activity?.clear();
    activity = undefined;
    if (state.phase === "completed") {
      try {
        await cleanupWithLease({
          lease: owned.lease,
          git: owned.git,
          runId,
        });
      } finally {
        await owned.lease.release();
      }
      return;
    }
    await stopRun(owned);
    await cleanupRun({ checkoutRoot, runId });
  }

  async function finalizeCompletedRun(
    run: CompletedRunResources,
    ctx: ExtensionCommandContext,
  ): Promise<void> {
    if (active?.runId !== run.runId) {
      return;
    }
    const failures = await resourceReleaseFailures(run);
    active = undefined;
    try {
      await run.lease.release();
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
    notifyResourceReleaseFailures(ctx, run.runId, failures);
  }

  async function handleExecution(
    parsed: Extract<ParsedCommand, { kind: "execution" }>,
    ctx: ExtensionCommandContext,
  ): Promise<void> {
    const executionGeneration = sessionGeneration;
    if (active) {
      ctx.ui.notify(
        "Implement already has an active run in this session.",
        "warning",
      );
      return;
    }
    if (handoffPublisher.hasPending()) {
      ctx.ui.notify(
        "Implement has an undelivered terminal handoff in this session.",
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
    const nextActivity = createImplementActivity(pi.events, ctx);
    activity = nextActivity;
    const onTransition = (
      state: RunState,
      event: Parameters<
        NonNullable<Parameters<typeof startRun>[0]["onTransition"]>
      >[1],
    ) => {
      try {
        nextActivity.update(state, event);
      } catch {
        // Activity projection is not state authority.
      }
      try {
        handoffPublisher.capture(state, event, ctx);
      } catch {
        // Transcript delivery is not state authority.
      }
    };
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
        onCompleted: (run) => {
          void runLifecycle(() => finalizeCompletedRun(run, ctx));
        },
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
      beginSessionNaming(parsed.planPath, ctx, executionGeneration);
      ctx.ui.notify(`Implement started run ${active.runId}.`, "info");
    } catch (error) {
      nextActivity.clear();
      activity = undefined;
      const reason = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`Implement blocked: ${reason}`, "warning");
    }
  }

  function beginSessionNaming(
    planPath: string,
    ctx: ExtensionCommandContext,
    executionGeneration: number,
  ): void {
    if (executionGeneration !== sessionGeneration) {
      return;
    }
    namingAbortController?.abort();
    const abortController = new AbortController();
    namingAbortController = abortController;
    const generation = executionGeneration;

    void readImplementPlanExcerpt(ctx.cwd, planPath)
      .then((planExcerpt) =>
        generateSessionName(
          ctx,
          {
            utility: config?.config.models.utility,
            utilityIssue: config
              ? presetIssue(config, "utility")?.message
              : undefined,
            configPath: config?.path ?? "is unavailable",
          },
          { kind: "implement", planExcerpt },
          abortController.signal,
        ),
      )
      .then((result) => {
        if (
          generation !== sessionGeneration ||
          namingAbortController !== abortController ||
          result.outcome !== "success"
        ) {
          return;
        }
        namingAbortController = undefined;
        pi.setSessionName(result.title);
      });
  }
}

const MAX_IMPLEMENT_PLAN_EXCERPT_LINES = 80;
const MAX_IMPLEMENT_PLAN_EXCERPT_CHARS = 4_000;

export async function readImplementPlanExcerpt(
  cwd: string,
  planPath: string,
): Promise<string> {
  try {
    const { readFile } = await import("node:fs/promises");
    const content = await readFile(resolvePlanPath(cwd, planPath), "utf-8");
    return content
      .split(/\r?\n/)
      .slice(0, MAX_IMPLEMENT_PLAN_EXCERPT_LINES)
      .join("\n")
      .slice(0, MAX_IMPLEMENT_PLAN_EXCERPT_CHARS)
      .trimEnd();
  } catch {
    return "";
  }
}

function resolvePlanPath(cwd: string, planPath: string): string {
  return resolve(cwd, planPath);
}

async function resourceReleaseFailures(
  run: CompletedRunResources,
): Promise<string[]> {
  if (run.store.read().phase !== "completed") {
    return [];
  }
  try {
    await releaseCompletedRunResources(run);
    return [];
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
}

function notifyResourceReleaseFailures(
  ctx: Pick<ExtensionCommandContext, "ui">,
  runId: string,
  failures: string[],
): void {
  if (failures.length > 0) {
    ctx.ui.notify(
      `Implement completed run ${runId}, but automatic resource cleanup was blocked: ${failures.join("; ")}`,
      "warning",
    );
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
    const menuActions = implementMenuActions(runs);
    const selected = await ctx.ui.select("Implement", [
      ...labels,
      ...menuActions,
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
    if (selected === cleanCompletedRunsLabel(runs)) {
      return { kind: "control", name: "cleanup-completed" };
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

export function implementMenuActions(runs: RunListing[]): string[] {
  const cleanup = cleanCompletedRunsLabel(runs);
  return ["New run", ...(cleanup ? [cleanup] : []), "Close"];
}

export function runMenuActions(
  phase: RunState["phase"],
  current: boolean,
): string[] {
  const actions = ["Status", "Inspect"];
  if (current && !["completed", "incomplete", "failed"].includes(phase)) {
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

function completedRunIds(runs: RunListing[]): string[] {
  return runs.flatMap((run) =>
    run.kind === "run" && run.state.phase === "completed" ? [run.runId] : [],
  );
}

function cleanCompletedRunsLabel(runs: RunListing[]): string | undefined {
  const count = completedRunIds(runs).length;
  return count > 0 ? `Clean completed runs (${count})` : undefined;
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

async function resolveCheckoutRoot(cwd: string): Promise<string> {
  return new (await import("./git.js")).ExecGitClient(cwd).root();
}

export { usage };
