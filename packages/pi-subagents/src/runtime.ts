import {
  createAgentSession,
  getAgentDir,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel as SdkThinkingLevel } from "@earendil-works/pi-ai";
import { parseModelRef } from "@pi-extensions/lib";
import type { AgentDefinition, ThinkingLevel } from "./definitions.js";
import { readConfig } from "./config.js";

export type AgentStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "stopped";

export type AgentOwner =
  | { kind: "interactive" }
  | { kind: "pi-implement"; runId?: string; taskId?: string; role: string }
  | { kind: "nested"; parentId: string; toolName: "explore" };

export type SpawnAgentArgs = {
  type: string;
  prompt: string;
  description: string;
  model?: string;
  thinking?: ThinkingLevel;
  cwd?: string;
  background?: boolean;
  silent?: boolean;
  owner?: AgentOwner;
  parentId?: string;
  signal?: AbortSignal;
};

export type SpawnContext = {
  modelRegistry?: ModelRegistry;
  parentModel?: string;
};

export type AgentResult =
  | { status: "completed"; result: string }
  | { status: "failed"; error: string }
  | { status: "stopped"; error: string };

export type AgentSnapshot = {
  id: string;
  type: string;
  description: string;
  status: AgentStatus;
  owner: AgentOwner;
  parentId?: string;
  model?: string;
  cwd: string;
  startedAt: number;
  completedAt?: number;
  turns: number;
  toolUses: number;
  activeTool?: string;
  lastActivityAt?: number;
  lastAssistantText?: string;
  tokensTotal?: number;
  compactionCount: number;
};

type AgentRecord = {
  id: string;
  type: string;
  description: string;
  status: AgentStatus;
  owner: AgentOwner;
  parentId?: string;
  model?: string;
  cwd: string;
  startedAt: number;
  completedAt?: number;
  turns: number;
  toolUses: number;
  activeTool?: string;
  lastActivityAt?: number;
  lastAssistantText?: string;
  tokensTotal?: number;
  compactionCount: number;
  result?: AgentResult;
  signal?: AbortSignal;
  abortController?: AbortController;
  session?: Awaited<ReturnType<typeof createAgentSession>>["session"];
  steerQueue: string[];
  onComplete?: (result: AgentResult) => void;
  resultConsumed?: boolean;
};

export type RegisterDefinitionResult =
  | { ok: true }
  | { ok: false; reason: string };

export type SubagentRuntime = {
  registerDefinition(definition: AgentDefinition): RegisterDefinitionResult;
  hasDefinition(name: string): boolean;
  getDefinition(name: string): AgentDefinition | undefined;
  listDefinitions(options?: { publicOnly?: boolean }): AgentDefinition[];
  spawn(args: SpawnAgentArgs, context?: SpawnContext): Promise<string>;
  waitFor(id: string, signal?: AbortSignal): Promise<AgentResult>;
  stop(id: string): Promise<void>;
  steer(id: string, message: string): Promise<void>;
  snapshots(): AgentSnapshot[];
  getRecord(id: string): AgentSnapshot | undefined;
};

let runtimeSingleton: SubagentRuntime | undefined;

export function getSubagentRuntime(): SubagentRuntime {
  if (!runtimeSingleton) {
    runtimeSingleton = createSubagentRuntime();
  }
  return runtimeSingleton;
}

/** @internal For testing only. */
export function resetSubagentRuntime(): void {
  runtimeSingleton = undefined;
}

