import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { promptForPermission } from "#lib/permission-prompt";
import { clearPipkinStatus, setPipkinStatus } from "#ui/status";
import { resolveChoice } from "./handler";
import { parseReadonlyArgs, extractToolPath, formatSteerTitle } from "./utils";

const READONLY_STATUS = { id: "readonly", priority: 200 } as const;
const READONLY_ICON = "󰏯";
const EDITING_ICON = "󰏫";

export function registerReadonlyMode(pi: ExtensionAPI): void {
  let enabled = true;

  function syncFooter(ctx: ExtensionContext) {
    if (ctx.mode !== "tui") {
      return;
    }
    setPipkinStatus(ctx.ui, {
      ...READONLY_STATUS,
      icon: enabled ? READONLY_ICON : EDITING_ICON,
      state: enabled ? "normal" : "warning",
      text: enabled ? "readonly" : "editing",
    });
  }

  function setEnabled(value: boolean, ctx?: ExtensionContext) {
    enabled = value;
    if (ctx) {
      syncFooter(ctx);
    }
  }

  pi.registerShortcut("ctrl+r", {
    description: "Toggle readonly mode",
    handler: async (ctx) => setEnabled(!enabled, ctx),
  });

  pi.registerCommand("readonly", {
    description: "Toggle readonly mode",
    handler: async (args, ctx) => {
      const action = parseReadonlyArgs(args);
      if (action.kind === "invalid") {
        ctx.ui.notify("unknown: /readonly [on|off]", "warning");
        return;
      }
      if (action.kind === "set" && action.value === enabled) {
        ctx.ui.notify(`readonly: already ${enabled ? "on" : "off"}`, "info");
        return;
      }
      setEnabled(action.kind === "toggle" ? !enabled : action.value, ctx);
      ctx.ui.notify(`readonly: ${enabled ? "on" : "off"}`, "info");
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    enabled = true;
    syncFooter(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    if (ctx.mode === "tui") {
      clearPipkinStatus(ctx.ui, READONLY_STATUS.id, READONLY_STATUS.priority);
    }
  });

  pi.on("tool_call", async (event, ctx) => {
    if (
      !enabled ||
      (event.toolName !== "edit" && event.toolName !== "write") ||
      !ctx.hasUI
    ) {
      return undefined;
    }

    const path = extractToolPath(event.input);
    const permission = await promptForPermission({
      ui: ctx.ui,
      signal: ctx.signal,
      title: `Readonly: apply proposed ${event.toolName}?`,
      choices: [
        { value: "Accept", label: "Accept" },
        { value: "Accept for this session", label: "Accept for this session" },
        {
          value: "Steer",
          label: "Steer",
          input: {
            title: formatSteerTitle(path),
            placeholder: "what should the agent do differently?",
          },
        },
      ],
    });
    const result = resolveChoice({
      choice: permission.kind === "selected" ? permission.value : undefined,
      message: permission.kind === "selected" ? permission.message : "",
    });
    if (result.disable) {
      setEnabled(false, ctx);
    }
    return result.block ? { block: true, reason: result.reason } : undefined;
  });
}
