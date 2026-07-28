import {
  getAgentDir,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { loadPipkinConfig, type ModelPreset } from "#lib/config";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import { showAgentsDashboard } from "./agents-dashboard.js";
import { ForegroundInterruptGuard } from "./foreground-interrupt.js";
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
export type { ThinkingLevel } from "#lib/config";
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

function resolveAgentSelection(
  type: PublicAgentParams["subagent_type"],
  model: string | undefined,
  thinking: PublicAgentParams["thinking"] | undefined,
  configPath: string,
  presets: Readonly<Partial<Record<"low" | "high", ModelPreset>>>,
): { model?: string; thinking?: PublicAgentParams["thinking"] } {
  if (type === "General") {
    return {
      ...(model === undefined ? {} : { model }),
      ...(thinking === undefined ? {} : { thinking }),
    };
  }
  if (model !== undefined && thinking !== undefined) {
    return { model, thinking };
  }
  const preset = presets[type === "Explore" ? "low" : "high"];
  if (!preset) {
    throw new Error(
      `Pipkin config ${configPath} is missing a valid ${type === "Explore" ? "low" : "high"} model preset.`,
    );
  }
  return {
    model: model ?? preset.model,
    thinking: thinking ?? preset.thinking,
  };
}

export default function (pi: ExtensionAPI): void {
  const config = loadPipkinConfig(getAgentDir());
  const runtime = getSubagentRuntime(pi, {
    low: config.config.models.low,
    high: config.config.models.high,
  });
  const roster = new SubagentRosterController(runtime);
  const foregroundInterrupt = new ForegroundInterruptGuard();

  pi.on("session_shutdown", async (event: { reason?: string } = {}) => {
    roster.dispose();
    foregroundInterrupt.dispose();
    runtime.handleSessionShutdown(event.reason);
    await runtime.waitForShutdown();
  });

  pi.on("session_start", (event: { reason?: string } = {}, ctx) => {
    roster.dispose();
    runtime.beginSession(event.reason);
    foregroundInterrupt.install(ctx);
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
      const run = (runSignal = signal) =>
        runtime.runPublicAgent({
          type: params.subagent_type,
          prompt: params.prompt,
          description: params.description,
          cwd: params.cwd ?? ctx.cwd,
          ...resolveAgentSelection(
            params.subagent_type,
            params.model,
            params.thinking,
            config.path,
            config.config.models,
          ),
          mode,
          ctx,
          signal: runSignal,
        });
      let running;
      if (mode === "foreground") {
        const controller = new AbortController();
        const relayAbort = () => controller.abort();
        if (signal?.aborted) {
          controller.abort();
        } else {
          signal?.addEventListener("abort", relayAbort, { once: true });
        }
        running = foregroundInterrupt.run(
          {
            type: params.subagent_type,
            description: params.description ?? params.prompt.slice(0, 120),
            stop: () => controller.abort(),
          },
          async () => {
            try {
              return await run(controller.signal);
            } finally {
              signal?.removeEventListener("abort", relayAbort);
            }
          },
        );
      } else {
        running = run();
      }
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
