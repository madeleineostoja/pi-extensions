import type {
  ExtensionAPI,
  MessageRenderer,
  ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { promptForPermission } from "@pi-extensions/lib";
import { decideToolCall, resolveChoice } from "./handler";
import { assessBashCommand } from "./assessors";
import { extractPendingCreations, commitPendingCreations } from "./session";

const MESSAGE_TYPE = "pi-guard.status";

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

  pi.registerMessageRenderer(MESSAGE_TYPE, renderStatusMessage);

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
