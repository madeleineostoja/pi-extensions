import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  readConfig,
  resolveEffectiveRoles,
  resolveWorkerConcurrency,
} from "./config.js";
import { parseCommand, usage } from "./parser.js";
import { stopRun, startRun, resumeRun, type ActiveRun } from "./run.js";
import {
  abandonRun,
  cleanupCompletedRun,
  cleanupWithLease,
  formatStatus,
  inspectRun,
  listCheckoutRuns,
} from "./controls.js";

export function registerImplementCommand(pi: ExtensionAPI): void {
  let active: ActiveRun | undefined;

  pi.on("session_shutdown", async () => {
    if (active) {
      await stopRun(active);
      active = undefined;
    }
  });

  pi.registerCommand("implement", {
    description: "Run a strict implementation plan",
    handler: async (input: string, ctx: ExtensionCommandContext) => {
      const parsed = parseCommand(input);
      if (parsed.kind === "error") {
        ctx.ui.notify(parsed.message, "warning");
        return;
      }
      if (parsed.kind === "control") {
        try {
          const checkoutRoot = await new (
            await import("./git.js")
          ).ExecGitClient(ctx.cwd).root();
          if (parsed.name === "stop") {
            if (!active) {
              ctx.ui.notify(
                "pi-implement has no active run in this session.",
                "info",
              );
              return;
            }
            await stopRun(active);
            active = undefined;
            ctx.ui.notify("pi-implement paused safely.", "info");
            return;
          }
          if (parsed.name === "status") {
            if (active) {
              ctx.ui.notify(formatStatus(active.store.read()), "info");
              return;
            }
            const runs = listCheckoutRuns(checkoutRoot);
            ctx.ui.notify(
              runs.length === 0
                ? "pi-implement: no runs in this checkout."
                : runs
                    .map((run) =>
                      run.kind === "run"
                        ? formatStatus(run.state)
                        : `Historical artifact: ${run.runId} (manual inspection/removal only)`,
                    )
                    .join("\n\n"),
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
          if (parsed.name === "abandon") {
            if (!parsed.runId) {
              throw new Error(
                "Abandon requires a paused or safety-blocked run ID.",
              );
            }
            if (active?.runId === parsed.runId) {
              throw new Error(
                "Stop the active session run before abandoning it.",
              );
            }
            await abandonRun({ checkoutRoot, runId: parsed.runId });
            ctx.ui.notify(
              `pi-implement abandoned run ${parsed.runId}.`,
              "info",
            );
            return;
          }
          if (parsed.name === "cleanup") {
            if (!parsed.runId) {
              throw new Error("Cleanup requires a completed run ID.");
            }
            if (active?.runId === parsed.runId) {
              const completed = active;
              const projected = await cleanupWithLease({
                lease: completed.lease,
                git: new (await import("./git.js")).ExecGitClient(checkoutRoot),
                runId: parsed.runId,
              });
              if (projected.length > 0) {
                ctx.ui.notify(
                  `Projected tracked files are now ordinary working changes; commit or revert before the next run: ${projected.join(", ")}`,
                  "warning",
                );
              }
              await completed.lease.release();
              active = undefined;
            } else {
              const projected = await cleanupCompletedRun({
                checkoutRoot,
                runId: parsed.runId,
              });
              if (projected.length > 0) {
                ctx.ui.notify(
                  `Projected tracked files are now ordinary working changes; commit or revert before the next run: ${projected.join(", ")}`,
                  "warning",
                );
              }
            }
            ctx.ui.notify(`pi-implement cleaned run ${parsed.runId}.`, "info");
            return;
          }
          ctx.ui.notify(
            "Configuration is available in the extension config file.",
            "info",
          );
          return;
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          ctx.ui.notify(`pi-implement blocked: ${reason}`, "warning");
          return;
        }
      }
      if (active) {
        ctx.ui.notify(
          "pi-implement already has an active run in this session.",
          "warning",
        );
        return;
      }
      const config = readConfig(getAgentDir());
      if (config.warning) {
        ctx.ui.notify(`pi-implement config: ${config.warning}`, "warning");
      }
      const effective = resolveEffectiveRoles(config.config);
      try {
        if (parsed.recovery?.kind === "start-over") {
          const checkoutRoot = await new (
            await import("./git.js")
          ).ExecGitClient(ctx.cwd).root();
          await cleanupCompletedRun({
            checkoutRoot,
            runId: parsed.recovery.runId,
            prospectiveStart: true,
          });
        }
        if (parsed.recovery?.kind === "resume") {
          active = await resumeRun({
            pi,
            ctx,
            planPath: parsed.planPath,
            runId: parsed.recovery.runId,
            roles: effective.roles,
          });
          ctx.ui.notify(`pi-implement resumed run ${active.runId}.`, "info");
          return;
        }
        const result = await startRun({
          pi,
          ctx,
          planPath: parsed.planPath,
          roles: effective.roles,
          workerConcurrency: resolveWorkerConcurrency(config.config),
        });
        if (result.kind === "no-op") {
          ctx.ui.notify(
            "All plan tasks are already checked; no run was created.",
            "info",
          );
          return;
        }
        active = result.active;
        ctx.ui.notify(`pi-implement started run ${active.runId}.`, "info");
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`pi-implement blocked: ${reason}`, "warning");
      }
    },
  });
}

export function isActiveImplementPhase(phase: string): boolean {
  return ["planning", "running", "whole_plan_review", "stopping"].includes(
    phase,
  );
}

export function canStartImplementRun(phase: string): boolean {
  return !isActiveImplementPhase(phase);
}

export { usage };
