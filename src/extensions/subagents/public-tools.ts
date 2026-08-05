import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ModelPreset } from "#lib/config";
import { toolCallRenderer } from "#lib/ui/tool-result-renderer";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import type { ForegroundInterruptGuard } from "./foreground-interrupt.js";
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
  },
  { additionalProperties: false },
);

export type PublicAgentParams = Static<typeof PublicAgentParameters>;

const GetSubagentResultParameters = Type.Object(
  {
    id: Type.String({ description: "Background subagent id." }),
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
    id: Type.String({ description: "Background subagent id." }),
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
  foregroundInterrupt,
  configPath,
  modelPresets,
}: {
  pi: ExtensionAPI;
  runtime: SubagentRuntime;
  foregroundInterrupt: ForegroundInterruptGuard;
  configPath: string;
  modelPresets: Readonly<Partial<Record<"low" | "high", ModelPreset>>>;
}): void {
  pi.registerTool({
    name: "Agent",
    label: "Agent",
    description:
      "Run an Explore or Review subagent. Foreground returns its completed result; background starts independent work that can later be joined or inspected.",
    parameters: PublicAgentParameters,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const mode = params.mode ?? "foreground";
      const run = (runSignal = signal) =>
        runtime.runPublicAgent({
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
      const snapshot = await running;
      return toolResult(snapshot, mode);
    },
    renderCall: renderAgentCall,
    renderResult: renderAgentResult,
  });

  pi.registerTool({
    name: "get_subagent_result",
    label: "get_subagent_result",
    description:
      "Join a background subagent or intentionally inspect bounded partial progress. wait:true blocks for completion; wait:false returns its current status immediately.",
    parameters: GetSubagentResultParameters,
    renderCall: toolCallRenderer({
      name: "get_subagent_result",
      detail: (args: GetSubagentResultParams) =>
        `${args.id}${args.wait ? " · wait" : ""}`,
      pending: (args: GetSubagentResultParams) =>
        args.wait ? "Waiting for subagent…" : "Reading subagent state…",
    }),
    async execute(_toolCallId, params) {
      const response = await runtime.publicResult(
        params.id,
        params.wait,
        params.include_progress ?? false,
      );
      return toolResult(response.snapshot, "status", response.progress);
    },
    renderResult: renderAgentResult,
  });

  pi.registerTool({
    name: "steer_subagent",
    label: "steer_subagent",
    description:
      "Queue guidance for a running background subagent after its current assistant turn's tool calls. Fails for unknown or completed agents.",
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