function createSubagentRuntime(): SubagentRuntime {
  const definitions = new Map<string, AgentDefinition>();
  const records = new Map<string, AgentRecord>();
  let idCounter = 0;

  const config = readConfig(getAgentDir());

  function registerDefinition(
    definition: AgentDefinition,
  ): RegisterDefinitionResult {
    const existing = definitions.get(definition.name);
    if (existing) {
      if (definitionsEquivalent(existing, definition)) {
        return { ok: true };
      }
      return {
        ok: false,
        reason: `Definition "${definition.name}" already registered with different fields.`,
      };
    }
    definitions.set(definition.name, definition);
    return { ok: true };
  }

  function hasDefinition(name: string): boolean {
    return definitions.has(name);
  }

  function getDefinition(name: string): AgentDefinition | undefined {
    return definitions.get(name);
  }

  function listDefinitions(options?: {
    publicOnly?: boolean;
  }): AgentDefinition[] {
    const defs = [...definitions.values()];
    if (options?.publicOnly) {
      return defs.filter((d) => d.public);
    }
    return defs;
  }

  function resolveModel(
    args: SpawnAgentArgs,
    definition: AgentDefinition,
    context?: SpawnContext,
  ): { model: string | undefined; warning?: string } {
    // Step 1: explicit spawn/tool-call model
    if (args.model) {
      return { model: args.model };
    }

    // Step 2: caller-owned role config is passed as args.model above

    // Step 3: public builtin config model
    if (
      definition.resolveModel === "public-config" &&
      config.config.models?.[definition.name]
    ) {
      const configModel = config.config.models[definition.name];
      const parsed = parseModelRef(configModel);
      if (parsed && context?.modelRegistry?.find(parsed.provider, parsed.id)) {
        return { model: configModel };
      }
      // Invalid or unavailable config model: warn and fall back to parent
      return {
        model: context?.parentModel,
        warning: `Configured model for ${definition.name} (${configModel}) is not available; falling back to parent model.`,
      };
    }

    // Step 4: definition default (v1: none for public definitions)

    // Step 5: parent/current session model
    return { model: context?.parentModel };
  }

  async function spawn(
    args: SpawnAgentArgs,
    context?: SpawnContext,
  ): Promise<string> {
    const definition = definitions.get(args.type);
    if (!definition) {
      throw new Error(`Unknown agent type: ${args.type}`);
    }

    const id = `subagent-${Date.now()}-${++idCounter}`;
    const abortController = new AbortController();
    const record: AgentRecord = {
      id,
      type: args.type,
      description: args.description,
      status: "queued",
      owner: args.owner ?? { kind: "interactive" },
      parentId: args.parentId,
      cwd: args.cwd ?? process.cwd(),
      startedAt: Date.now(),
      turns: 0,
      toolUses: 0,
      compactionCount: 0,
      signal: args.signal,
      abortController,
      steerQueue: [],
    };
    records.set(id, record);

    if (args.signal) {
      args.signal.addEventListener(
        "abort",
        () => {
          void stop(id);
        },
        { once: true },
      );
    }

    const { model, warning } = resolveModel(args, definition, context);
    if (warning) {
      // Log warning but do not fail the spawn
      // eslint-disable-next-line no-console
      console.warn(`[pi-subagents] ${warning}`);
    }

    record.model = model;

    void (async () => {
      try {
        record.status = "running";
        const thinking =
          args.thinking ?? definition.defaultThinking ?? "medium";

        const toolList =
          definition.tools === "all" ? undefined : definition.tools;

        const effectiveThinking: SdkThinkingLevel =
          thinking === "off" ? "minimal" : (thinking as SdkThinkingLevel);

        const { session } = await createAgentSession({
          cwd: record.cwd,
          model: model
            ? resolveModelFromRegistry(model, context?.modelRegistry)
            : undefined,
          thinkingLevel: effectiveThinking,
          tools: toolList,
          sessionManager: SessionManager.inMemory(),
          modelRegistry: context?.modelRegistry,
        });

        record.session = session;

        // Flush any queued steering messages
        for (const steerMsg of record.steerQueue) {
          await session.steer(steerMsg);
        }
        record.steerQueue = [];

        // Subscribe to events for tracking
        session.subscribe((event) => {
          if (event.type === "turn_end") {
            record.turns++;
            record.lastActivityAt = Date.now();
          }
          if (event.type === "tool_execution_end") {
            record.toolUses++;
            record.activeTool = event.toolName;
            record.lastActivityAt = Date.now();
          }
          if (event.type === "compaction_end") {
            record.compactionCount++;
          }
          if (event.type === "message_update") {
            const message = event.message as {
              content?: Array<{ type: string; text?: string }>;
            };
            const text = message.content
              ?.filter((c) => c.type === "text")
              .map((c) => c.text)
              .filter((t): t is string => typeof t === "string")
              .join("");
            if (text) {
              record.lastAssistantText = text;
            }
          }
          const stats = session.getSessionStats();
          if (stats.tokens.total > 0) {
            record.tokensTotal = stats.tokens.total;
          }
        });

        await session.sendUserMessage(args.prompt);

        // Wait for session to become idle
        while (session.isStreaming || session.pendingMessageCount > 0) {
          if (abortController.signal.aborted) {
            await session.abort();
            break;
          }
          await new Promise((r) => setTimeout(r, 100));
        }

        if (abortController.signal.aborted) {
          record.status = "stopped";
          record.completedAt = Date.now();
          record.result = { status: "stopped", error: "Stopped by user." };
        } else {
          const lastText = session.getLastAssistantText() ?? "";
          record.status = "completed";
          record.completedAt = Date.now();
          record.result = { status: "completed", result: lastText };
        }

        session.dispose();
        record.session = undefined;
        record.onComplete?.(record.result);
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        record.status = "failed";
        record.completedAt = Date.now();
        record.result = { status: "failed", error };
        record.session?.dispose();
        record.session = undefined;
        record.onComplete?.(record.result);
      }
    })();

    return id;
  }

  async function waitFor(
    id: string,
    signal?: AbortSignal,
  ): Promise<AgentResult> {
    const record = records.get(id);
    if (!record) {
      return { status: "failed", error: `Agent ${id} not found.` };
    }

    if (record.result) {
      return record.result;
    }

    if (signal?.aborted) {
      return { status: "stopped", error: "Stopped by user." };
    }

    return new Promise((resolve) => {
      let offAbort = () => {};
      const done = (result: AgentResult) => {
        offAbort();
        resolve(result);
      };

      if (signal) {
        const abort = () =>
          done({ status: "stopped", error: "Stopped by user." });
        signal.addEventListener("abort", abort, { once: true });
        offAbort = () => signal.removeEventListener("abort", abort);
      }

      record.onComplete = (result) => {
        done(result);
      };
    });
  }

  async function stop(id: string): Promise<void> {
    const record = records.get(id);
    if (!record) {
      return;
    }
    record.abortController?.abort();
    if (record.session) {
      await record.session.abort();
    }
    if (record.status === "queued" || record.status === "running") {
      record.status = "stopped";
      record.completedAt = Date.now();
      record.result = { status: "stopped", error: "Stopped by user." };
      record.onComplete?.(record.result);
    }
  }

  async function steer(id: string, message: string): Promise<void> {
    const record = records.get(id);
    if (!record) {
      throw new Error(`Agent ${id} not found.`);
    }
    if (record.session) {
      await record.session.steer(message);
    } else {
      record.steerQueue.push(message);
    }
  }

  function snapshots(): AgentSnapshot[] {
    return [...records.values()].map(toSnapshot);
  }

  function getRecord(id: string): AgentSnapshot | undefined {
    const record = records.get(id);
    if (!record) {
      return undefined;
    }
    return toSnapshot(record);
  }

  return {
    registerDefinition,
    hasDefinition,
    getDefinition,
    listDefinitions,
    spawn,
    waitFor,
    stop,
    steer,
    snapshots,
    getRecord,
  };
}

