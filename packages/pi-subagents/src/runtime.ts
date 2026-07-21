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
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static, type TSchema } from "typebox";
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
export type RosterVisibility = "show" | "hide";

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

export type RuntimeContextUsage = {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
};

export type RuntimeHealth = {
  turns?: number;
  toolUses?: number;
  tokensTotal?: number;
  contextUsage?: RuntimeContextUsage;
  peakContextTokens?: number;
  activeTool?: string;
  lastActivity?: string;
  lastAssistantText?: string;
  resultPreview?: string;
  transcript?: {
    sessionId?: string;
    sessionFile?: string;
  };
};

export type RuntimeSnapshot<TResult = unknown> = {
  id: string;
  status: SubagentRuntimeStatus;
  owner: RuntimeOwner;
  type: string;
  description: string;
  cwd: string;
  model?: string;
  thinking?: ThinkingLevel;
  extensionBinding: ExtensionBindingStatus;
  rosterVisibility: RosterVisibility;
  timestamps: RuntimeTimestamps;
  health?: RuntimeHealth;
  result?: TResult;
  error?: string;
};

export type RuntimeInspection = {
  snapshot: RuntimeSnapshot;
  messages: readonly unknown[];
};

export type RuntimeSubscriptionListener = () => void;

export type QueueSubagentInput = {
  owner: RuntimeOwner;
  type: string;
  description: string;
  cwd: string;
  model?: string;
  thinking?: ThinkingLevel;
  extensionBinding?: ExtensionBindingStatus;
  rosterVisibility?: RosterVisibility;
};

export type PublicAgentMode = "foreground" | "background";

export type ExploreBreadth = "quick" | "medium" | "very thorough";

export type ExploreToolParams = {
  question: string;
  breadth?: ExploreBreadth;
};

export type ManagedCompletion<TSchemaValue extends TSchema = TSchema> = {
  description: string;
  schema: TSchemaValue;
  label?: string;
};

export type RunManagedAgentInput<
  TSchemaValue extends TSchema | undefined = undefined,
> = {
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
  rosterVisibility?: RosterVisibility;
  completion?: ManagedCompletion<
    TSchemaValue extends TSchema ? TSchemaValue : TSchema
  >;
};

export type RunPublicAgentInput = Omit<
  RunManagedAgentInput,
  "type" | "completion"
> & {
  type: PublicBuiltinType;
};

type RuntimeRecord = Omit<RuntimeSnapshot, "timestamps"> &
  RuntimeTimestamps & {
    runtimeSessionId: number;
    retired?: boolean;
    session?: AgentSession;
    canSteer?: boolean;
    steeringQueue: string[];
    health?: RuntimeHealth;
    unsubscribeSession?: () => void;
    retainedMessages?: readonly unknown[];
    initialization?: Promise<void>;
    resolveInitialization?: () => void;
    finalization?: Promise<RuntimeSnapshot>;
    completion?: {
      definition: ManagedCompletion;
      accepted: boolean;
      payload?: unknown;
    };
    inspectListeners: Set<RuntimeSubscriptionListener>;
  };

type CreateSessionOptions = Parameters<typeof createAgentSession>[0];
type CreateSessionResult = { session: AgentSession };
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
  runtimeList: Set<SubagentRuntime>;
};
const publicTypes = new Set<string>(PUBLIC_BUILTIN_TYPES);
const publicToolNames = new Set([
  "Agent",
  "get_subagent_result",
  "steer_subagent",
  "propose_papercut",
]);
const sessionStartReasons = new Set(["startup", "new", "resume", "fork"]);
const retirementShutdownReasons = new Set(["quit", "new", "resume", "fork"]);
export function withoutPublicAgentTools(names: string[]): string[] {
  return names.filter((name) => !publicToolNames.has(name));
}

function normalizeActiveToolNames(
  names: string[],
  options: { allowExplore: boolean; registered?: readonly string[] },
): string[] {
  return withoutPublicAgentTools(names).filter(
    (name) =>
      (options.allowExplore || name !== "explore") &&
      (name !== "lsp" || options.registered?.includes("lsp") !== false),
  );
}

