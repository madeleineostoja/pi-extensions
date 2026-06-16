import type {
  AgentSession,
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
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
import {
  PUBLIC_AGENT_PROFILES,
  type AgentProfile,
  type PromptMode,
} from "./agent-profiles.js";
export type { ThinkingLevel } from "./config.js";
export type { PromptMode } from "./agent-profiles.js";

export type SubagentRuntimeStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "stopped";

export type ExtensionBindingStatus = "bound" | "unbound";

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
      kind: "pi-implement";
      runId: string;
      role: string;
      taskId?: string;
    }
  | {
      kind: "nested";
      parentId: string;
      tool: string;
      parentOwner?: RuntimeOwner;
    };

export type RuntimeHealth = {
  turns?: number;
  toolUses?: number;
  tokensTotal?: number;
  activeTool?: string;
  lastActivity?: string;
  lastAssistantText?: string;
  resultPreview?: string;
  transcript?: {
    sessionId?: string;
    sessionFile?: string;
  };
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
  timestamps: RuntimeTimestamps;
  health?: RuntimeHealth;
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
  owner?: RuntimeOwner;
  tools?: string[];
  excludeTools?: string[];
  systemPrompt?: string;
  systemPromptMode?: PromptMode;
};

export type RunPublicAgentInput = Omit<RunManagedAgentInput, "type"> & {
  type: PublicBuiltinType;
};

