import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ModelPreset } from "#lib/config";
import { toolCallRenderer } from "#lib/ui/tool-result-renderer";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import { PUBLIC_BUILTIN_TYPES } from "./agent-profiles.js";
import type { SubagentRuntime } from "./runtime.js";
import {
  renderAgentCall,
  renderAgentResult,
  toolResult,
} from "./tool-rendering.js";

const PublicAgentType = StringEnum(PUBLIC_BUILTIN_TYPES, {
  description: "Explore or Review subagent type.",
});

const Thinking = StringEnum(
  ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const,
  { description: "Optional reasoning-effort level for the subagent." },
);

export const PublicAgentParameters = Type.Object(
  {
    subagent_type: PublicAgentType,
    prompt: Type.String({ description: "Task prompt for the subagent." }),
    description: Type.Optional(
      Type.String({ description: "Short human-readable task summary." }),
    ),
    model: Type.Optional(
      Type.String({
        description:
          "Optional exact provider/model override. Use only when the ID is explicitly supplied or otherwise known; do not guess available models.",
      }),
    ),
    thinking: Type.Optional(Thinking),
  },
  { additionalProperties: false },
);

export type PublicAgentParams = Static<typeof PublicAgentParameters>;

const GetSubagentResultParameters = Type.Object(
  {
    id: Type.String({ description: "Managed subagent id." }),
    wait: Type.Boolean({
      description:
        "false returns current status immediately; true waits for completion and final cleanup.",
      default: false,
    }),
    include_progress: Type.Optional(
      Type.Boolean({
        description:
          "Include a bounded point-in-time excerpt of untrusted partial progress. wait:false returns currently available progress immediately; for stopped or failed agents, wait:true waits for frozen post-cleanup progress. Completed agents remain final-result only.",
      }),
    ),
  },
  { additionalProperties: false },
);
type GetSubagentResultParams = Static<typeof GetSubagentResultParameters>;

const SteerSubagentParameters = Type.Object(
  {
    id: Type.String({ description: "Running managed subagent id." }),
    message: Type.String({ description: "Steering message to send." }),
  },
  { additionalProperties: false },
);
type SteerSubagentParams = Static<typeof SteerSubagentParameters>;

export function resolveAgentSelection(
  type: PublicAgentParams["subagent_type"],
  model: string | undefined,
  thinking: PublicAgentParams["thinking"] | undefined,
  configPath: string,
  presets: Readonly<Partial<Record<"low" | "high", ModelPreset>>>,
): { model?: string; thinking?: PublicAgentParams["thinking"] } {
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

export function registerPublicAgentTools({
  pi,
  runtime,
  configPath,
  modelPresets,
}: {
  pi: ExtensionAPI;
  runtime: SubagentRuntime;
  configPath: string;
  modelPresets: Readonly<Partial<Record<"low" | "high", ModelPreset>>>;
}): void {
  pi.registerTool({
    name: "Agent",
    label: "Agent",
    description:
      "Start an Explore or Review managed subagent and return its ID immediately. Continue independent work, then join once with get_subagent_result when its result becomes a dependency.",
    parameters: PublicAgentParameters,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (signal?.aborted) {
        throw new DOMException("Agent start cancelled.", "AbortError");
      }
      const snapshot = await runtime.runPublicAgent({
        type: params.subagent_type,
        prompt: params.prompt,
        description: params.description,
        cwd: ctx.cwd,
        ...resolveAgentSelection(
          params.subagent_type,
          params.model,
          params.thinking,
          configPath,
          modelPresets,
        ),
        mode: "background",
        ctx,
      });
      return toolResult(snapshot, "start");
    },
    renderCall: renderAgentCall,
    renderResult: renderAgentResult,
  });

  pi.registerTool({
    name: "get_subagent_result",
    label: "get_subagent_result",
    description:
      "Join a managed subagent or intentionally inspect bounded partial progress. wait:true blocks for completion and final cleanup; wait:false returns its current status immediately.",
    parameters: GetSubagentResultParameters,
    renderCall: toolCallRenderer({
      name: "get_subagent_result",
      detail: (args: GetSubagentResultParams) =>
        `${args.id}${args.wait ? " · wait" : ""}`,
      pending: (args: GetSubagentResultParams) =>
        args.wait ? "Waiting for subagent…" : "Reading subagent state…",
    }),
    async execute(_toolCallId, params, signal) {
      const response = await runtime.publicResult(
        params.id,
        params.wait,
        params.include_progress ?? false,
        signal,
      );
      return toolResult(response.snapshot, "status", response.progress);
    },
    renderResult: renderAgentResult,
  });

  pi.registerTool({
    name: "steer_subagent",
    label: "steer_subagent",
    description:
      "Queue guidance for a running managed subagent after its current assistant turn's tool calls. Fails for unknown or completed agents.",
    parameters: SteerSubagentParameters,
    renderCall: toolCallRenderer({
      name: "steer_subagent",
      detail: (args: SteerSubagentParams) => args.id,
      pending: "Queueing guidance…",
    }),
    async execute(_toolCallId, params) {
      const snapshot = await runtime.steer(params.id, params.message);
      return toolResult(snapshot, "steer");
    },
    renderResult: renderAgentResult,
  });
}