function toSnapshot(record: AgentRecord): AgentSnapshot {
  return {
    id: record.id,
    type: record.type,
    description: record.description,
    status: record.status,
    owner: record.owner,
    parentId: record.parentId,
    model: record.model,
    cwd: record.cwd,
    startedAt: record.startedAt,
    completedAt: record.completedAt,
    turns: record.turns,
    toolUses: record.toolUses,
    activeTool: record.activeTool,
    lastActivityAt: record.lastActivityAt,
    lastAssistantText: record.lastAssistantText,
    tokensTotal: record.tokensTotal,
    compactionCount: record.compactionCount,
  };
}

function definitionsEquivalent(
  a: AgentDefinition,
  b: AgentDefinition,
): boolean {
  return (
    a.name === b.name &&
    a.public === b.public &&
    a.displayName === b.displayName &&
    a.description === b.description &&
    a.promptMode === b.promptMode &&
    a.systemPrompt === b.systemPrompt &&
    JSON.stringify(a.tools) === JSON.stringify(b.tools) &&
    a.includeExploreTool === b.includeExploreTool &&
    a.defaultThinking === b.defaultThinking &&
    a.resolveModel === b.resolveModel
  );
}

function resolveModelFromRegistry(
  modelRef: string,
  modelRegistry?: ModelRegistry,
):
  | import("@earendil-works/pi-ai").Model<import("@earendil-works/pi-ai").Api>
  | undefined {
  if (!modelRegistry) {
    return undefined;
  }
  const parsed = parseModelRef(modelRef);
  if (!parsed) {
    return undefined;
  }
  return modelRegistry.find(parsed.provider, parsed.id);
}
