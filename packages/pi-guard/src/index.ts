import type {
  ExtensionAPI,
  ExtensionContext,
  MessageRenderer,
  ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { promptForPermission } from "@pi-extensions/lib";
import { parseGuardArgs } from "./utils";
import { decideToolCall, resolveChoice } from "./handler";
import { assessBashCommand } from "./assessors";
import { extractPendingCreations, commitPendingCreations } from "./session";

const FOOTER_KEY = "pi-guard.mode";
const MESSAGE_TYPE = "pi-guard.status";
const GUARD_ICON = "󰌾";
const GUARD_OFF_ICON = "󰌿";

type StatusDetails = {
  message: string;
};

const NON_INTERACTIVE_MSG =
  "guard auto-disabled: no interactive UI available in this session. Risky shell commands will proceed without confirmation.";

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
  let guardEnabled = true;
  let nonInteractiveNotified = false;
  const sessionAllowKeys = new Set<string>();
  const sessionCreatedPaths = new Set<string>();
  const pendingCreations: Map<string, Set<string>> = new Map();

  function applyMode(next: boolean) {
    guardEnabled = next;
  }

  function notifyNonInteractive() {
    if (nonInteractiveNotified) {
      return;
    }
    nonInteractiveNotified = true;
    const message = `[pi-guard] ${NON_INTERACTIVE_MSG}`;
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
    if (guardEnabled) {
      ctx.ui.setStatus(
        FOOTER_KEY,
        `${theme.fg("success", GUARD_ICON)} ${theme.fg("muted", "guard")}`,
      );
    } else {
      ctx.ui.setStatus(
        FOOTER_KEY,
        `${theme.fg("warning", GUARD_OFF_ICON)} ${theme.fg("warning", "guard off")}`,
      );
    }
  }

  pi.registerMessageRenderer(MESSAGE_TYPE, renderStatusMessage);

  pi.registerShortcut("ctrl+g", {
    description: "Toggle guard mode",
    handler: async (ctx) => {
      applyMode(!guardEnabled);
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
      sessionAllowKeys.clear();
      sessionCreatedPaths.clear();
      nonInteractiveNotified = false;
    }

    if (ctx.mode !== "tui") {
      applyMode(false);
      notifyNonInteractive();
    }
    syncFooter(ctx);
  });

  pi.registerCommand("guard", {
    description: "Toggle guard mode",
    handler: async (args, ctx) => {
      const action = parseGuardArgs(args);
      if (action.kind === "invalid") {
        ctx.ui.notify("unknown: /guard [on|off]", "warning");
        return;
      }
      if (action.kind === "toggle") {
        applyMode(!guardEnabled);
      } else if (action.kind === "set") {
        if (action.value === guardEnabled) {
          ctx.ui.notify(
            `guard mode: already ${guardEnabled ? "on" : "off"}`,
            "info",
          );
          return;
        }
        applyMode(action.value);
      }
      syncFooter(ctx);
      ctx.ui.notify(`guard mode: ${guardEnabled ? "on" : "off"}`, "info");
    },
  });

  pi.on("tool_call", async (event, ctx) => {
    extractPendingCreations(
      event.toolCallId,
      event.toolName,
      event.input,
      ctx.cwd,
      pendingCreations,
    );

    const decision = decideToolCall({
      guardEnabled,
      mode: ctx.mode,
      toolName: event.toolName,
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
    if (event.toolName !== "bash") {
      return undefined;
    }

    const command = (event.input as { command?: string }).command;
    if (typeof command !== "string") {
      return undefined;
    }

    const action = assessBashCommand(command, ctx.cwd, sessionCreatedPaths);
    if (!action) {
      return undefined;
    }
    if (sessionAllowKeys.has(action.allowKey)) {
      return undefined;
    }

    const permission = await promptForPermission({
      ui: ctx.ui,
      signal: ctx.signal,
      title: action.title,
      detail: action.description,
      choices: [
        { value: "Allow once", label: "Allow once" },
        {
          value: "Allow similar this session",
          label: "Allow similar this session",
        },
        { value: "Allow all this session", label: "Allow all this session" },
        {
          value: "Block",
          label: "Block",
          input: {
            title: "Reason to give the agent",
            placeholder: "why are you blocking this?",
          },
        },
      ],
    });

    const result = resolveChoice({
      choice: permission.kind === "selected" ? permission.value : undefined,
      message: permission.kind === "selected" ? permission.message : "",
    });

    if (result.sideEffect === "allowKey") {
      sessionAllowKeys.add(action.allowKey);
    } else if (result.sideEffect === "disableGuard") {
      applyMode(false);
      syncFooter(ctx);
    }

    return result.block ? { block: true, reason: result.reason } : undefined;
  });

  pi.on("tool_result", async (event: ToolResultEvent) => {
    commitPendingCreations(
      event.toolCallId,
      pendingCreations,
      sessionCreatedPaths,
      event.isError,
    );
  });
}