const readOnlyToolNames = normalizeActiveToolNames(
  ["read", "bash", "grep", "find", "ls", "lsp"],
  { allowExplore: false },
);
const defaultSystemPromptMode: PromptMode = "append";
const EXPLORE_TOOL_INACTIVITY_MS = 120_000;
const EXPLORE_TOOL_INACTIVITY_POLL_MS = 10_000;
const EXPLORE_TOOL_MAX_RESULT_CHARS = 50_000;
export const TERMINAL_MESSAGE_TAIL_LIMIT = 100;
export const MANAGED_COMPLETION_TOOL_NAME = "pi_managed_complete";
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

function timestampMs(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function latestTimestamp(
  current: string | undefined,
  candidate: string | undefined,
): string | undefined {
  const currentMs = timestampMs(current);
  const candidateMs = timestampMs(candidate);
  if (candidateMs === undefined) {
    return current;
  }
  if (currentMs === undefined || candidateMs > currentMs) {
    return candidate;
  }
  return current;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function copyTerminalValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return Object.freeze(value.map(copyTerminalValue));
  }
  if (isObject(value)) {
    return Object.freeze(
      Object.fromEntries(
        Object.entries(value).map(([key, entry]) => [
          key,
          copyTerminalValue(entry),
        ]),
      ),
    );
  }
  return value;
}

function copyTerminalMessages(
  messages: readonly unknown[],
): readonly unknown[] {
  return Object.freeze(
    messages.slice(-TERMINAL_MESSAGE_TAIL_LIMIT).map(copyTerminalValue),
  );
}

