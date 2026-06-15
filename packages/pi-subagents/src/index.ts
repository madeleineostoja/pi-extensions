import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { getSubagentRuntime, type RuntimeSnapshot } from "./runtime.js";

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
  SandboxMode,
  SubagentRuntimeStatus,
} from "./runtime.js";

const PublicAgentType = Type.Union([
  Type.Literal("General"),
  Type.Literal("Explore"),
  Type.Literal("Review"),
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

type SubagentRpcPayload = {
  requestId?: string;
  type?: unknown;
  prompt?: unknown;
  agentId?: unknown;
  options?: {
    description?: unknown;
    isBackground?: unknown;
    model?: unknown;
    cwd?: unknown;
    sandboxMode?: unknown;
  };
};

function rpcReplyChannel(method: string, requestId: string): string {
  return `subagents:rpc:${method}:reply:${requestId}`;
}

export default function (pi: ExtensionAPI): void {
  const runtime = getSubagentRuntime(pi);
  let currentCtx: Parameters<Parameters<ExtensionAPI["on"]>[1]>[1] | undefined;

  pi.on("session_start", (_event, ctx) => {
    currentCtx = ctx;
  });

  pi.events.on("subagents:rpc:ping", (payload) => {
    const requestId = (payload as SubagentRpcPayload).requestId;
    if (!requestId) {
      return;
    }
    pi.events.emit(rpcReplyChannel("ping", requestId), {
      success: true,
      data: { version: 2 },
    });
  });

  pi.events.on("subagents:rpc:spawn", (payload) => {
    const request = payload as SubagentRpcPayload;
    if (!request.requestId) {
      return;
    }
    const requestId = request.requestId;
    void (async () => {
      if (!currentCtx) {
        throw new Error("pi-subagents session context is not ready.");
      }
      if (typeof request.type !== "string") {
        throw new Error("subagent type must be a string.");
      }
      if (typeof request.prompt !== "string") {
        throw new Error("subagent prompt must be a string.");
      }
      const options = request.options ?? {};
      const snapshot = await runtime.runManagedAgent({
        owner: { kind: "internal", name: "pi-implement" },
        type: request.type,
        prompt: request.prompt,
        description:
          typeof options.description === "string"
            ? options.description
            : request.prompt.slice(0, 120),
        cwd: typeof options.cwd === "string" ? options.cwd : currentCtx.cwd,
        ...(typeof options.model === "string" ? { model: options.model } : {}),
        ...(typeof options.sandboxMode === "string"
          ? { sandboxMode: options.sandboxMode }
          : {}),
        mode: "background",
        ctx: currentCtx,
      });
      pi.events.emit(rpcReplyChannel("spawn", requestId), {
        success: true,
        data: { id: snapshot.id },
      });
      void runtime.wait(snapshot.id).then((finalSnapshot) => {
        if (finalSnapshot.status === "completed") {
          pi.events.emit("subagents:completed", {
            id: finalSnapshot.id,
            status: finalSnapshot.status,
            result: finalSnapshot.result,
          });
          return;
        }
        pi.events.emit("subagents:failed", {
          id: finalSnapshot.id,
          status: finalSnapshot.status,
          error: finalSnapshot.error,
        });
      });
    })().catch((error: unknown) => {
      pi.events.emit(rpcReplyChannel("spawn", requestId), {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  });

  pi.events.on("subagents:rpc:stop", (payload) => {
    const request = payload as SubagentRpcPayload;
    if (!request.requestId) {
      return;
    }
    try {
      if (typeof request.agentId !== "string") {
        throw new Error("subagent id must be a string.");
      }
      runtime.stop(request.agentId);
      pi.events.emit(rpcReplyChannel("stop", request.requestId), {
        success: true,
      });
    } catch (error) {
      pi.events.emit(rpcReplyChannel("stop", request.requestId), {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
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
