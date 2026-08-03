import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { loadPipkinConfig } from "#lib/config";
import { registerImplementCommand } from "./command.js";
import { registerImplementInspectionTool } from "./inspection-tool.js";

export default function (pi: ExtensionAPI) {
  registerImplementInspectionTool(pi);
  registerImplementCommand(pi, loadPipkinConfig(getAgentDir()));
}
