import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { promptForPermission } from "#lib/permission-prompt";
import { resolveChoice } from "./handler.js";
import { builtinPreview, unknownBackendPreview } from "./preview.js";
import {
  parseReadonlyArgs,
  extractToolPath,
  formatSteerTitle,
} from "./utils.js";

const FOOTER_KEY = "pipkin.edit-approval.mode";
const READONLY_ICON = "󰏯";
const EDITING_ICON = "󰏫";

export default function (pi: ExtensionAPI) {
  let enabled = true;

  function syncFooter(ctx: ExtensionContext) {
    if (ctx.mode !== "tui") {
      return;
    }
    const theme = ctx.ui.theme;
    ctx.ui.setStatus(
      FOOTER_KEY,
      enabled
        ? `${theme.fg("success", READONLY_ICON)} ${theme.fg("muted", "edit approval")}`
        : `${theme.fg("warning", EDITING_ICON)} ${theme.fg("warning", "editing")}`,
    );
  }

  function setEnabled(value: boolean, ctx?: ExtensionContext) {
    enabled = value;
    if (ctx) {
      syncFooter(ctx);
    }
  }

  pi.registerShortcut("ctrl+r", {
    description: "Toggle edit approval",
    handler: async (ctx) => setEnabled(!enabled, ctx),
  });

  pi.registerCommand("readonly", {
    description: "Toggle edit approval",
    handler: async (args, ctx) => {
      const action = parseReadonlyArgs(args);
      if (action.kind === "invalid") {
        ctx.ui.notify("unknown: /readonly [on|off]", "warning");
        return;
      }
      if (action.kind === "set" && action.value === enabled) {
        ctx.ui.notify(
          `edit approval: already ${enabled ? "on" : "off"}`,
          "info",
        );
        return;
      }
      setEnabled(action.kind === "toggle" ? !enabled : action.value, ctx);
      ctx.ui.notify(`edit approval: ${enabled ? "on" : "off"}`, "info");
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    enabled = true;
    syncFooter(ctx);
  });

  pi.on("tool_call", async (event, ctx) => {
    if (
      !enabled ||
      (event.toolName !== "edit" && event.toolName !== "write") ||
      !ctx.hasUI
    ) {
      return undefined;
    }

    const tool = pi
      .getAllTools()
      .find((candidate) => candidate.name === event.toolName);
    const builtin = tool?.sourceInfo.source === "builtin";
    const preview = builtin
      ? builtinPreview(event.toolName, event.input, ctx.cwd)
      : {
          path: extractToolPath(event.input),
          detail: unknownBackendPreview(event.input),
        };
    const permission = await promptForPermission({
      ui: ctx.ui,
      signal: ctx.signal,
      title: `Edit approval: ${event.toolName}${preview.path ? ` ${preview.path}` : ""} — apply?`,
      detail: preview.detail,
      choices: [
        { value: "Accept", label: "Accept" },
        { value: "Accept for this session", label: "Accept for this session" },
        {
          value: "Steer",
          label: "Steer",
          input: {
            title: formatSteerTitle(preview.path),
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
