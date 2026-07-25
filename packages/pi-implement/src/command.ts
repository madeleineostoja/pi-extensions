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
        if (parsed.name !== "stop") {
          ctx.ui.notify(
            "This control moves to checkout-local VNext inspection in a later update.",
            "info",
          );
          return;
        }
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
        if (parsed.recovery) {
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
