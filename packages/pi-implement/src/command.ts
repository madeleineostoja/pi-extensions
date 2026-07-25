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
import {
  stopVNextRun,
  startVNextRun,
  resumeVNextRun,
  type ActiveVNextRun,
} from "./vnext-command.js";
import {
  cleanupCompletedVNextRun,
  cleanupWithLease,
  formatVNextStatus,
  inspectVNextRun,
  listCheckoutVNextRuns,
} from "./vnext-controls.js";

export function registerImplementCommand(pi: ExtensionAPI): void {
  let active: ActiveVNextRun | undefined;

  pi.on("session_shutdown", async () => {
    if (active) {
      await stopVNextRun(active);
      active = undefined;
    }
  });

  pi.registerCommand("implement", {
    description: "Run a strict VNext implementation plan",
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
                "pi-implement has no active VNext run in this session.",
                "info",
              );
              return;
            }
            await stopVNextRun(active);
            active = undefined;
            ctx.ui.notify("pi-implement paused safely.", "info");
            return;
          }
          if (parsed.name === "status") {
            if (active) {
              ctx.ui.notify(formatVNextStatus(active.store.read()), "info");
              return;
            }
            const runs = listCheckoutVNextRuns(checkoutRoot);
            ctx.ui.notify(
              runs.length === 0
                ? "pi-implement: no VNext runs in this checkout."
                : runs
                    .map((run) =>
                      run.kind === "run"
                        ? formatVNextStatus(run.state)
                        : `Historical artifact: ${run.runId} (manual inspection/removal only)`,
                    )
                    .join("\n\n"),
              "info",
            );
            return;
          }
          if (parsed.name === "inspect") {
            if (!parsed.runId) {
              throw new Error("Inspect requires a VNext run ID.");
            }
            ctx.ui.notify(inspectVNextRun(checkoutRoot, parsed.runId), "info");
            return;
          }
          if (parsed.name === "cleanup") {
            if (!parsed.runId) {
              throw new Error("Cleanup requires a completed VNext run ID.");
            }
            if (active?.runId === parsed.runId) {
              const completed = active;
              await cleanupWithLease({
                lease: completed.lease,
                git: new (await import("./git.js")).ExecGitClient(checkoutRoot),
                runId: parsed.runId,
              });
              await completed.lease.release();
              active = undefined;
            } else {
              await cleanupCompletedVNextRun({
                checkoutRoot,
                runId: parsed.runId,
              });
            }
            ctx.ui.notify(
              `pi-implement cleaned VNext run ${parsed.runId}.`,
              "info",
            );
            return;
          }
          ctx.ui.notify(
            "VNext configuration is available in the extension config file.",
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
          "pi-implement already has an active VNext run in this session.",
          "warning",
        );
        return;
      }
      const config = readConfig(getAgentDir());
      const effective = resolveEffectiveRoles(config.config, ctx);
      if (!effective.ok) {
        ctx.ui.notify(`pi-implement blocked: ${effective.reason}`, "warning");
        return;
      }
      try {
        if (parsed.recovery?.kind === "start-over") {
          const checkoutRoot = await new (
            await import("./git.js")
          ).ExecGitClient(ctx.cwd).root();
          await cleanupCompletedVNextRun({
            checkoutRoot,
            runId: parsed.recovery.runId,
          });
        }
        if (parsed.recovery?.kind === "resume") {
          active = await resumeVNextRun({
            pi,
            ctx,
            planPath: parsed.planPath,
            runId: parsed.recovery.runId,
            roles: effective.roles,
          });
          ctx.ui.notify(
            `pi-implement resumed VNext run ${active.runId}.`,
            "info",
          );
          return;
        }
        const result = await startVNextRun({
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
        ctx.ui.notify(
          `pi-implement started VNext run ${active.runId}.`,
          "info",
        );
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
