import type {
  AgentSession,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { createAgentSession } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import type { Api } from "@earendil-works/pi-ai";
import {
  createAgentDefinitionRegistry,
  PUBLIC_BUILTIN_TYPES,
  type AgentDefinitionRegistry,
  type PublicBuiltinType,
} from "./definitions.js";
import {
  loadPublicConfig,
  type ResolvedPublicSubagentsConfig,
  type ThinkingLevel,
} from "./config.js";

export type SubagentRuntimeStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "stopped";

export type ExtensionBindingStatus = "bound" | "unbound";

export type SandboxMode =
  | "inherit"
  | "none"
  | "read-only"
  | "workspace-write"
  | string;

export type RuntimeTimestamps = {
  queuedAt: string;
  startedAt?: string;
  completedAt?: string;
  updatedAt: string;
};

export type RuntimeSnapshot = {
  id: string;
  status: SubagentRuntimeStatus;
  owner: string;
  type: string;
  description: string;
  cwd: string;
  model?: string;
  thinking?: ThinkingLevel;
  extensionBinding: ExtensionBindingStatus;
  sandboxMode?: SandboxMode;
  timestamps: RuntimeTimestamps;
  result?: unknown;
  error?: string;
};

export type QueueSubagentInput = {
  owner: string;
  type: string;
  description: string;
  cwd: string;
  model?: string;
  thinking?: ThinkingLevel;
  extensionBinding?: ExtensionBindingStatus;
  sandboxMode?: SandboxMode;
};

export type PublicAgentMode = "foreground" | "background";

export type RunPublicAgentInput = {
  type: PublicBuiltinType;
  prompt: string;
  description?: string;
  cwd: string;
  model?: string;
  thinking?: ThinkingLevel;
  mode?: PublicAgentMode;
  ctx: ExtensionContext;
  signal?: AbortSignal;
};

type RuntimeRecord = Omit<RuntimeSnapshot, "timestamps"> &
  RuntimeTimestamps & {
    session?: PublicAgentSession;
    canSteer?: boolean;
    steeringQueue: string[];
  };

type PublicAgentSession = Pick<
  AgentSession,
  | "bindExtensions"
  | "prompt"
  | "steer"
  | "abort"
  | "dispose"
  | "getLastAssistantText"
  | "setActiveToolsByName"
  | "extensionRunner"
> & {
  readonly state?: { readonly errorMessage?: string };
};

type CreateSessionOptions = Parameters<typeof createAgentSession>[0];
type CreateSessionResult = { session: PublicAgentSession };
type CreateSession = (
  options?: CreateSessionOptions,
) => Promise<CreateSessionResult>;

type Waiter = {
  resolve: (snapshot: RuntimeSnapshot) => void;
};

const runtimes = new WeakMap<ExtensionAPI, SubagentRuntime>();
const publicTypes = new Set<string>(PUBLIC_BUILTIN_TYPES);
const publicToolNames = new Set([
  "Agent",
  "get_subagent_result",
  "steer_subagent",
]);

function now(): string {
  return new Date().toISOString();
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function snapshot(record: RuntimeRecord): RuntimeSnapshot {
  return {
    id: record.id,
    status: record.status,
    owner: record.owner,
    type: record.type,
    description: record.description,
    cwd: record.cwd,
    ...(record.model === undefined ? {} : { model: record.model }),
    ...(record.thinking === undefined ? {} : { thinking: record.thinking }),
    extensionBinding: record.extensionBinding,
    ...(record.sandboxMode === undefined
      ? {}
      : { sandboxMode: record.sandboxMode }),
    timestamps: {
      queuedAt: record.queuedAt,
      ...(record.startedAt === undefined
        ? {}
        : { startedAt: record.startedAt }),
      ...(record.completedAt === undefined
        ? {}
        : { completedAt: record.completedAt }),
      updatedAt: record.updatedAt,
    },
    ...(record.result === undefined ? {} : { result: record.result }),
    ...(record.error === undefined ? {} : { error: record.error }),
  };
}

function isTerminal(status: SubagentRuntimeStatus): boolean {
  return status === "completed" || status === "failed" || status === "stopped";
}

function isPublicBuiltinType(type: string): type is PublicBuiltinType {
  return publicTypes.has(type);
}

function splitModelRef(modelRef: string): {
  provider: string;
  modelId: string;
} {
  const slash = modelRef.indexOf("/");
  if (slash <= 0 || slash === modelRef.length - 1) {
    throw new Error(`Model must be in provider/model format: ${modelRef}`);
  }
  return {
    provider: modelRef.slice(0, slash),
    modelId: modelRef.slice(slash + 1),
  };
}

function findModel(
  ctx: ExtensionContext,
  modelRef: string | undefined,
): Model<Api> | undefined {
  if (modelRef === undefined) {
    return ctx.model as Model<Api> | undefined;
  }
  const { provider, modelId } = splitModelRef(modelRef);
  const model = ctx.modelRegistry.find(provider, modelId);
  if (!model) {
    throw new Error(`Unknown model ${modelRef}`);
  }
  return model;
}

export class SubagentRuntime {
  readonly definitions: AgentDefinitionRegistry;
  readonly publicConfig: ResolvedPublicSubagentsConfig;
  #records = new Map<string, RuntimeRecord>();
  #waiters = new Map<string, Waiter[]>();
  #nextId = 1;
  #createSession: CreateSession;

  constructor(
    public readonly pi: ExtensionAPI,
    options: {
      publicConfig?: ResolvedPublicSubagentsConfig;
      createSession?: CreateSession;
    } = {},
  ) {
    this.definitions = createAgentDefinitionRegistry();
    this.#createSession = options.createSession ?? createAgentSession;
    this.publicConfig =
      options.publicConfig ??
      loadPublicConfig({
        warn: (message) => {
          try {
            pi.sendMessage({
              customType: "pi-subagents.config.warning",
              content: `[pi-subagents] ${message}`,
              display: true,
            });
          } catch {
            // best-effort warning for test doubles and early startup
          }
        },
      });
  }

  queue(input: QueueSubagentInput): RuntimeSnapshot {
    const id = `subagent-${this.#nextId++}`;
    const timestamp = now();
    const model =
      input.model ??
      (publicTypes.has(input.type)
        ? this.publicConfig.models[
            input.type as keyof ResolvedPublicSubagentsConfig["models"]
          ]
        : undefined);
    const thinking =
      input.thinking ??
      (publicTypes.has(input.type)
        ? this.publicConfig.thinking[
            input.type as keyof ResolvedPublicSubagentsConfig["thinking"]
          ]
        : undefined);

    const record: RuntimeRecord = {
      id,
      status: "queued",
      owner: input.owner,
      type: input.type,
      description: input.description,
      cwd: input.cwd,
      ...(model === undefined ? {} : { model }),
      ...(thinking === undefined ? {} : { thinking }),
      extensionBinding: input.extensionBinding ?? "unbound",
      ...(input.sandboxMode === undefined
        ? {}
        : { sandboxMode: input.sandboxMode }),
      queuedAt: timestamp,
      updatedAt: timestamp,
      steeringQueue: [],
    };
    this.#records.set(id, record);
    return snapshot(record);
  }

  async runPublicAgent(input: RunPublicAgentInput): Promise<RuntimeSnapshot> {
    if (!isPublicBuiltinType(input.type)) {
      throw new Error(
        `Unsupported public subagent type ${input.type}. Use General, Explore, or Review.`,
      );
    }
    if (input.prompt.trim() === "") {
      throw new Error("Agent prompt must not be empty");
    }
    const queued = this.queue({
      owner: "public-tool",
      type: input.type,
      description: input.description ?? input.prompt.slice(0, 120),
      cwd: input.cwd,
      model: input.model,
      thinking: input.thinking,
      extensionBinding: "unbound",
    });
    const record = this.#requireRecord(queued.id);
    this.start(record.id);
    const running = this.#runRecord(record, input);
    if (input.mode === "background") {
      void running;
      return snapshot(record);
    }
    return running;
  }

  start(id: string): RuntimeSnapshot {
    const record = this.#requireRecord(id);
    if (record.status !== "queued") {
      throw new Error(`Cannot start subagent ${id} from ${record.status}`);
    }
    const timestamp = now();
    record.status = "running";
    record.startedAt = timestamp;
    record.updatedAt = timestamp;
    return snapshot(record);
  }

  complete(id: string, result: unknown): RuntimeSnapshot {
    const record = this.#requireRecord(id);
    this.#ensureNotTerminal(record);
    const timestamp = now();
    record.status = "completed";
    record.result = result;
    record.completedAt = timestamp;
    record.updatedAt = timestamp;
    return this.#finish(record);
  }

  fail(id: string, error: unknown): RuntimeSnapshot {
    const record = this.#requireRecord(id);
    this.#ensureNotTerminal(record);
    const timestamp = now();
    record.status = "failed";
    record.error = errorText(error);
    record.completedAt = timestamp;
    record.updatedAt = timestamp;
    return this.#finish(record);
  }

  stop(id: string, error = "Stopped by user."): RuntimeSnapshot {
    const record = this.#requireRecord(id);
    this.#ensureNotTerminal(record);
    record.session?.abort().catch(() => {});
    const timestamp = now();
    record.status = "stopped";
    record.error = error;
    record.completedAt = timestamp;
    record.updatedAt = timestamp;
    return this.#finish(record);
  }

  async steer(id: string, message: string): Promise<RuntimeSnapshot> {
    const record = this.#records.get(id);
    if (!record) {
      throw new Error(`Unknown subagent ${id}`);
    }
    if (isTerminal(record.status)) {
      throw new Error(`Cannot steer subagent ${id}; it is ${record.status}`);
    }
    if (record.status !== "running") {
      throw new Error(`Cannot steer subagent ${id} from ${record.status}`);
    }
    const trimmed = message.trim();
    if (trimmed === "") {
      throw new Error("Steer message must not be empty");
    }
    if (!record.session || !record.canSteer) {
      record.steeringQueue.push(trimmed);
    } else {
      await record.session.steer(trimmed);
    }
    record.updatedAt = now();
    return snapshot(record);
  }

  async result(id: string, wait: boolean): Promise<RuntimeSnapshot> {
    if (wait) {
      return this.wait(id);
    }
    const current = this.snapshot(id);
    if (!current) {
      throw new Error(`Unknown subagent ${id}`);
    }
    return current;
  }

  wait(id: string): Promise<RuntimeSnapshot> {
    const record = this.#requireRecord(id);
    if (isTerminal(record.status)) {
      return Promise.resolve(snapshot(record));
    }
    return new Promise((resolve) => {
      const waiters = this.#waiters.get(id) ?? [];
      waiters.push({ resolve });
      this.#waiters.set(id, waiters);
    });
  }

  snapshot(id: string): RuntimeSnapshot | undefined {
    const record = this.#records.get(id);
    return record ? snapshot(record) : undefined;
  }

  snapshots(): RuntimeSnapshot[] {
    return [...this.#records.values()].map((record) => snapshot(record));
  }

  async #runRecord(
    record: RuntimeRecord,
    input: RunPublicAgentInput,
  ): Promise<RuntimeSnapshot> {
    const abort = () => {
      if (!isTerminal(record.status)) {
        this.stop(record.id, "Stopped by user.");
      }
    };
    if (input.signal?.aborted) {
      return this.stop(record.id, "Stopped by user.");
    }
    input.signal?.addEventListener("abort", abort, { once: true });
    try {
      const model = findModel(input.ctx, record.model);
      const { session } = await this.#createSession({
        cwd: record.cwd,
        model,
        ...(record.thinking === undefined
          ? {}
          : { thinkingLevel: record.thinking }),
      });
      if (isTerminal(record.status)) {
        await this.#disposeSession(session);
        return snapshot(record);
      }
      record.session = session;
      await session.bindExtensions({
        mode: "print",
        abortHandler: () => void session.abort(),
        shutdownHandler: () => {},
      });
      record.extensionBinding = "bound";
      this.#inheritActiveTools(record, session);
      const prompt = session.prompt(input.prompt, { source: "extension" });
      record.canSteer = true;
      await this.#flushSteering(record);
      await prompt;
      const state = "state" in session ? session.state : undefined;
      if (state?.errorMessage) {
        return this.fail(record.id, state.errorMessage);
      }
      const result = session.getLastAssistantText() ?? "";
      return this.complete(record.id, result);
    } catch (error) {
      if (isTerminal(record.status)) {
        return snapshot(record);
      }
      return this.fail(record.id, error);
    } finally {
      input.signal?.removeEventListener("abort", abort);
      if (record.session) {
        await this.#disposeSession(record.session);
      }
    }
  }

  async #disposeSession(session: PublicAgentSession): Promise<void> {
    if (session.extensionRunner.hasHandlers("session_shutdown")) {
      await session.extensionRunner.emit({
        type: "session_shutdown",
        reason: "quit",
      });
    }
    session.dispose();
  }

  #inheritActiveTools(
    record: RuntimeRecord,
    session: PublicAgentSession,
  ): void {
    const getActiveTools = this.pi.getActiveTools?.bind(this.pi);
    if (!getActiveTools) {
      return;
    }
    let activeTools = getActiveTools();
    if (record.type === "General") {
      activeTools = activeTools.filter((name) => !publicToolNames.has(name));
    }
    session.setActiveToolsByName(activeTools);
  }

  async #flushSteering(record: RuntimeRecord): Promise<void> {
    const session = record.session;
    if (!session) {
      return;
    }
    while (record.steeringQueue.length > 0 && !isTerminal(record.status)) {
      const message = record.steeringQueue.shift();
      if (message !== undefined) {
        await session.steer(message);
      }
    }
  }

  #requireRecord(id: string): RuntimeRecord {
    const record = this.#records.get(id);
    if (!record) {
      throw new Error(`Unknown subagent ${id}`);
    }
    return record;
  }

  #ensureNotTerminal(record: RuntimeRecord): void {
    if (isTerminal(record.status)) {
      throw new Error(`Subagent ${record.id} already ${record.status}`);
    }
  }

  #finish(record: RuntimeRecord): RuntimeSnapshot {
    const finalSnapshot = snapshot(record);
    const waiters = this.#waiters.get(record.id) ?? [];
    this.#waiters.delete(record.id);
    for (const waiter of waiters) {
      waiter.resolve(finalSnapshot);
    }
    return finalSnapshot;
  }
}

export function getSubagentRuntime(pi: ExtensionAPI): SubagentRuntime {
  const existing = runtimes.get(pi);
  if (existing) {
    return existing;
  }
  const runtime = new SubagentRuntime(pi);
  runtimes.set(pi, runtime);
  return runtime;
}
