import type {
  AgentSession,
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { createAgentSession } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
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

export type RuntimeOwner =
  | string
  | {
      kind: "public" | "internal";
      name: string;
    }
  | {
      kind: "nested";
      parentId: string;
      tool: string;
    };

export type RuntimeSnapshot = {
  id: string;
  status: SubagentRuntimeStatus;
  owner: RuntimeOwner;
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
  owner: RuntimeOwner;
  type: string;
  description: string;
  cwd: string;
  model?: string;
  thinking?: ThinkingLevel;
  extensionBinding?: ExtensionBindingStatus;
  sandboxMode?: SandboxMode;
};

export type PublicAgentMode = "foreground" | "background";

export type ExploreBreadth = "quick" | "medium" | "very thorough";

export type ExploreToolParams = {
  question: string;
  breadth?: ExploreBreadth;
};

export type RunManagedAgentInput = {
  type: string;
  prompt: string;
  description?: string;
  cwd: string;
  model?: string;
  thinking?: ThinkingLevel;
  mode?: PublicAgentMode;
  ctx: ExtensionContext;
  signal?: AbortSignal;
  sandboxMode?: SandboxMode;
  owner?: RuntimeOwner;
};

export type RunPublicAgentInput = Omit<RunManagedAgentInput, "type"> & {
  type: PublicBuiltinType;
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
  getAllTools?: () => Array<{ name: string }>;
};

type CreateSessionOptions = Parameters<typeof createAgentSession>[0] & {
  sandboxMode?: SandboxMode;
};
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
const readOnlyToolNames = ["read", "bash", "grep", "find", "ls"];
const constrainedSandboxModes = new Set<SandboxMode>([
  "inherit",
  "read-only",
  "workspace-write",
]);
const EXPLORE_TOOL_TIMEOUT_MS = 120_000;
const EXPLORE_TOOL_MAX_RESULT_CHARS = 50_000;
const exploreEligibleTypes = new Set([
  "General",
  "Review",
  "general-purpose",
  "Implement",
  "Reviewer",
  "reviewer",
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

function isNestedOwner(
  owner: RuntimeOwner,
): owner is Extract<RuntimeOwner, { kind: "nested" }> {
  return typeof owner === "object" && owner.kind === "nested";
}

function isExploreEligible(type: string): boolean {
  return exploreEligibleTypes.has(type) && type !== "Explore";
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

function resolveModelRef(
  ctx: ExtensionContext,
  modelRef: string | undefined,
): { ref?: string; model?: Model<Api> } {
  if (modelRef === undefined) {
    const model = ctx.model as Model<Api> | undefined;
    if (!model) {
      return {};
    }
    const provider = (model as { provider?: unknown }).provider;
    const id = (model as { id?: unknown }).id;
    return {
      ...(typeof provider === "string" && typeof id === "string"
        ? { ref: `${provider}/${id}` }
        : {}),
      model,
    };
  }
  return { ref: modelRef, model: findModel(ctx, modelRef) };
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

function sandboxRequiresRestrictedBash(
  sandboxMode: SandboxMode | undefined,
): boolean {
  return sandboxMode !== undefined && constrainedSandboxModes.has(sandboxMode);
}

function createRestrictedNestedBashTool(
  sandboxMode: SandboxMode,
): ToolDefinition {
  return {
    name: "bash",
    label: "bash",
    description:
      "Bash is unavailable in this nested Explore child because the parent session has sandbox/read-only constraints that cannot be safely relaxed. Use read, grep, find, and ls instead.",
    parameters: Type.Object({
      command: Type.String(),
      timeout: Type.Optional(Type.Number()),
    }),
    async execute() {
      const text = `bash unavailable in nested explore: parent sandbox mode '${sandboxMode}' is enforced. Use read, grep, find, and ls instead.`;
      return {
        content: [{ type: "text", text }],
        details: { sandboxMode, blocked: true },
        isError: true,
      };
    },
  };
}

function buildExplorePrompt(params: ExploreToolParams): string {
  return [
    "You are a nested read-only Explore child. Answer the parent agent's bounded codebase exploration question.",
    "Use only read, bash, grep, find, and ls. Do not edit, write, stage, commit, spawn agents, or call custom/public agent tools.",
    `Breadth: ${params.breadth ?? "medium"}`,
    "Return concise findings with relevant file paths and enough context for the parent to continue with direct reads/searches.",
    "",
    `Question: ${params.question.trim()}`,
  ].join("\n");
}

function resultText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value === undefined || value === null) {
    return "";
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function truncateText(text: string): { text: string; truncated: boolean } {
  if (text.length <= EXPLORE_TOOL_MAX_RESULT_CHARS) {
    return { text, truncated: false };
  }
  return {
    text: `${text.slice(0, EXPLORE_TOOL_MAX_RESULT_CHARS)}\n\n[explore output truncated after ${EXPLORE_TOOL_MAX_RESULT_CHARS} characters; continue with direct reads/searches.]`,
    truncated: true,
  };
}

function exploreToolResult(
  snapshot: RuntimeSnapshot,
): AgentToolResult<unknown> {
  if (snapshot.status === "completed") {
    const truncated = truncateText(resultText(snapshot.result));
    return {
      content: [{ type: "text", text: truncated.text }],
      details: {
        id: snapshot.id,
        status: snapshot.status,
        truncated: truncated.truncated,
      },
    };
  }
  const reason = snapshot.error ?? `${snapshot.status}.`;
  const text =
    snapshot.status === "stopped"
      ? `explore stopped or timed out: ${reason} Continue with direct reads/searches.`
      : `explore ${snapshot.status}: ${reason} Continue with direct reads/searches.`;
  return {
    content: [{ type: "text", text }],
    details: {
      id: snapshot.id,
      status: snapshot.status,
      error: snapshot.error,
    },
  };
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
    runtimes.set(pi, this);
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
    return this.runManagedAgent({
      ...input,
      owner: input.owner ?? "public-tool",
    });
  }

  async runManagedAgent(input: RunManagedAgentInput): Promise<RuntimeSnapshot> {
    if (input.prompt.trim() === "") {
      throw new Error("Agent prompt must not be empty");
    }
    const queued = this.queue({
      owner: input.owner ?? "internal",
      type: input.type,
      description: input.description ?? input.prompt.slice(0, 120),
      cwd: input.cwd,
      model: input.model,
      thinking: input.thinking,
      extensionBinding: "unbound",
      sandboxMode: input.sandboxMode,
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

  createExploreTool(parent: RuntimeSnapshot): ToolDefinition {
    return {
      name: "explore",
      label: "explore",
      description:
        "Ask a nested read-only Explore child to answer a bounded codebase discovery question synchronously. Use for locating symbols, tracing usage, or mapping unfamiliar code before direct reads/searches. The child can only read/search/list and run bash through inherited sandbox constraints; it cannot edit, write, spawn agents, or call explore again. Keep questions specific and continue with direct reads if the result is stopped, failed, timed out, or truncated.",
      parameters: Type.Object({
        question: Type.String({
          description: "Specific codebase exploration question to answer.",
        }),
        breadth: Type.Optional(
          Type.Union([
            Type.Literal("quick"),
            Type.Literal("medium"),
            Type.Literal("very thorough"),
          ]),
        ),
      }),
      executionMode: "sequential",
      execute: async (_toolCallId, params, signal, _onUpdate, ctx) =>
        this.runExploreTool(parent, params as ExploreToolParams, ctx, signal),
    };
  }

  async runExploreTool(
    parent: RuntimeSnapshot,
    params: ExploreToolParams,
    ctx: ExtensionContext,
    signal?: AbortSignal,
  ): Promise<AgentToolResult<unknown>> {
    if (parent.type === "Explore" || isNestedOwner(parent.owner)) {
      return {
        content: [
          {
            type: "text",
            text: "explore is unavailable from Explore agents or nested child agents. Use direct read/search tools instead.",
          },
        ],
        details: { status: "failed", error: "recursion prevented" },
      };
    }
    if (params.question.trim() === "") {
      return {
        content: [
          { type: "text", text: "explore question must not be empty." },
        ],
        details: { status: "failed", error: "empty question" },
      };
    }

    const timeout = new AbortController();
    const relay = () => timeout.abort();
    const timer = setTimeout(() => timeout.abort(), EXPLORE_TOOL_TIMEOUT_MS);
    if (signal?.aborted) {
      timeout.abort();
    } else {
      signal?.addEventListener("abort", relay, { once: true });
    }

    try {
      const model =
        this.publicConfig.models.Explore ?? resolveModelRef(ctx, undefined).ref;
      const started = await this.runPublicAgent({
        type: "Explore",
        prompt: buildExplorePrompt(params),
        description: `explore: ${params.question.trim().slice(0, 100)}`,
        cwd: parent.cwd,
        ...(model === undefined ? {} : { model }),
        thinking: this.publicConfig.thinking.Explore,
        mode: "background",
        ctx,
        signal: timeout.signal,
        sandboxMode: parent.sandboxMode,
        owner: { kind: "nested", parentId: parent.id, tool: "explore" },
      });
      const finalSnapshot = await this.wait(started.id);
      return exploreToolResult(finalSnapshot);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", relay);
    }
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

  snapshots(options: { includeNested?: boolean } = {}): RuntimeSnapshot[] {
    return [...this.#records.values()]
      .filter((record) => options.includeNested || !isNestedOwner(record.owner))
      .map((record) => snapshot(record));
  }

  async #runRecord(
    record: RuntimeRecord,
    input: RunManagedAgentInput,
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
      const { model } = resolveModelRef(input.ctx, record.model);
      const nested = isNestedOwner(record.owner);
      const { session } = await this.#createSession({
        cwd: record.cwd,
        model,
        ...(record.thinking === undefined
          ? {}
          : { thinkingLevel: record.thinking }),
        ...(record.sandboxMode === undefined
          ? {}
          : { sandboxMode: record.sandboxMode }),
        ...(nested
          ? {
              tools: readOnlyToolNames,
              excludeTools: ["explore", ...publicToolNames, "edit", "write"],
              customTools: this.#nestedCustomToolsFor(record),
            }
          : {
              customTools: this.#customToolsFor(record),
            }),
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

  #customToolsFor(record: RuntimeRecord): ToolDefinition[] | undefined {
    if (!isExploreEligible(record.type)) {
      return undefined;
    }
    return [this.createExploreTool(snapshot(record))];
  }

  #nestedCustomToolsFor(record: RuntimeRecord): ToolDefinition[] | undefined {
    const { sandboxMode } = record;
    if (
      sandboxMode === undefined ||
      !sandboxRequiresRestrictedBash(sandboxMode)
    ) {
      return undefined;
    }
    return [createRestrictedNestedBashTool(sandboxMode)];
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
    if (!getActiveTools && !isNestedOwner(record.owner)) {
      return;
    }
    let activeTools = getActiveTools?.() ?? [];
    if (isNestedOwner(record.owner)) {
      activeTools = readOnlyToolNames;
    } else {
      if (record.type === "General" || !isPublicBuiltinType(record.type)) {
        activeTools = activeTools.filter((name) => !publicToolNames.has(name));
      }
      if (isExploreEligible(record.type)) {
        activeTools = [...activeTools, "explore"];
      }
    }
    session.setActiveToolsByName([...new Set(activeTools)]);
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
