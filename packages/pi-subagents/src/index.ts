import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getSubagentRuntime } from "./runtime.js";

export {
  AgentDefinitionRegistry,
  createAgentDefinitionRegistry,
  PUBLIC_BUILTIN_DEFINITIONS,
  PUBLIC_BUILTIN_TYPES,
} from "./definitions.js";
export type {
  AgentDefinition,
  AgentDefinitionVisibility,
  PublicBuiltinType,
} from "./definitions.js";
export {
  getPublicConfigPath,
  loadPublicConfig,
  parsePublicConfig,
  resolvePublicConfig,
  THINKING_LEVELS,
} from "./config.js";
export type {
  ParsedPublicSubagentsConfig,
  PublicSubagentsConfig,
  ResolvedPublicSubagentsConfig,
  ThinkingLevel,
} from "./config.js";
export { getSubagentRuntime, SubagentRuntime } from "./runtime.js";
export type {
  ExtensionBindingStatus,
  QueueSubagentInput,
  RuntimeSnapshot,
  RuntimeTimestamps,
  SandboxMode,
  SubagentRuntimeStatus,
} from "./runtime.js";

export default function (pi: ExtensionAPI): void {
  getSubagentRuntime(pi);
}
