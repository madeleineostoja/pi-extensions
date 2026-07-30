import {
  getAgentDir,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { getConfigPath, loadPipkinConfig, presetIssue } from "#lib/config";
import { registerSessionNaming } from "./session-naming.js";

export default function (pi: ExtensionAPI): void {
  const agentDir = getAgentDir();
  const config = loadPipkinConfig(agentDir);

  registerSessionNaming(pi, {
    utility: config.config.models.utility,
    utilityIssue: presetIssue(config, "utility")?.message,
    configPath: getConfigPath(agentDir),
  });
}
