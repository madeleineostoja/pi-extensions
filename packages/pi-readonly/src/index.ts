import type {
  ExtensionAPI,
  ExtensionContext,
  MessageRenderer,
} from "@earendil-works/pi-coding-agent";
import {
  parseReadonlyArgs,
  formatSteer,
  extractToolPath,
  formatModalTitle,
  formatSteerTitle,
} from "./utils";
import { decideToolCall, resolveChoice } from "./handler";

const FOOTER_KEY = "pi-readonly.mode";
const MESSAGE_TYPE = "pi-readonly.status";
const READONLY_ICON = "󰏯";
const EDITING_ICON = "󰏫";

type StatusDetails = {
  message: string;
};

const NON_INTERACTIVE_MSG =
  "readonly mode auto-disabled: no interactive UI available in this session. Edits will proceed without confirmation.";

const renderStatusMessage: MessageRenderer<StatusDetails> = (
  message,
  _options,
  theme,
) => {
  const text = message.details?.message ?? String(message.content);
  return {
    render: () => [theme.fg("dim", text)],
    invalidate: () => {},
  };
};

export default function (pi: ExtensionAPI) {
  let readonlyMode = true;
  let nonInteractiveNotified = false;
  const triggerTools = new Set<string>(["edit", "write"]);

  function applyMode(next: boolean) {
    readonlyMode = next;
  }

  function notifyNonInteractive() {
    if (nonInteractiveNotified) {
      return;
    }
    nonInteractiveNotified = true;
    const message = `[pi-readonly] ${NON_INTERACTIVE_MSG}`;
    pi.sendMessage({
      customType: MESSAGE_TYPE,
      content: message,
      display: true,
      details: { message },
    });
  }

  function syncFooter(ctx: ExtensionContext) {
    if (!ctx.hasUI) {
      return;
    }
    const theme = ctx.ui.theme;
    if (readonlyMode) {
      ctx.ui.setStatus(
        FOOTER_KEY,
        `${theme.fg("success", READONLY_ICON)} ${theme.fg("muted", "readonly")}`,
      );
    } else {
      ctx.ui.setStatus(
        FOOTER_KEY,
        `${theme.fg("warning", EDITING_ICON)} ${theme.fg("warning", "editing")}`,
      );
    }
  }

  pi.registerMessageRenderer(MESSAGE_TYPE, renderStatusMessage);

  pi.registerShortcut("ctrl+shift+r", {
    description: "Toggle readonly mode",
    handler: async (ctx) => {
      applyMode(!readonlyMode);
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
      notifyNonInteractive();
    }
    syncFooter(ctx);
  });

  pi.registerCommand("readonly", {
    description: "Toggle readonly mode",
    handler: async (args, ctx) => {
      const action = parseReadonlyArgs(args);
      if (action.kind === "invalid") {
        ctx.ui.notify("unknown: /readonly [on|off]", "warning");
        return;
      }
      if (action.kind === "toggle") {
        applyMode(!readonlyMode);
      } else if (action.kind === "set") {
        if (action.value === readonlyMode) {
          ctx.ui.notify(
            `readonly mode: already ${readonlyMode ? "on" : "off"}`,
            "info",
          );
          return;
        }
        applyMode(action.value);
      }
      syncFooter(ctx);
      ctx.ui.notify(`readonly mode: ${readonlyMode ? "on" : "off"}`, "info");
    },
  });

  pi.on("tool_call", async (event, ctx) => {
    const decision = decideToolCall({
      readonlyMode,
      hasUI: ctx.hasUI,
      toolName: event.toolName,
      triggerTools,
    });

    if (decision === "pass") {
      return undefined;
    }

    if (decision === "auto-disable") {
      applyMode(false);
      syncFooter(ctx);
      notifyNonInteractive();
      return undefined;
    }

    // decision === "prompt"
    const toolPath = extractToolPath(event.input);
    let choice: string | undefined;
    let message: string | undefined;
    try {
      choice = await ctx.ui.select(
        formatModalTitle(event.toolName, toolPath),
        ["Accept", "Accept for this session", "Steer"],
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

    if (result.sideEffect === "setEditing") {
      applyMode(false);
      syncFooter(ctx);
    }

    return result.block ? { block: true, reason: result.reason } : undefined;
  });
}
