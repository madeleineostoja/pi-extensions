import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { loadPipkinConfig } from "#lib/config";
import { registerImplementCommand } from "./command.js";
import { registerImplementInspectionTool } from "./inspection-tool.js";
import {
  renderTerminalHandoffEntry,
  TERMINAL_HANDOFF_ENTRY_TYPE,
} from "./terminal-handoff-renderer.js";

export default function (pi: ExtensionAPI) {
  pi.registerEntryRenderer(
    TERMINAL_HANDOFF_ENTRY_TYPE,
    renderTerminalHandoffEntry,
  );
  registerImplementInspectionTool(pi);
  registerImplementCommand(pi, loadPipkinConfig(getAgentDir()));
}
