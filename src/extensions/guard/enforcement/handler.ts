import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { promptForPermission } from "#lib/permission-prompt";
import {
  filesystemPromptDetail,
  gateDirectFilesystemTool,
  isDirectFilesystemTool,
} from "./tool-gate.js";
import type { GuardRuntimeState } from "../state.js";

export function createDirectFilesystemToolHandler({
  state,
  supportedMac,
}: {
  state: GuardRuntimeState;
  supportedMac: boolean;
}) {
  return async (
    event: { toolName: string; input: unknown },
    ctx: ExtensionContext,
  ) => {
    if (!isDirectFilesystemTool(event.toolName)) {
      return undefined;
    }
    const result = await gateDirectFilesystemTool({
      tool: event.toolName,
      input: event.input as { path?: unknown },
      cwd: state.fixedCapabilities()?.cwd ?? ctx.cwd,
      supportedMac,
      canPrompt: ctx.mode === "tui" && ctx.hasUI,
      signal: ctx.signal,
      state,
      prompt: async (request) => {
        const permission = await promptForPermission({
          ui: ctx.ui,
          signal: ctx.signal,
          title: `Guard: allow ${request.access} access?`,
          detail: filesystemPromptDetail(request),
          choices: [
            { value: "once", label: "Allow once" },
            { value: "block", label: "Block" },
          ],
        });
        return permission.kind === "selected" ? permission.value : "block";
      },
    });
    return result.block ? result : undefined;
  };
}
