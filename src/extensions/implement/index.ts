import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { loadPipkinConfig } from "#lib/config";
import { registerImplementCommand } from "./command.js";

export default function (pi: ExtensionAPI) {
  registerImplementCommand(pi, loadPipkinConfig(getAgentDir()));
}
