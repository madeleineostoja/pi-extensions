import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getSubagentRuntime } from "./runtime.js";
import { PUBLIC_BUILTINS } from "./definitions.js";
import { registerAgentTools } from "./tools.js";

export default function (pi: ExtensionAPI) {
  const runtime = getSubagentRuntime();

  for (const definition of PUBLIC_BUILTINS) {
    const result = runtime.registerDefinition(definition);
    if (!result.ok) {
      // eslint-disable-next-line no-console
      console.warn(`[pi-subagents] ${result.reason}`);
    }
  }

  registerAgentTools(pi);
}

export { getSubagentRuntime } from "./runtime.js";
export type {
  AgentStatus,
  AgentOwner,
  SpawnAgentArgs,
  SpawnContext,
  AgentResult,
  AgentSnapshot,
  RegisterDefinitionResult,
  SubagentRuntime,
} from "./runtime.js";
export type { AgentDefinition, ThinkingLevel } from "./definitions.js";
export { readConfig, parseConfig, getConfigPath } from "./config.js";
export type { SubagentsConfig, ConfigReadResult } from "./config.js";
