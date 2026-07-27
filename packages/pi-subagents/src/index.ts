import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import { showAgentsDashboard } from "./agents-dashboard.js";
import {
  AGENT_PROMPT_GUIDELINES,
  PUBLIC_BUILTIN_TYPES,
} from "./agent-profiles.js";
import { getSubagentRuntime } from "./runtime.js";
import { SubagentRosterController } from "./roster.js";
import {
  renderAgentCall,
  renderAgentResult,
  toolResult,
} from "./tool-rendering.js";

export {
  AGENT_PROMPT_GUIDELINES,
  GENERAL_DESC,
  GENERAL_PROMPT,
  EXPLORE_DESC,
  EXPLORE_PROMPT,
  PUBLIC_AGENT_PROFILES,
  REVIEW_DESC,
  REVIEW_PROMPT,
} from "./agent-profiles.js";
export type { AgentProfile, PromptMode } from "./agent-profiles.js";
export { PUBLIC_BUILTIN_TYPES } from "./agent-profiles.js";
export type { PublicBuiltinType } from "./agent-profiles.js";
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
export {
  getSubagentRuntime,
  MANAGED_COMPLETION_TOOL_NAME,
  SubagentRuntime,
} from "./runtime.js";
export type {
  ExtensionBindingStatus,
  ManagedCompletion,
  PublicAgentMode,
  QueueSubagentInput,
  RosterVisibility,
  RunManagedAgentInput,
  RunPublicAgentInput,
  RuntimeInspection,
  RuntimeOwner,
  RuntimeSnapshot,
  RuntimeSubscriptionListener,
  RuntimeTimestamps,
  SubagentRuntimeStatus,
} from "./runtime.js";

const PublicAgentType = StringEnum(PUBLIC_BUILTIN_TYPES, {
  description: "General, Explore, or Review subagent type.",
});

const Thinking = StringEnum([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const);

const PublicAgentParameters = Type.Object({
  subagent_type: PublicAgentType,
  prompt: Type.String({ description: "Task prompt for the subagent." }),
  description: Type.Optional(
    Type.String({ description: "Short human-readable task summary." }),
  ),
  mode: Type.Optional(
    StringEnum(["foreground", "background"] as const, {
      description:
        "Default foreground. Use background only when independent work can proceed before the result is needed.",
    }),
  ),
  model: Type.Optional(
    Type.String({
      description:
        "Optional exact provider/model override. Use only when the ID is explicitly supplied or otherwise known; do not guess available models.",
    }),
  ),
  thinking: Type.Optional(Thinking),
  cwd: Type.Optional(
    Type.String({ description: "Optional working directory override." }),
  ),
});

export type PublicAgentParams = Static<typeof PublicAgentParameters>;

export default function (pi: ExtensionAPI): void {
  const runtime = getSubagentRuntime(pi);
  const roster = new SubagentRosterController(runtime);

  pi.on("session_shutdown", async (event: { reason?: string } = {}) => {
    roster.dispose();
    runtime.handleSessionShutdown(event.reason);
    await runtime.waitForShutdown();
  });

  pi.on("session_start", (event: { reason?: string } = {}) => {
    roster.dispose();
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
      "Run a General, Explore, or Review subagent. Defaults to foreground. Use background only when concrete independent work can proceed before the result is needed; otherwise use foreground.",
    promptGuidelines: AGENT_PROMPT_GUIDELINES,
    parameters: PublicAgentParameters,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const mode = params.mode ?? "foreground";
      const running = runtime.runPublicAgent({
        type: params.subagent_type,
        prompt: params.prompt,
        description: params.description,
        cwd: params.cwd ?? ctx.cwd,
        model: params.model,
        thinking: params.thinking,
        mode,
        ctx,
        signal,
      });
      roster.track(ctx);
      const snapshot = await running;
      roster.track(ctx);
      return toolResult(snapshot, mode);
    },
    renderCall: renderAgentCall,
    renderResult: renderAgentResult,
  });

  pi.registerTool({
    name: "get_subagent_result",
    label: "get_subagent_result",
    description:
      "Join or inspect a background subagent. Use wait:true when its result becomes a dependency. Use wait:false only for an intentional non-blocking status check; do not poll.",
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
    renderResult: renderAgentResult,
  });

  pi.registerTool({
    name: "steer_subagent",
    label: "steer_subagent",
    description:
      "Cooperatively queue guidance for a running background subagent after its current assistant turn's tool calls. Fails for unknown or completed agents; join when its result becomes a dependency.",
    parameters: Type.Object({
      id: Type.String({ description: "Background subagent id." }),
      message: Type.String({ description: "Steering message to send." }),
    }),
    async execute(_toolCallId, params) {
      const snapshot = await runtime.steer(params.id, params.message);
      return toolResult(snapshot);
    },
    renderResult: renderAgentResult,
  });
}
