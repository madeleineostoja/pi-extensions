import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  parseGuardArgs,
  formatSteer,
  extractToolPath,
  formatModalTitle,
  formatSteerTitle,
} from "./utils";
import { decideToolCall, resolveChoice } from "./handler";

const FOOTER_KEY = "pi-guard.active";

const NON_INTERACTIVE_MSG =
  "guard mode auto-disabled: no interactive UI available in this session. Edits will proceed without confirmation.";

export default function (pi: ExtensionAPI) {
  let guardMode = true;
  let nonInteractiveNotified = false;
  const triggerTools = new Set<string>(["edit", "write"]);

  function applyMode(next: boolean) {
    guardMode = next;
  }

  function notifyNonInteractive(ctx: ExtensionContext) {
    if (nonInteractiveNotified) return;
    nonInteractiveNotified = true;
    process.stderr.write(`[pi-guard] ${NON_INTERACTIVE_MSG}\n`);
    ctx.ui.notify(NON_INTERACTIVE_MSG, "info");
  }

  function syncFooter(ctx: ExtensionContext) {
    if (!ctx.hasUI) return;
    const theme = ctx.ui.theme;
    if (guardMode) {
      ctx.ui.setStatus(
        FOOTER_KEY,
        `${theme.fg("success", "󰌾")} ${theme.fg("muted", "guarding")}`,
      );
    } else {
      ctx.ui.setStatus(
        FOOTER_KEY,
        `${theme.fg("warning", "󰌾")} ${theme.fg("warning", "guard off")}`,
      );
    }
  }

  pi.registerShortcut("ctrl+shift+g", {
    description: "Toggle edit guard mode",
    handler: async (ctx) => {
      applyMode(!guardMode);
      syncFooter(ctx);
    },
  });

  pi.on("session_start", async (event, ctx) => {
    const FRESH_START_REASONS = new Set<typeof event.reason>([
      "startup",
      "new",
      "fork",
    ]);
    if (FRESH_START_REASONS.has(event.reason)) {
      applyMode(true);
    }
    nonInteractiveNotified = false;

    if (!ctx.hasUI) {
      applyMode(false);
      notifyNonInteractive(ctx);
    }
    syncFooter(ctx);
  });

  pi.registerCommand("guard", {
    description: "Toggle edit guard mode",
    handler: async (args, ctx) => {
      const action = parseGuardArgs(args);
      if (action.kind === "invalid") {
        ctx.ui.notify("unknown: /guard [on|off|status]", "warning");
        return;
      }
      if (action.kind === "toggle") {
        applyMode(!guardMode);
      } else if (action.kind === "set") {
        if (action.value === guardMode) {
          ctx.ui.notify(
            `guard mode: already ${guardMode ? "on" : "off"}`,
            "info",
          );
          return;
        }
        applyMode(action.value);
      }
      syncFooter(ctx);
      ctx.ui.notify(`guard mode: ${guardMode ? "on" : "off"}`, "info");
    },
  });

  pi.on("tool_call", async (event, ctx) => {
    const decision = decideToolCall({
      guardMode,
      hasUI: ctx.hasUI,
      toolName: event.toolName,
      triggerTools,
      nonInteractiveAlreadyNotified: nonInteractiveNotified,
    });

    if (decision === "pass") return undefined;

    if (decision === "auto-disable") {
      applyMode(false);
      syncFooter(ctx);
      notifyNonInteractive(ctx);
      return undefined;
    }

    // decision === "prompt"
    const toolPath = extractToolPath(event.input);
    let choice: string | undefined;
    let message: string | undefined;
    try {
      choice = await ctx.ui.select(
        formatModalTitle(event.toolName, toolPath),
        ["Accept", "Accept and stop guarding", "Steer"],
        ctx.signal ? { signal: ctx.signal } : undefined,
      );

      if (choice === "Steer") {
        message =
          (await ctx.ui.input(
            formatSteerTitle(toolPath),
            "what should the agent do differently?",
          )) ?? "";
      }
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        return { block: true, reason: formatSteer("") };
      }
      throw err;
    }

    const result = resolveChoice({ choice, message });

    if (result.sideEffect === "disable") {
      applyMode(false);
      syncFooter(ctx);
    }

    return result.block ? { block: true, reason: result.reason } : undefined;
  });
}
