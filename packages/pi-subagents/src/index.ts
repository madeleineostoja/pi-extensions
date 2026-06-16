import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { showAgentsDashboard } from "./agents-dashboard.js";
import { PUBLIC_AGENT_PROFILES } from "./agent-profiles.js";
import { getSubagentRuntime, type RuntimeSnapshot } from "./runtime.js";

export {
  GENERAL_DESC,
  GENERAL_PROMPT,
  EXPLORE_DESC,
  EXPLORE_PROMPT,
  PUBLIC_AGENT_PROFILES,
  REVIEW_DESC,
  REVIEW_PROMPT,
} from "./agent-profiles.js";
export type { AgentProfile, PromptMode } from "./agent-profiles.js";
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
  PublicAgentMode,
  QueueSubagentInput,
  RunManagedAgentInput,
  RunPublicAgentInput,
  RuntimeOwner,
  RuntimeSnapshot,
  RuntimeTimestamps,
  SubagentRuntimeStatus,
} from "./runtime.js";

const PublicAgentType = Type.Union([
  Type.Literal("General", {
    description: PUBLIC_AGENT_PROFILES.General.description,
  }),
  Type.Literal("Explore", {
    description: PUBLIC_AGENT_PROFILES.Explore.description,
  }),
  Type.Literal("Review", {
    description: PUBLIC_AGENT_PROFILES.Review.description,
  }),
]);

const Thinking = Type.Union([
  Type.Literal("off"),
  Type.Literal("minimal"),
  Type.Literal("low"),
  Type.Literal("medium"),
  Type.Literal("high"),
  Type.Literal("xhigh"),
]);

function toolResult(snapshot: RuntimeSnapshot) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(snapshot) }],
    details: snapshot,
    isError: snapshot.status === "failed" || snapshot.status === "stopped",
  };
}

export default function (pi: ExtensionAPI): void {
  const runtime = getSubagentRuntime(pi);
  pi.on("session_shutdown", (event: { reason?: string } = {}) => {
    runtime.handleSessionShutdown(event.reason);
  });
  pi.on("session_start", (event: { reason?: string } = {}) => {
    runtime.beginSession(event.reason);
  });

  pi.registerCommand("agents", {
    description: "Inspect and stop current-session subagents",
    handler: async (_args, ctx) => showAgentsDashboard(runtime, ctx),
  });

  pi.registerTool({
    name: "Agent",
    label: "Agent",
    description:
      "Run a General, Explore, or Review subagent. Defaults to foreground and returns the result; for background, use get_subagent_result with wait:true to join instead of polling.",
    parameters: Type.Object({
      subagent_type: PublicAgentType,
      prompt: Type.String({ description: "Task prompt for the subagent." }),
      description: Type.Optional(
        Type.String({ description: "Short human-readable task summary." }),
      ),
      mode: Type.Optional(
        Type.Union([Type.Literal("foreground"), Type.Literal("background")], {
          description:
            "Default foreground. Use background for long-running work.",
        }),
      ),
      model: Type.Optional(
        Type.String({ description: "Optional provider/model override." }),
      ),
      thinking: Type.Optional(Thinking),
      cwd: Type.Optional(
        Type.String({ description: "Optional working directory override." }),
      ),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const snapshot = await runtime.runPublicAgent({
        type: params.subagent_type,
        prompt: params.prompt,
        description: params.description,
        cwd: params.cwd ?? ctx.cwd,
        model: params.model,
        thinking: params.thinking,
        mode: params.mode ?? "foreground",
        ctx,
        signal,
      });
      return toolResult(snapshot);
    },
  });

  pi.registerTool({
    name: "get_subagent_result",
    label: "get_subagent_result",
    description:
      "Check a background subagent. Use wait:false for immediate status or wait:true to join; do not poll when you need the final result.",
    parameters: Type.Object({
      id: Type.String({ description: "Background subagent id." }),
      wait: Type.Boolean({
        description:
          "false returns current status immediately; true waits for completion.",
        default: false,
      }),
    }),
    async execute(_toolCallId, params) {
      const snapshot = await runtime.result(params.id, params.wait);
      return toolResult(snapshot);
    },
  });

  pi.registerTool({
    name: "steer_subagent",
    label: "steer_subagent",
    description:
      "Send guidance to a running background subagent. Fails for unknown or completed agents; use get_subagent_result wait:true to join.",
    parameters: Type.Object({
      id: Type.String({ description: "Background subagent id." }),
      message: Type.String({ description: "Steering message to send." }),
    }),
    async execute(_toolCallId, params) {
      const snapshot = await runtime.steer(params.id, params.message);
      return toolResult(snapshot);
    },
  });
}