type RuntimeRecord = Omit<RuntimeSnapshot, "timestamps"> &
  RuntimeTimestamps & {
    runtimeSessionId: number;
    retired?: boolean;
    session?: PublicAgentSession;
    canSteer?: boolean;
    steeringQueue: string[];
    health?: RuntimeHealth;
    unsubscribeSession?: () => void;
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
  readonly messages?: unknown[];
  readonly sessionId?: string;
  readonly sessionFile?: string;
  subscribe?: (listener: (event: unknown) => void) => () => void;
  getAllTools?: () => Array<{ name: string }>;
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
const runtimeManagerKey = Symbol.for("pi-subagents:manager");
type RuntimeManager = {
  runtimes: WeakMap<ExtensionAPI, SubagentRuntime>;
};
const publicTypes = new Set<string>(PUBLIC_BUILTIN_TYPES);
const publicToolNames = new Set([
  "Agent",
  "get_subagent_result",
  "steer_subagent",
]);
const sessionStartReasons = new Set(["startup", "new", "resume", "fork"]);
const replacementShutdownReasons = new Set(["new", "resume", "fork"]);
export function withoutPublicAgentTools(names: string[]): string[] {
  return names.filter((name) => !publicToolNames.has(name));
}

function normalizeActiveToolNames(
  names: string[],
  options: { allowExplore: boolean },
): string[] {
  return withoutPublicAgentTools(names).filter(
    (name) => options.allowExplore || name !== "explore",
  );
}

const readOnlyToolNames = normalizeActiveToolNames(
  ["read", "bash", "grep", "find", "ls"],
  { allowExplore: false },
);
const defaultSystemPromptMode: PromptMode = "append";
const EXPLORE_TOOL_TIMEOUT_MS = 120_000;
const EXPLORE_TOOL_MAX_RESULT_CHARS = 50_000;
const exploreEligibleTypes = new Set([
  "General",
  "Review",
  "general-purpose",
  "Implement",
  "Reviewer",
  "reviewer",
  "pi-implement:implementer",
  "pi-implement:reviewer",
]);

function now(): string {
  return new Date().toISOString();
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function snapshot(record: RuntimeRecord): RuntimeSnapshot {
  updateRecordHealth(record);
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
    ...(record.health === undefined ? {} : { health: { ...record.health } }),
    ...(record.result === undefined ? {} : { result: record.result }),
    ...(record.error === undefined ? {} : { error: record.error }),
  };
}

function isTerminal(status: SubagentRuntimeStatus): boolean {
  return status === "completed" || status === "failed" || status === "stopped";
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function usageTokens(value: unknown): number | undefined {
  if (!isObject(value)) {
    return undefined;
  }
  const total = finiteNumber(value.totalTokens) ?? finiteNumber(value.total);
  if (total !== undefined) {
    return total;
  }
  const input = finiteNumber(value.input) ?? 0;
  const output = finiteNumber(value.output) ?? 0;
  const cacheRead = finiteNumber(value.cacheRead) ?? 0;
  const cacheWrite = finiteNumber(value.cacheWrite) ?? 0;
  const sum = input + output + cacheRead + cacheWrite;
  return sum > 0 ? sum : undefined;
}

function textPreview(value: unknown, max = 600): string | undefined {
  let text: string;
  if (typeof value === "string") {
    text = value;
  } else if (value === undefined || value === null) {
    return undefined;
  } else {
    try {
      text = JSON.stringify(value);
    } catch {
      text = String(value);
    }
  }
  const compact = text.replace(/\s+/g, " ").trim();
  if (!compact) {
    return undefined;
  }
  return compact.length > max ? `${compact.slice(0, max - 1)}…` : compact;
}

function messageText(message: unknown): string | undefined {
  if (!isObject(message)) {
    return undefined;
  }
  const content = message.content;
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return undefined;
  }
  return content
    .map((part) =>
      isObject(part) && typeof part.text === "string" ? part.text : "",
    )
    .filter(Boolean)
    .join("\n");
}

function updateRecordHealth(record: RuntimeRecord): void {
  const session = record.session;
  if (!session) {
    if (record.result !== undefined) {
      record.health = {
        ...record.health,
        resultPreview: textPreview(record.result),
      };
    }
    return;
  }
  const messages = Array.isArray(session.messages) ? session.messages : [];
  const assistantMessages = messages.filter(
    (message) => isObject(message) && message.role === "assistant",
  );
  const toolResults = messages.filter(
    (message) => isObject(message) && message.role === "toolResult",
  );
  let toolUses = 0;
  let tokensTotal = 0;
  let activeTool: string | undefined;
  let lastActivity: string | undefined;
  let lastAssistantText: string | undefined;
  for (const message of messages) {
    if (!isObject(message)) {
      continue;
    }
    if (typeof message.timestamp === "number") {
      lastActivity = new Date(message.timestamp).toISOString();
    }
    if (message.role === "assistant") {
      const usage = usageTokens(message.usage);
      if (usage !== undefined) {
        tokensTotal += usage;
      }
      const preview = textPreview(messageText(message));
      if (preview) {
        lastAssistantText = preview;
      }
      const content = Array.isArray(message.content) ? message.content : [];
      for (const part of content) {
        if (isObject(part) && part.type === "toolCall") {
          toolUses += 1;
          if (typeof part.name === "string") {
            activeTool = part.name;
          }
        }
      }
    }
    if (message.role === "toolResult" && typeof message.toolName === "string") {
      activeTool = message.toolName;
    }
  }
  const sessionId =
    typeof session.sessionId === "string" ? session.sessionId : undefined;
  const sessionFile =
    typeof session.sessionFile === "string" ? session.sessionFile : undefined;
  record.health = {
    ...record.health,
    turns: assistantMessages.length,
    toolUses: toolUses || toolResults.length || undefined,
    tokensTotal: tokensTotal || undefined,
    activeTool,
    lastActivity,
    lastAssistantText:
      lastAssistantText ?? textPreview(session.getLastAssistantText?.()),
    resultPreview:
      record.result === undefined
        ? record.health?.resultPreview
        : textPreview(record.result),
    ...(sessionId || sessionFile
      ? { transcript: { sessionId, sessionFile } }
      : {}),
  };
}

function isPublicBuiltinType(type: string): type is PublicBuiltinType {
  return publicTypes.has(type);
}

function publicAgentProfile(type: string): AgentProfile | undefined {
  return isPublicBuiltinType(type) ? PUBLIC_AGENT_PROFILES[type] : undefined;
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

function resolveSystemPromptInput(
  input: RunManagedAgentInput,
): { prompt: string; mode: PromptMode } | undefined {
  const profile = publicAgentProfile(input.type);
  const prompt = input.systemPrompt ?? profile?.systemPrompt;
  if (prompt === undefined) {
    return undefined;
  }
  return {
    prompt,
    mode:
      input.systemPromptMode ?? profile?.promptMode ?? defaultSystemPromptMode,
  };
}

async function createPromptResourceLoader(
  cwd: string,
  promptInput: { prompt: string; mode: PromptMode },
): Promise<{ agentDir: string; resourceLoader: DefaultResourceLoader }> {
  const agentDir = getAgentDir();
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    ...(promptInput.mode === "replace"
      ? { systemPrompt: promptInput.prompt }
      : { appendSystemPrompt: [promptInput.prompt] }),
  });
  await resourceLoader.reload();
  return { agentDir, resourceLoader };
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
  #currentSessionId = 0;
  #createSession: CreateSession;

  constructor(
    public readonly pi: ExtensionAPI,
    options: {
      publicConfig?: ResolvedPublicSubagentsConfig;
      createSession?: CreateSession;
    } = {},
  ) {
    runtimes.set(pi, this);
    getRuntimeManager().runtimes.set(pi, this);
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

  beginSession(reason = "startup"): void {
    if (!sessionStartReasons.has(reason)) {
      return;
    }
    this.#currentSessionId += 1;
  }

  handleSessionShutdown(reason?: string): RuntimeSnapshot[] {
    if (!replacementShutdownReasons.has(reason ?? "")) {
      return [];
    }
    return this.retireCurrentSession(`Session replaced (${reason}).`);
  }

  retireCurrentSession(reason = "Session replaced."): RuntimeSnapshot[] {
    const currentRecords = [...this.#records.values()].filter(
      (record) => record.runtimeSessionId === this.#currentSessionId,
    );
    const retired: RuntimeSnapshot[] = [];
    for (const record of currentRecords) {
      record.retired = true;
      record.unsubscribeSession?.();
      record.unsubscribeSession = undefined;
      if (!isTerminal(record.status)) {
        record.session?.abort().catch(() => {});
        const timestamp = now();
        record.status = "stopped";
        record.error = reason;
        record.completedAt = timestamp;
        record.updatedAt = timestamp;
        retired.push(this.#finish(record));
      } else {
        this.#waiters.delete(record.id);
      }
      this.#records.delete(record.id);
    }
    return retired;
  }

  queue(input: QueueSubagentInput): RuntimeSnapshot {
    const id = `subagent-${this.#nextId++}`;
    const timestamp = now();
    const publicAgentConfig = publicTypes.has(input.type)
      ? this.publicConfig.agents[input.type as PublicBuiltinType]
      : undefined;
    const model = input.model ?? publicAgentConfig?.model;
    const thinking = input.thinking ?? publicAgentConfig?.thinking;

    const record: RuntimeRecord = {
      id,
      runtimeSessionId: this.#currentSessionId,
      status: "queued",
      owner: input.owner,
      type: input.type,
      description: input.description,
      cwd: input.cwd,
      ...(model === undefined ? {} : { model }),
      ...(thinking === undefined ? {} : { thinking }),
      extensionBinding: input.extensionBinding ?? "unbound",
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
        this.publicConfig.agents.Explore.model ??
        resolveModelRef(ctx, undefined).ref;
      const started = await this.runPublicAgent({
        type: "Explore",
        prompt: buildExplorePrompt(params),
        description: `explore: ${params.question.trim().slice(0, 100)}`,
        cwd: parent.cwd,
        ...(model === undefined ? {} : { model }),
        thinking: this.publicConfig.agents.Explore.thinking,
        mode: "background",
        ctx,
        signal: timeout.signal,
        owner:
          typeof parent.owner === "object" &&
          parent.owner.kind === "pi-implement"
            ? {
                kind: "nested",
                parentId: parent.id,
                tool: "explore",
                parentOwner: parent.owner,
              }
            : { kind: "nested", parentId: parent.id, tool: "explore" },
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
    const record = this.#requireRecord(id);
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
    return snapshot(this.#requireRecord(id));
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
    return record && this.#isCurrentRecord(record)
      ? snapshot(record)
      : undefined;
  }

  getRecord(id: string): RuntimeSnapshot | undefined {
    return this.snapshot(id);
  }

  snapshots(options: { includeNested?: boolean } = {}): RuntimeSnapshot[] {
    return [...this.#records.values()]
      .filter((record) => this.#isCurrentRecord(record))
      .filter((record) => options.includeNested || !isNestedOwner(record.owner))
      .map((record) => snapshot(record));
  }

  async #runRecord(
    record: RuntimeRecord,
    input: RunManagedAgentInput,
  ): Promise<RuntimeSnapshot> {
    const abort = () => {
      if (this.#isCurrentRecord(record) && !isTerminal(record.status)) {
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
      const promptInput = resolveSystemPromptInput(input);
      const resources = promptInput
        ? await createPromptResourceLoader(record.cwd, promptInput)
        : undefined;
      const profileTools = publicAgentProfile(record.type)?.tools;
      const allowExplore = isExploreEligible(record.type) && !nested;
      const explicitTools =
        input.tools === undefined
          ? undefined
          : normalizeActiveToolNames(input.tools, { allowExplore });
      const profileAllowlist =
        profileTools === undefined
          ? undefined
          : normalizeActiveToolNames(profileTools, { allowExplore });
      const createSessionOptions = {
        cwd: record.cwd,
        model,
        ...(record.thinking === undefined
          ? {}
          : { thinkingLevel: record.thinking }),
        ...(resources === undefined
          ? {}
          : {
              agentDir: resources.agentDir,
              resourceLoader: resources.resourceLoader,
            }),
        ...(nested
          ? {
              tools: explicitTools ?? [...readOnlyToolNames],
              excludeTools: input.excludeTools ?? [
                "explore",
                ...publicToolNames,
                "edit",
                "write",
              ],
            }
          : {
              ...(explicitTools === undefined
                ? profileAllowlist === undefined
                  ? {}
                  : { tools: [...profileAllowlist] }
                : { tools: explicitTools }),
              ...(input.excludeTools === undefined
                ? {}
                : { excludeTools: input.excludeTools }),
              customTools: this.#customToolsFor(record),
            }),
      };
      const { session } = await this.#createSession(createSessionOptions);
      if (!this.#isCurrentRecord(record) || isTerminal(record.status)) {
        await this.#disposeSession(session);
        return snapshot(record);
      }
      record.session = session;
      record.unsubscribeSession = session.subscribe?.((event) => {
        const candidate = isObject(event) ? event : undefined;
        const toolName =
          candidate &&
          isObject(candidate.toolCall) &&
          typeof candidate.toolCall.name === "string"
            ? candidate.toolCall.name
            : candidate && typeof candidate.toolName === "string"
              ? candidate.toolName
              : undefined;
        record.health = {
          ...record.health,
          ...(toolName === undefined ? {} : { activeTool: toolName }),
          lastActivity: now(),
        };
        record.updatedAt = now();
      });
      await session.bindExtensions({
        mode: "print",
        abortHandler: () => void session.abort(),
        shutdownHandler: () => {},
      });
      record.extensionBinding = "bound";
      this.#inheritActiveTools(record, session, input.tools);
      const prompt = session.prompt(input.prompt, { source: "extension" });
      record.canSteer = true;
      await this.#flushSteering(record);
      await prompt;
      if (!this.#isCurrentRecord(record) || isTerminal(record.status)) {
        return snapshot(record);
      }
      const state = "state" in session ? session.state : undefined;
      if (state?.errorMessage) {
        return this.fail(record.id, state.errorMessage);
      }
      const result = session.getLastAssistantText() ?? "";
      return this.complete(record.id, result);
    } catch (error) {
      if (!this.#isCurrentRecord(record) || isTerminal(record.status)) {
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

  async #disposeSession(session: PublicAgentSession): Promise<void> {
    for (const record of this.#records.values()) {
      if (record.session === session) {
        record.unsubscribeSession?.();
        record.unsubscribeSession = undefined;
        updateRecordHealth(record);
      }
    }
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
    explicitTools?: string[],
  ): void {
    const getActiveTools = this.pi.getActiveTools?.bind(this.pi);
    const allowExplore =
      isExploreEligible(record.type) && !isNestedOwner(record.owner);
    if (explicitTools) {
      const activeTools = allowExplore
        ? [...explicitTools, "explore"]
        : explicitTools;
      session.setActiveToolsByName(
        normalizeActiveToolNames([...new Set(activeTools)], { allowExplore }),
      );
      return;
    }
    const profileTools = publicAgentProfile(record.type)?.tools;
    if (profileTools !== undefined && !isNestedOwner(record.owner)) {
      session.setActiveToolsByName(
        normalizeActiveToolNames([...new Set(profileTools)], { allowExplore }),
      );
      return;
    }
    if (!getActiveTools && !isNestedOwner(record.owner)) {
      return;
    }
    let activeTools = getActiveTools?.() ?? [];
    if (isNestedOwner(record.owner)) {
      activeTools = readOnlyToolNames;
    } else if (allowExplore) {
      activeTools = [...activeTools, "explore"];
    }
    session.setActiveToolsByName(
      normalizeActiveToolNames([...new Set(activeTools)], { allowExplore }),
    );
  }

  async #flushSteering(record: RuntimeRecord): Promise<void> {
    const session = record.session;
    if (!session) {
      return;
    }
    while (
      record.steeringQueue.length > 0 &&
      this.#isCurrentRecord(record) &&
      !isTerminal(record.status)
    ) {
      const message = record.steeringQueue.shift();
      if (message !== undefined) {
        await session.steer(message);
      }
    }
  }

  #requireRecord(id: string): RuntimeRecord {
    const record = this.#records.get(id);
    if (!record || !this.#isCurrentRecord(record)) {
      throw new Error(`Unknown subagent ${id}`);
    }
    return record;
  }

  #isCurrentRecord(record: RuntimeRecord): boolean {
    return (
      !record.retired && record.runtimeSessionId === this.#currentSessionId
    );
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

function getRuntimeManager(): RuntimeManager {
  const globalScope = globalThis as Record<symbol, unknown>;
  const existing = globalScope[runtimeManagerKey];
  if (isRuntimeManager(existing)) {
    return existing;
  }
  const manager: RuntimeManager = { runtimes: new WeakMap() };
  if (isRuntimeInstance(existing)) {
    manager.runtimes.set(existing.pi, existing);
  }
  globalScope[runtimeManagerKey] = manager;
  return manager;
}

function isRuntimeManager(value: unknown): value is RuntimeManager {
  return (
    isObject(value) &&
    "runtimes" in value &&
    value.runtimes instanceof WeakMap
  );
}

function isRuntimeInstance(value: unknown): value is SubagentRuntime {
  return isObject(value) && "pi" in value;
}

export function getSubagentRuntime(pi: ExtensionAPI): SubagentRuntime {
  const existing = runtimes.get(pi);
  if (existing) {
    return existing;
  }
  const runtimeManager = getRuntimeManager();
  const managed = runtimeManager.runtimes.get(pi);
  if (managed) {
    runtimes.set(pi, managed);
    return managed;
  }
  const runtime = new SubagentRuntime(pi);
  runtimes.set(pi, runtime);
  return runtime;
}