function projectSnapshot(record: RuntimeRecord): RuntimeSnapshot {
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
    rosterVisibility: record.rosterVisibility,
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

function refreshContextHealth(record: RuntimeRecord): void {
  const usage = record.session?.getContextUsage?.();
  if (!usage) {
    return;
  }
  const peakContextTokens =
    usage.tokens === null
      ? record.health?.peakContextTokens
      : Math.max(record.health?.peakContextTokens ?? 0, usage.tokens);
  record.health = {
    ...record.health,
    contextUsage: {
      tokens: usage.tokens,
      contextWindow: usage.contextWindow,
      percent: usage.percent,
    },
    ...(peakContextTokens === undefined ? {} : { peakContextTokens }),
  };
}

function refreshHealth(record: RuntimeRecord): void {
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
  refreshContextHealth(record);
  const messages = session.messages;
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
      lastActivity = latestTimestamp(
        lastActivity,
        new Date(message.timestamp).toISOString(),
      );
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
  const { sessionId, sessionFile } = session;
  record.health = {
    ...record.health,
    turns: assistantMessages.length,
    toolUses: toolUses || toolResults.length || undefined,
    tokensTotal: tokensTotal || undefined,
    activeTool: activeTool ?? record.health?.activeTool,
    lastActivity: latestTimestamp(record.health?.lastActivity, lastActivity),
    lastAssistantText:
      lastAssistantText ?? textPreview(session.getLastAssistantText()),
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

function resolveSystemPromptInput<TSchemaValue extends TSchema | undefined>(
  input: RunManagedAgentInput<TSchemaValue>,
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
    "Use only read, bash, grep, find, ls, and lsp when available. Do not edit, write, stage, commit, spawn agents, or call custom/public agent tools.",
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
  #shutdownFinalization?: Promise<void>;

  constructor(
    public readonly pi: ExtensionAPI,
    options: {
      publicConfig?: ResolvedPublicSubagentsConfig;
      createSession?: CreateSession;
    } = {},
  ) {
    runtimes.set(pi, this);
    const runtimeManager = getRuntimeManager();
    runtimeManager.runtimes.set(pi, this);
    runtimeManager.runtimeList.add(this);
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
    if (!retirementShutdownReasons.has(reason ?? "")) {
      return [];
    }
    const message =
      reason === "quit"
        ? "Session ended (quit)."
        : `Session replaced (${reason}).`;
    return this.retireCurrentSession(message);
  }

  retireCurrentSession(reason = "Session replaced."): RuntimeSnapshot[] {
    const currentRecords = [...this.#records.values()].filter(
      (record) => record.runtimeSessionId === this.#currentSessionId,
    );
    for (const record of currentRecords) {
      record.retired = true;
      if (!isTerminal(record.status)) {
        this.#markStopped(record, reason);
      }
      void this.#finalize(record, {
        allowRetiredNotification: true,
        clearInspectListeners: true,
      });
      this.#records.delete(record.id);
      this.#notifyInspectListeners(record, {
        allowRetired: true,
        clear: true,
      });
    }
    this.#shutdownFinalization = Promise.all(
      currentRecords.map((record) => record.finalization ?? Promise.resolve()),
    ).then(() => {});
    return currentRecords.map(projectSnapshot);
  }

  async waitForShutdown(): Promise<void> {
    await this.#shutdownFinalization;
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
      rosterVisibility: input.rosterVisibility ?? "show",
      queuedAt: timestamp,
      updatedAt: timestamp,
      steeringQueue: [],
      inspectListeners: new Set(),
    };
    this.#records.set(id, record);
    return projectSnapshot(record);
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

  async runManagedAgent<TSchemaValue extends TSchema | undefined = undefined>(
    input: RunManagedAgentInput<TSchemaValue>,
  ): Promise<
    RuntimeSnapshot<
      TSchemaValue extends TSchema ? Static<TSchemaValue> : unknown
    >
  > {
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
      rosterVisibility: input.rosterVisibility,
    });
    const record = this.#requireRecord(queued.id);
    if (input.completion) {
      record.completion = {
        definition: input.completion,
        accepted: false,
      };
    }
    this.start(record.id);
    const running = this.#runRecord(record, input);
    if (input.mode === "background") {
      void running;
      return projectSnapshot(record) as RuntimeSnapshot<
        TSchemaValue extends TSchema ? Static<TSchemaValue> : unknown
      >;
    }
    return running as Promise<
      RuntimeSnapshot<
        TSchemaValue extends TSchema ? Static<TSchemaValue> : unknown
      >
    >;
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
    let inactivityTimer: ReturnType<typeof setInterval> | undefined;
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
      let lastObservedActivityMs: number | undefined;
      const updateActivityBaseline = (snapshot: RuntimeSnapshot) => {
        const activityMs = timestampMs(snapshot.health?.lastActivity);
        if (activityMs !== undefined) {
          lastObservedActivityMs = Math.max(
            lastObservedActivityMs ?? activityMs,
            activityMs,
          );
          return;
        }
        if (lastObservedActivityMs === undefined) {
          lastObservedActivityMs =
            timestampMs(snapshot.timestamps.startedAt) ??
            timestampMs(snapshot.timestamps.queuedAt);
        }
      };
      updateActivityBaseline(started);
      inactivityTimer = setInterval(() => {
        if (timeout.signal.aborted) {
          return;
        }
        updateActivityBaseline(this.snapshot(started.id) ?? started);
        if (
          lastObservedActivityMs !== undefined &&
          Date.now() - lastObservedActivityMs > EXPLORE_TOOL_INACTIVITY_MS
        ) {
          timeout.abort();
        }
      }, EXPLORE_TOOL_INACTIVITY_POLL_MS);
      const finalSnapshot = await this.wait(started.id);
      return exploreToolResult(finalSnapshot);
    } finally {
      if (inactivityTimer !== undefined) {
        clearInterval(inactivityTimer);
      }
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
    return projectSnapshot(record);
  }

  complete(id: string, result: unknown): RuntimeSnapshot {
    const record = this.#requireRecord(id);
    this.#ensureNotTerminal(record);
    const timestamp = now();
    record.status = "completed";
    record.result = result;
    record.completedAt = timestamp;
    record.updatedAt = timestamp;
    void this.#finalize(record);
    return projectSnapshot(record);
  }

  fail(id: string, error: unknown): RuntimeSnapshot {
    const record = this.#requireRecord(id);
    this.#ensureNotTerminal(record);
    const timestamp = now();
    record.status = "failed";
    record.error = errorText(error);
    record.completedAt = timestamp;
    record.updatedAt = timestamp;
    void this.#finalize(record);
    return projectSnapshot(record);
  }

  stop(id: string, error = "Stopped by user."): RuntimeSnapshot {
    const record = this.#requireRecord(id);
    this.#ensureNotTerminal(record);
    this.#markStopped(record, error);
    void this.#finalize(record);
    return projectSnapshot(record);
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
    refreshHealth(record);
    return projectSnapshot(record);
  }

  async result<TResult = unknown>(
    id: string,
    wait: boolean,
  ): Promise<RuntimeSnapshot<TResult>> {
    if (wait) {
      return this.wait<TResult>(id);
    }
    const record = this.#requireRecord(id);
    refreshHealth(record);
    return projectSnapshot(record) as RuntimeSnapshot<TResult>;
  }

  wait<TResult = unknown>(id: string): Promise<RuntimeSnapshot<TResult>> {
    const record = this.#requireRecord(id);
    if (isTerminal(record.status)) {
      return (record.finalization ??
        Promise.resolve(projectSnapshot(record))) as Promise<
        RuntimeSnapshot<TResult>
      >;
    }
    return new Promise((resolve) => {
      const waiters = this.#waiters.get(id) ?? [];
      waiters.push({ resolve: resolve as (snapshot: RuntimeSnapshot) => void });
      this.#waiters.set(id, waiters);
    });
  }

  snapshot(id: string): RuntimeSnapshot | undefined {
    const record = this.#records.get(id);
    if (!record || !this.#isCurrentRecord(record)) {
      return undefined;
    }
    refreshHealth(record);
    return projectSnapshot(record);
  }

  inspect(id: string): RuntimeInspection | undefined {
    const record = this.#records.get(id);
    if (!record || !this.#isCurrentRecord(record)) {
      return undefined;
    }
    refreshHealth(record);
    return {
      snapshot: projectSnapshot(record),
      messages: record.session
        ? [...record.session.messages]
        : [...(record.retainedMessages ?? [])],
    };
  }

  subscribe(id: string, listener: RuntimeSubscriptionListener): () => void {
    const record = this.#records.get(id);
    if (!record || !this.#isCurrentRecord(record)) {
      return () => {};
    }
    record.inspectListeners.add(listener);
    return () => {
      record.inspectListeners.delete(listener);
    };
  }

  snapshots(options: { includeNested?: boolean } = {}): RuntimeSnapshot[] {
    return [...this.#records.values()]
      .filter((record) => this.#isCurrentRecord(record))
      .filter((record) => options.includeNested || !isNestedOwner(record.owner))
      .map((record) => {
        refreshHealth(record);
        return projectSnapshot(record);
      });
  }

  async #runRecord<TSchemaValue extends TSchema | undefined>(
    record: RuntimeRecord,
    input: RunManagedAgentInput<TSchemaValue>,
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
    record.initialization = new Promise<void>((resolve) => {
      record.resolveInitialization = resolve;
    });
    try {
      const { model } = resolveModelRef(input.ctx, record.model);
      const registered = this.pi.getActiveTools?.();
      const nested = isNestedOwner(record.owner);
      const promptInput = resolveSystemPromptInput(input);
      const resources = promptInput
        ? await createPromptResourceLoader(record.cwd, promptInput)
        : undefined;
      const profileTools = publicAgentProfile(record.type)?.tools;
      const allowExplore = isExploreEligible(record.type) && !nested;
      const completionTools = record.completion
        ? [MANAGED_COMPLETION_TOOL_NAME]
        : [];
      const explicitTools =
        input.tools === undefined
          ? undefined
          : [
              ...new Set([
                ...normalizeActiveToolNames(input.tools, {
                  allowExplore,
                  registered,
                }),
                ...completionTools,
              ]),
            ];
      const profileAllowlist =
        profileTools === undefined
          ? undefined
          : [
              ...new Set([
                ...normalizeActiveToolNames(profileTools, {
                  allowExplore,
                  registered,
                }),
                ...completionTools,
              ]),
            ];
      const excludeTools = input.excludeTools?.filter(
        (name) => name !== MANAGED_COMPLETION_TOOL_NAME,
      );
      const createSessionOptions = {
        cwd: record.cwd,
        model,
        sessionManager: SessionManager.inMemory(record.cwd),
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
              tools:
                explicitTools ??
                normalizeActiveToolNames(
                  [...readOnlyToolNames, ...completionTools],
                  { allowExplore, registered },
                ),
              excludeTools: excludeTools ?? [
                "explore",
                ...publicToolNames,
                "edit",
                "write",
              ],
              ...(record.completion
                ? { customTools: [this.#managedCompletionTool(record)] }
                : {}),
            }
          : {
              ...(explicitTools === undefined
                ? profileAllowlist === undefined
                  ? {}
                  : { tools: [...profileAllowlist] }
                : { tools: explicitTools }),
              ...(excludeTools === undefined ? {} : { excludeTools }),
              customTools: this.#customToolsFor(record),
            }),
      };
      let session: AgentSession | undefined;
      try {
        const created = await this.#createSession(createSessionOptions);
        session = created.session;
        if (!this.#isCurrentRecord(record) || isTerminal(record.status)) {
          try {
            await session.abort();
          } catch {
            // The eventual child may never have started; disposal still proceeds.
          }
          await this.#disposeSession(session);
          return projectSnapshot(record);
        }
        record.session = session;
        record.unsubscribeSession = session.subscribe((event) => {
          if (!this.#isCurrentRecord(record) || isTerminal(record.status)) {
            return;
          }
          const candidate = isObject(event as unknown)
            ? (event as Record<string, unknown>)
            : undefined;
          const toolCall = candidate?.toolCall;
          const toolName =
            isObject(toolCall) && typeof toolCall.name === "string"
              ? toolCall.name
              : typeof candidate?.toolName === "string"
                ? candidate.toolName
                : undefined;
          if (
            typeof candidate?.type === "string" &&
            [
              "message_end",
              "turn_end",
              "compaction_start",
              "compaction_end",
              "agent_end",
            ].includes(candidate.type)
          ) {
            refreshContextHealth(record);
          }
          record.health = {
            ...record.health,
            ...(toolName === undefined ? {} : { activeTool: toolName }),
            lastActivity: now(),
          };
          record.updatedAt = now();
          this.#notifyInspectListeners(record);
        });
        await session!.bindExtensions({
          mode: "print",
          abortHandler: () => void session!.abort(),
          shutdownHandler: () => {},
        });
      } finally {
        record.resolveInitialization?.();
        record.resolveInitialization = undefined;
        record.initialization = undefined;
      }
      const initializedSession = session;
      if (!initializedSession) {
        throw new Error(
          "Subagent session initialization did not return a session.",
        );
      }
      if (!this.#isCurrentRecord(record) || isTerminal(record.status)) {
        return record.finalization ?? projectSnapshot(record);
      }
      record.extensionBinding = "bound";
      this.#inheritActiveTools(record, initializedSession, input.tools);
      if (!this.#isCurrentRecord(record) || isTerminal(record.status)) {
        return record.finalization ?? projectSnapshot(record);
      }
      const prompt = session.prompt(input.prompt, { source: "extension" });
      record.canSteer = true;
      await this.#flushSteering(record);
      await prompt;
      if (!this.#isCurrentRecord(record) || isTerminal(record.status)) {
        return record.finalization ?? projectSnapshot(record);
      }
      if (session.state.errorMessage) {
        this.fail(record.id, session.state.errorMessage);
        return record.finalization ?? projectSnapshot(record);
      }
      if (record.completion && !record.completion.accepted) {
        this.fail(
          record.id,
          "Managed agent settled without invoking required completion tool.",
        );
        return record.finalization ?? projectSnapshot(record);
      }
      const result = session.getLastAssistantText() ?? "";
      this.complete(record.id, result);
      return record.finalization ?? projectSnapshot(record);
    } catch (error) {
      record.resolveInitialization?.();
      record.resolveInitialization = undefined;
      record.initialization = undefined;
      if (!this.#isCurrentRecord(record) || isTerminal(record.status)) {
        return record.finalization ?? projectSnapshot(record);
      }
      this.fail(record.id, error);
      return record.finalization ?? projectSnapshot(record);
    } finally {
      input.signal?.removeEventListener("abort", abort);
      record.resolveInitialization?.();
      record.resolveInitialization = undefined;
      record.initialization = undefined;
      const session = record.session;
      if (session && !record.finalization) {
        await this.#disposeSession(session);
        record.session = undefined;
      }
    }
  }

  #customToolsFor(record: RuntimeRecord): ToolDefinition[] | undefined {
    const tools: ToolDefinition[] = [];
    if (isExploreEligible(record.type)) {
      tools.push(this.createExploreTool(projectSnapshot(record)));
    }
    if (record.completion) {
      tools.push(this.#managedCompletionTool(record));
    }
    return tools.length > 0 ? tools : undefined;
  }

  #managedCompletionTool(record: RuntimeRecord): ToolDefinition {
    const completion = record.completion;
    if (!completion) {
      throw new Error("Managed completion tool requested without a contract.");
    }
    return {
      name: MANAGED_COMPLETION_TOOL_NAME,
      label: completion.definition.label ?? "Complete managed task",
      description: completion.definition.description,
      promptSnippet:
        "Complete the managed task with its required structured result.",
      promptGuidelines: [
        "Call pi_managed_complete exactly once as your final action after all other required work.",
      ],
      parameters: completion.definition.schema,
      executionMode: "sequential",
      execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
        if (completion.accepted) {
          throw new Error("Managed completion has already been accepted.");
        }
        if (isTerminal(record.status)) {
          throw new Error(
            `Managed agent ${record.id} is already ${record.status}.`,
          );
        }
        const payload = copyTerminalValue(params);
        completion.accepted = true;
        completion.payload = payload;
        this.complete(record.id, payload);
        ctx.abort();
        return {
          content: [
            {
              type: "text",
              text: "Managed completion accepted.",
            },
          ],
          details: payload,
          terminate: true,
        };
      },
    };
  }

  async #disposeSession(session: AgentSession): Promise<void> {
    try {
      if (session.extensionRunner.hasHandlers("session_shutdown")) {
        await session.extensionRunner.emit({
          type: "session_shutdown",
          reason: "quit",
        });
      }
    } catch {
      // Child shutdown is best-effort; disposal must still complete.
    } finally {
      session.dispose();
    }
  }

  #inheritActiveTools(
    record: RuntimeRecord,
    session: AgentSession,
    explicitTools?: string[],
  ): void {
    const getActiveTools = this.pi.getActiveTools?.bind(this.pi);
    const registered = getActiveTools?.();
    const allowExplore =
      isExploreEligible(record.type) && !isNestedOwner(record.owner);
    const completionTools = record.completion
      ? [MANAGED_COMPLETION_TOOL_NAME]
      : [];
    if (explicitTools) {
      const activeTools = allowExplore
        ? [...explicitTools, "explore", ...completionTools]
        : [...explicitTools, ...completionTools];
      session.setActiveToolsByName(
        normalizeActiveToolNames([...new Set(activeTools)], {
          allowExplore,
          registered,
        }),
      );
      return;
    }
    const profileTools = publicAgentProfile(record.type)?.tools;
    if (profileTools !== undefined && !isNestedOwner(record.owner)) {
      session.setActiveToolsByName(
        normalizeActiveToolNames(
          [...new Set([...profileTools, ...completionTools])],
          { allowExplore, registered },
        ),
      );
      return;
    }
    if (!getActiveTools && !isNestedOwner(record.owner)) {
      return;
    }
    let activeTools = registered ?? [];
    if (isNestedOwner(record.owner)) {
      activeTools = readOnlyToolNames;
    } else if (allowExplore) {
      activeTools = [...activeTools, "explore"];
    }
    session.setActiveToolsByName(
      normalizeActiveToolNames(
        [...new Set([...activeTools, ...completionTools])],
        { allowExplore, registered },
      ),
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

  #markStopped(record: RuntimeRecord, error: string): void {
    const timestamp = now();
    if (record.completion?.accepted) {
      record.status = "completed";
      record.result = record.completion.payload;
    } else {
      record.status = "stopped";
      record.error = error;
    }
    record.completedAt = timestamp;
    record.updatedAt = timestamp;
  }

  #notifyInspectListeners(
    record: RuntimeRecord,
    options: { allowRetired?: boolean; clear?: boolean } = {},
  ): void {
    if (!options.allowRetired && !this.#isCurrentRecord(record)) {
      return;
    }
    const listeners = [...record.inspectListeners];
    if (options.clear) {
      record.inspectListeners.clear();
    }
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        // Inspector callbacks cannot interrupt terminal cleanup or waiters.
      }
    }
  }

  #finalize(
    record: RuntimeRecord,
    options: {
      allowRetiredNotification?: boolean;
      clearInspectListeners?: boolean;
    } = {},
  ): Promise<RuntimeSnapshot> {
    if (record.finalization) {
      return record.finalization;
    }
    record.canSteer = false;
    const activeSession = record.session;
    refreshHealth(record);
    record.retainedMessages = copyTerminalMessages(
      activeSession?.messages ?? [],
    );
    record.unsubscribeSession?.();
    record.unsubscribeSession = undefined;
    record.finalization = (async () => {
      try {
        await activeSession?.abort();
      } catch {
        // Cancellation is best-effort; cleanup still proceeds.
      }
      await record.initialization;
      const session = record.session;
      if (session) {
        await this.#disposeSession(session);
        if (record.session === session) {
          record.session = undefined;
        }
      }
      refreshHealth(record);
      const finalSnapshot = projectSnapshot(record);
      if (!options.clearInspectListeners) {
        this.#notifyInspectListeners(record, {
          allowRetired: options.allowRetiredNotification,
        });
      }
      const waiters = this.#waiters.get(record.id) ?? [];
      this.#waiters.delete(record.id);
      for (const waiter of waiters) {
        waiter.resolve(finalSnapshot);
      }
      return finalSnapshot;
    })();
    return record.finalization;
  }
}

