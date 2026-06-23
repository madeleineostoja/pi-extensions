import type {
  ExtensionAPI,
  ExtensionContext,
  MessageRenderer,
} from "@earendil-works/pi-coding-agent";
import { promptForPermission } from "@pi-extensions/lib";
import {
  parseReadonlyArgs,
  extractToolPath,
  formatModalTitle,
  formatSteerTitle,
} from "./utils";
import { decideToolCall, resolveChoice } from "./handler";

const FOOTER_KEY = "pi-readonly.mode";
const MESSAGE_TYPE = "pi-readonly.status";
const MODE_EVENT = "pi-readonly.mode:set";
const READONLY_ICON = "󰏯";
const EDITING_ICON = "󰏫";

type StatusDetails = {
  message: string;
};

type ModeEvent = {
  type: "set";
  value: boolean;
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

function isModeEvent(value: unknown): value is ModeEvent {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "set" &&
    typeof (value as { value?: unknown }).value === "boolean"
  );
}

export default function (pi: ExtensionAPI) {
  let readonlyMode = true;
  let nonInteractiveNotified = false;
  const triggerTools = new Set<string>(["edit", "write"]);

  function applyMode(next: boolean) {
    readonlyMode = next;
  }

  function setMode(next: boolean, ctx?: ExtensionContext) {
    applyMode(next);
    pi.events.emit(MODE_EVENT, { type: "set", value: next });
    if (ctx) {
      syncFooter(ctx);
    }
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
    if (ctx.mode !== "tui") {
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

  pi.events.on(MODE_EVENT, (event) => {
    if (isModeEvent(event)) {
      applyMode(event.value);
    }
  });

  pi.registerShortcut("ctrl+r", {
    description: "Toggle readonly mode",
    handler: async (ctx) => {
      setMode(!readonlyMode, ctx);
    },
  });

  pi.on("session_start", async (event, ctx) => {
    const FRESH_START_REASONS = new Set<typeof event.reason>([
      "startup",
      "new",
      "fork",
    ]);
    if (FRESH_START_REASONS.has(event.reason)) {
      setMode(true);
    }
    nonInteractiveNotified = false;

    if (ctx.mode !== "tui") {
      setMode(false);
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
        setMode(!readonlyMode);
      } else if (action.kind === "set") {
        if (action.value === readonlyMode) {
          ctx.ui.notify(
            `readonly mode: already ${readonlyMode ? "on" : "off"}`,
            "info",
          );
          return;
        }
        setMode(action.value);
      }
      syncFooter(ctx);
      ctx.ui.notify(`readonly mode: ${readonlyMode ? "on" : "off"}`, "info");
    },
  });

  pi.on("tool_call", async (event, ctx) => {
    const decision = decideToolCall({
      readonlyMode,
      mode: ctx.mode,
      toolName: event.toolName,
      triggerTools,
    });

    if (decision === "pass") {
      return undefined;
    }

    if (decision === "auto-disable") {
      setMode(false, ctx);
      notifyNonInteractive();
      return undefined;
    }

    // decision === "prompt"
    const toolPath = extractToolPath(event.input);
    const permission = await promptForPermission({
      ui: ctx.ui,
      signal: ctx.signal,
      title: formatModalTitle(event.toolName, toolPath),
      choices: [
        { value: "Accept", label: "Accept" },
        { value: "Accept for this session", label: "Accept for this session" },
        {
          value: "Steer",
          label: "Steer",
          input: {
            title: formatSteerTitle(toolPath),
            placeholder: "what should the agent do differently?",
          },
        },
      ],
    });

    const result = resolveChoice({
      choice: permission.kind === "selected" ? permission.value : undefined,
      message: permission.kind === "selected" ? permission.message : "",
    });

    if (result.sideEffect === "setEditing") {
      setMode(false, ctx);
    }

    return result.block ? { block: true, reason: result.reason } : undefined;
  });
}