function getRuntimeManager(): RuntimeManager {
  const globalScope = globalThis as Record<symbol, unknown>;
  const existing = globalScope[runtimeManagerKey];
  if (isRuntimeManager(existing)) {
    return existing;
  }
  const manager: RuntimeManager = {
    runtimes: new WeakMap(),
    runtimeList: new Set(),
  };
  if (isRuntimeInstance(existing)) {
    manager.runtimes.set(existing.pi, existing);
    manager.runtimeList.add(existing);
  }
  globalScope[runtimeManagerKey] = manager;
  return manager;
}

function isRuntimeManager(value: unknown): value is RuntimeManager {
  if (
    !isObject(value) ||
    !("runtimes" in value) ||
    !(value.runtimes instanceof WeakMap)
  ) {
    return false;
  }
  if (!("runtimeList" in value) || !(value.runtimeList instanceof Set)) {
    (value as RuntimeManager).runtimeList = new Set();
  }
  return true;
}

function isRuntimeInstance(value: unknown): value is SubagentRuntime {
  return isObject(value) && "pi" in value;
}

export function getSubagentRuntimes(): SubagentRuntime[] {
  return [...getRuntimeManager().runtimeList];
}

export function getSubagentRuntime(pi: ExtensionAPI): SubagentRuntime {
  const runtimeManager = getRuntimeManager();
  const existing = runtimes.get(pi);
  if (existing) {
    runtimeManager.runtimeList.add(existing);
    return existing;
  }
  const managed = runtimeManager.runtimes.get(pi);
  if (managed) {
    runtimes.set(pi, managed);
    runtimeManager.runtimeList.add(managed);
    return managed;
  }
  const runtime = new SubagentRuntime(pi);
  runtimes.set(pi, runtime);
  return runtime;
}
