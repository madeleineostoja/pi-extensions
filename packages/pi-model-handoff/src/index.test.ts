import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ExtensionAPI,
  ExtensionContext,
  SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";
import { compact } from "@earendil-works/pi-coding-agent";
import { prepareCompaction } from "./compaction";
import type { ModelSelectEvent } from "./decision";
import registerExtension from "./index";
import {
  clearPendingHandoff,
  getPendingHandoff,
  setPendingHandoff,
} from "./handoff";
import { HANDOFF_INSTRUCTIONS } from "./prompt";

vi.mock("@earendil-works/pi-coding-agent", async () => {
  const actual = await vi.importActual<
    typeof import("@earendil-works/pi-coding-agent")
  >("@earendil-works/pi-coding-agent");
  return {
    ...actual,
    compact: vi.fn(),
    getAgentDir: vi.fn().mockReturnValue("/fake/agent"),
    SettingsManager: {
      create: vi.fn().mockReturnValue({
        getCompactionSettings: vi.fn().mockReturnValue({
          enabled: true,
          reserveTokens: 16384,
          keepRecentTokens: 20000,
        }),
      }),
    } as never,
    estimateTokens: vi.fn().mockImplementation((msg: { content?: string }) => {
      return msg.content?.length ?? 0;
    }),
  };
});

vi.mock("./compaction", async () => {
  return {
    prepareCompaction: vi.fn(),
  };
});

const refreshCurrencyRateMock = vi.hoisted(() => vi.fn());
const convertCurrencyMock = vi.hoisted(() => vi.fn());

vi.mock("@pi-extensions/lib", () => {
  return {
    refreshCurrencyRate: refreshCurrencyRateMock,
    convertCurrency: convertCurrencyMock,
  };
});

beforeEach(() => {
  refreshCurrencyRateMock.mockReset().mockResolvedValue(undefined);
  convertCurrencyMock.mockReset();
});

function makeFakeExtensionAPI() {
  const handlers: Record<
    string,
    ((event: never, ctx: ExtensionContext) => Promise<unknown>)[]
  > = {};
  const commandRegistrations: string[] = [];
  const commandHandlers: Record<
    string,
    (args: string, ctx: never) => Promise<void>
  > = {};
  const shortcutRegistrations: string[] = [];

  const pi = {
    on(event: string, handler: (e: never, ctx: never) => Promise<unknown>) {
      if (!handlers[event]) {
        handlers[event] = [];
      }
      handlers[event].push(handler as never);
    },
    registerCommand: (
      name: string,
      options: { handler: (args: string, ctx: never) => Promise<void> },
    ) => {
      commandRegistrations.push(name);
      commandHandlers[name] = options.handler;
    },
    registerShortcut: (name: string) => {
      shortcutRegistrations.push(name);
    },
    registerTool: () => {},
    registerFlag: () => {},
    getFlag: () => undefined,
    registerMessageRenderer: () => {},
    sendMessage: () => {},
    sendUserMessage: () => {},
    appendEntry: () => {},
    setSessionName: () => {},
    getSessionName: () => undefined,
    setLabel: () => {},
    getActiveTools: () => [],
    getAllTools: () => [],
    setActiveTools: () => {},
    getCommands: () => [],
    setModel: () => Promise.resolve(false),
    getThinkingLevel: () => 0 as never,
    setThinkingLevel: () => {},
    exec: () =>
      Promise.resolve({ code: 0, stdout: "", stderr: "", killed: false }),
    registerProvider: () => {},
    unregisterProvider: () => {},
    events: {} as never,
  } as unknown as ExtensionAPI;

  return {
    pi,
    handlers,
    commandRegistrations,
    commandHandlers,
    shortcutRegistrations,
  };
}

function makeModel(provider: string, id: string, inputCost: number) {
  return {
    provider,
    id,
    name: `${provider}-${id}`,
    cost: {
      input: inputCost,
      output: inputCost * 2,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: 200000,
    maxTokens: 16384,
  } as never;
}

function makeModelSelectEvent(overrides: {
  source?: "set" | "cycle" | "restore";
  previousModel?: ReturnType<typeof makeModel>;
  model?: ReturnType<typeof makeModel>;
}): ModelSelectEvent {
  return {
    type: "model_select",
    model: (overrides.model ?? makeModel("openai", "gpt-4o", 5)) as never,
    previousModel: overrides.previousModel
      ? (overrides.previousModel as never)
      : undefined,
    source: overrides.source ?? "set",
  };
}

function makeAssistantEntry(provider: string, model: string, id: string) {
  return {
    id,
    type: "message",
    message: {
      role: "assistant",
      provider,
      model,
      content: [{ type: "text", text: "hi" }],
      usage: {
        input: 10,
        output: 10,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 20,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 1,
    },
    parentId: null,
    timestamp: "2024-01-01T00:00:00Z",
  } as never;
}

function makeFakeCtx(
  overrides: {
    mode?: "tui" | "rpc" | "json" | "print";
    selectResult?: string | undefined;
    modelRegistry?: ExtensionContext["modelRegistry"];
    model?: ExtensionContext["model"];
    branch?: ReturnType<ExtensionContext["sessionManager"]["getBranch"]>;
  } = {},
): ExtensionContext & {
  compactCalls: unknown[];
  notifyCalls: { message: string; type?: "info" | "warning" | "error" }[];
} {
  const compactCalls: unknown[] = [];
  const notifyCalls: {
    message: string;
    type?: "info" | "warning" | "error";
  }[] = [];

  return {
    mode: overrides.mode ?? "tui",
    signal: undefined,
    ui: {
      select: () => Promise.resolve(overrides.selectResult),
      input: () => Promise.resolve(undefined),
      setStatus: () => {},
      notify: (message: string, type?: "info" | "warning" | "error") => {
        notifyCalls.push({ message, type });
      },
      confirm: () => Promise.resolve(false),
      onTerminalInput: () => () => {},
      setWorkingMessage: () => {},
      setWorkingVisible: () => {},
      setWorkingIndicator: () => {},
      setHiddenThinkingLabel: () => {},
      setWidget: () => {},
      setFooter: () => {},
      setHeader: () => {},
      setTitle: () => {},
      custom: () => Promise.resolve(undefined as never),
      pasteToEditor: () => {},
      setEditorText: () => {},
      getEditorText: () => "",
      editor: () => Promise.resolve(undefined),
      addAutocompleteProvider: () => {},
      setEditorComponent: () => {},
      getEditorComponent: () => undefined,
      get theme() {
        return { fg: (_c: string, t: string) => t } as never;
      },
      getAllThemes: () => [],
      getTheme: () => undefined,
      setTheme: () => ({ success: true }),
      getToolsExpanded: () => false,
      setToolsExpanded: () => {},
    },
    cwd: "/",
    sessionManager: {
      getBranch: () => overrides.branch ?? [],
    } as never,
    modelRegistry:
      overrides.modelRegistry ??
      ({
        isUsingOAuth: () => false,
        getApiKeyAndHeaders: () => Promise.resolve({ ok: true, apiKey: "key" }),
        find: () => undefined,
      } as never),
    model: overrides.model ?? undefined,
    isIdle: () => true,
    abort: () => {},
    hasPendingMessages: () => false,
    shutdown: () => {},
    getContextUsage: () => undefined,
    compact: (options?: unknown) => {
      compactCalls.push(options);
    },
    getSystemPrompt: () => "",
    compactCalls,
    notifyCalls,
  } as unknown as ExtensionContext & {
    compactCalls: unknown[];
    notifyCalls: { message: string; type?: "info" | "warning" | "error" }[];
  };
}

function captureHandlers() {
  const {
    pi,
    handlers,
    commandRegistrations,
    commandHandlers,
    shortcutRegistrations,
  } = makeFakeExtensionAPI();
  registerExtension(pi);
  return {
    handlers,
    commandRegistrations,
    commandHandlers,
    shortcutRegistrations,
  };
}

function waitForDeferredNotifications() {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe("extension registration", () => {
  it("registers the handoff command", () => {
    const { commandRegistrations } = captureHandlers();
    expect(commandRegistrations).toContain("handoff");
  });

  it("does not register a shortcut", () => {
    const { shortcutRegistrations } = captureHandlers();
    expect(shortcutRegistrations).toHaveLength(0);
  });

  it("registers model_select, session_before_compact, and session_shutdown handlers", () => {
    const { handlers } = captureHandlers();
    expect(handlers["model_select"]).toHaveLength(1);
    expect(handlers["session_before_compact"]).toHaveLength(1);
    expect(handlers["session_shutdown"]).toHaveLength(1);
  });
});

describe("model_select handler", () => {
  beforeEach(() => {
    clearPendingHandoff();
    vi.clearAllMocks();
  });

  it("ignores restore source silently", async () => {
    const { handlers } = captureHandlers();
    const handler = handlers["model_select"][0];
    const ctx = makeFakeCtx();
    const event = makeModelSelectEvent({
      source: "restore",
      previousModel: makeModel("anthropic", "opus", 15),
      model: makeModel("openai", "gpt-4o", 5),
    });
    await handler(event as never, ctx);
    expect(ctx.compactCalls).toHaveLength(0);
    expect(ctx.notifyCalls).toHaveLength(0);
  });

  it("ignores missing previousModel silently", async () => {
    const { handlers } = captureHandlers();
    const handler = handlers["model_select"][0];
    const ctx = makeFakeCtx();
    const event = makeModelSelectEvent({ previousModel: undefined });
    await handler(event as never, ctx);
    expect(ctx.compactCalls).toHaveLength(0);
    expect(ctx.notifyCalls).toHaveLength(0);
  });

  it("ignores same model silently", async () => {
    const { handlers } = captureHandlers();
    const handler = handlers["model_select"][0];
    const ctx = makeFakeCtx();
    const model = makeModel("openai", "gpt-4o", 5);
    const event = makeModelSelectEvent({ previousModel: model, model });
    await handler(event as never, ctx);
    expect(ctx.compactCalls).toHaveLength(0);
    expect(ctx.notifyCalls).toHaveLength(0);
  });

  it("ignores when mode is not tui silently", async () => {
    const { handlers } = captureHandlers();
    const handler = handlers["model_select"][0];
    const ctx = makeFakeCtx({ mode: "rpc" });
    const event = makeModelSelectEvent({
      previousModel: makeModel("anthropic", "opus", 15),
      model: makeModel("openai", "gpt-4o", 5),
    });
    await handler(event as never, ctx);
    expect(ctx.compactCalls).toHaveLength(0);
    expect(ctx.notifyCalls).toHaveLength(0);
  });

  it("shows notification for billable target", async () => {
    convertCurrencyMock.mockReturnValue(2.55);
    const { handlers } = captureHandlers();
    const handler = handlers["model_select"][0];
    const ctx = makeFakeCtx();
    vi.mocked(prepareCompaction).mockReturnValue({
      firstKeptEntryId: "keep-1",
      messagesToSummarize: [{ role: "user", content: "a".repeat(800000) }],
      turnPrefixMessages: [],
      isSplitTurn: false,
      tokensBefore: 300000,
      naiveContextTokens: 300000,
      fileOps: {} as never,
      settings: {
        enabled: true,
        reserveTokens: 16384,
        keepRecentTokens: 20000,
      },
    } as never);
    const event = makeModelSelectEvent({
      previousModel: makeModel("anthropic", "opus", 15),
      model: makeModel("openai", "gpt-4o", 5),
    });
    await handler(event as never, ctx);
    expect(ctx.compactCalls).toHaveLength(0);
    await waitForDeferredNotifications();
    expect(ctx.notifyCalls).toContainEqual({
      message:
        "Switched to openai-gpt-4o · 300k context (~$2.55) · /handoff (~24k)",
      type: "info",
    });
  });

  it("shows notification omitting cost for OAuth target", async () => {
    const { handlers } = captureHandlers();
    const handler = handlers["model_select"][0];
    const ctx = makeFakeCtx({
      modelRegistry: {
        isUsingOAuth: () => true,
        getApiKeyAndHeaders: () => Promise.resolve({ ok: true, apiKey: "key" }),
        find: () => undefined,
      } as never,
    });
    vi.mocked(prepareCompaction).mockReturnValue({
      firstKeptEntryId: "keep-1",
      messagesToSummarize: [{ role: "user", content: "a".repeat(800000) }],
      turnPrefixMessages: [],
      isSplitTurn: false,
      tokensBefore: 300000,
      naiveContextTokens: 300000,
      fileOps: {} as never,
      settings: {
        enabled: true,
        reserveTokens: 16384,
        keepRecentTokens: 20000,
      },
    } as never);
    const event = makeModelSelectEvent({
      previousModel: makeModel("anthropic", "opus", 15),
      model: makeModel("openai", "gpt-4o", 5),
    });
    await handler(event as never, ctx);
    expect(ctx.compactCalls).toHaveLength(0);
    await waitForDeferredNotifications();
    expect(ctx.notifyCalls).toContainEqual({
      message: "Switched to openai-gpt-4o · 300k context · /handoff (~24k)",
      type: "info",
    });
  });

  it("is silent when preparation is undefined", async () => {
    const { handlers } = captureHandlers();
    const handler = handlers["model_select"][0];
    const ctx = makeFakeCtx();
    vi.mocked(prepareCompaction).mockReturnValue(undefined);
    const event = makeModelSelectEvent({
      previousModel: makeModel("anthropic", "opus", 15),
      model: makeModel("openai", "gpt-4o", 5),
    });
    await handler(event as never, ctx);
    expect(ctx.compactCalls).toHaveLength(0);
    expect(ctx.notifyCalls).toHaveLength(0);
  });

  it("is silent when there are no messages to summarize", async () => {
    const { handlers } = captureHandlers();
    const handler = handlers["model_select"][0];
    const ctx = makeFakeCtx();
    vi.mocked(prepareCompaction).mockReturnValue({
      firstKeptEntryId: "keep-1",
      messagesToSummarize: [],
      turnPrefixMessages: [],
      isSplitTurn: false,
      tokensBefore: 1000,
      naiveContextTokens: 1000,
      fileOps: {} as never,
      settings: {
        enabled: true,
        reserveTokens: 16384,
        keepRecentTokens: 20000,
      },
    } as never);
    const event = makeModelSelectEvent({
      previousModel: makeModel("anthropic", "opus", 15),
      model: makeModel("openai", "gpt-4o", 5),
    });
    await handler(event as never, ctx);
    expect(ctx.compactCalls).toHaveLength(0);
    expect(ctx.notifyCalls).toHaveLength(0);
  });

  it("never calls ctx.ui.select", async () => {
    const { handlers } = captureHandlers();
    const handler = handlers["model_select"][0];
    let selectCalled = false;
    const ctx = makeFakeCtx();
    const originalSelect = ctx.ui.select;
    ctx.ui.select = async (...args: Parameters<typeof ctx.ui.select>) => {
      selectCalled = true;
      return originalSelect(...args);
    };
    vi.mocked(prepareCompaction).mockReturnValue({
      firstKeptEntryId: "keep-1",
      messagesToSummarize: [{ role: "user", content: "a".repeat(800000) }],
      turnPrefixMessages: [],
      isSplitTurn: false,
      tokensBefore: 300000,
      naiveContextTokens: 300000,
      fileOps: {} as never,
      settings: {
        enabled: true,
        reserveTokens: 16384,
        keepRecentTokens: 20000,
      },
    } as never);
    const event = makeModelSelectEvent({
      previousModel: makeModel("anthropic", "opus", 15),
      model: makeModel("openai", "gpt-4o", 5),
    });
    await handler(event as never, ctx);
    expect(selectCalled).toBe(false);
  });
});

describe("/handoff command", () => {
  beforeEach(() => {
    clearPendingHandoff();
    vi.clearAllMocks();
  });

  it("compacts using previous model when last assistant differs from current", async () => {
    const { commandHandlers } = captureHandlers();
    const previousModel = makeModel("anthropic", "claude-3-opus", 15);
    const ctx = makeFakeCtx({
      model: makeModel("openai", "gpt-4o", 5),
      branch: [makeAssistantEntry("anthropic", "claude-3-opus", "e1")],
      modelRegistry: {
        isUsingOAuth: () => false,
        getApiKeyAndHeaders: () => Promise.resolve({ ok: true, apiKey: "key" }),
        find: (_provider: string, _id: string) => previousModel,
      } as never,
    });
    await commandHandlers["handoff"]("", ctx as never);
    expect(ctx.compactCalls).toHaveLength(1);
    expect(getPendingHandoff()?.previousModel).toBe(previousModel);
    const compactOptions = ctx.compactCalls[0] as {
      customInstructions?: string;
      onComplete?: () => void;
      onError?: () => void;
    };
    expect(compactOptions.customInstructions).toBe(HANDOFF_INSTRUCTIONS);
    expect(typeof compactOptions.onComplete).toBe("function");
    expect(typeof compactOptions.onError).toBe("function");
  });

  it("errors when last assistant is the current model", async () => {
    const { commandHandlers } = captureHandlers();
    const currentModel = makeModel("openai", "gpt-4o", 5);
    const ctx = makeFakeCtx({
      model: currentModel,
      branch: [makeAssistantEntry("openai", "gpt-4o", "e1")],
      modelRegistry: {
        isUsingOAuth: () => false,
        getApiKeyAndHeaders: () => Promise.resolve({ ok: true, apiKey: "key" }),
        find: () => currentModel,
      } as never,
    });
    await commandHandlers["handoff"]("", ctx as never);
    expect(ctx.compactCalls).toHaveLength(0);
    expect(ctx.notifyCalls).toContainEqual({
      message: "no prior model to hand off from",
      type: "error",
    });
    expect(getPendingHandoff()).toBeUndefined();
  });

  it("errors when there is no prior assistant message", async () => {
    const { commandHandlers } = captureHandlers();
    const ctx = makeFakeCtx({
      model: makeModel("openai", "gpt-4o", 5),
      branch: [],
    });
    await commandHandlers["handoff"]("", ctx as never);
    expect(ctx.compactCalls).toHaveLength(0);
    expect(ctx.notifyCalls).toContainEqual({
      message: "no prior model to hand off from",
      type: "error",
    });
    expect(getPendingHandoff()).toBeUndefined();
  });

  it("errors when previous model is not found in registry", async () => {
    const { commandHandlers } = captureHandlers();
    const ctx = makeFakeCtx({
      model: makeModel("openai", "gpt-4o", 5),
      branch: [makeAssistantEntry("anthropic", "claude-3-opus", "e1")],
      modelRegistry: {
        isUsingOAuth: () => false,
        getApiKeyAndHeaders: () => Promise.resolve({ ok: true, apiKey: "key" }),
        find: () => undefined,
      } as never,
    });
    await commandHandlers["handoff"]("", ctx as never);
    expect(ctx.compactCalls).toHaveLength(0);
    expect(ctx.notifyCalls).toContainEqual({
      message: "previous model unavailable for handoff",
      type: "error",
    });
    expect(getPendingHandoff()).toBeUndefined();
  });

  it("leaves current model unchanged on success", async () => {
    const { commandHandlers } = captureHandlers();
    const currentModel = makeModel("openai", "gpt-4o", 5);
    const previousModel = makeModel("anthropic", "claude-3-opus", 15);
    const ctx = makeFakeCtx({
      model: currentModel,
      branch: [makeAssistantEntry("anthropic", "claude-3-opus", "e1")],
      modelRegistry: {
        isUsingOAuth: () => false,
        getApiKeyAndHeaders: () => Promise.resolve({ ok: true, apiKey: "key" }),
        find: () => previousModel,
      } as never,
    });
    await commandHandlers["handoff"]("", ctx as never);
    expect(ctx.model).toBe(currentModel);
  });
});

describe("session_before_compact handler", () => {
  beforeEach(() => {
    clearPendingHandoff();
    vi.clearAllMocks();
  });

  it("returns undefined when no pending handoff exists", async () => {
    const { handlers } = captureHandlers();
    const handler = handlers["session_before_compact"][0];
    const ctx = makeFakeCtx();
    const event = {
      type: "session_before_compact",
      preparation: {
        firstKeptEntryId: "keep-1",
        messagesToSummarize: [],
        turnPrefixMessages: [],
        isSplitTurn: false,
        tokensBefore: 1000,
        naiveContextTokens: 1000,
        fileOps: {} as never,
        settings: {
          enabled: true,
          reserveTokens: 16384,
          keepRecentTokens: 20000,
        },
      },
      branchEntries: [],
      signal: new AbortController().signal,
    } as unknown as SessionBeforeCompactEvent;
    const result = await handler(event as never, ctx);
    expect(result).toBeUndefined();
  });

  it("returns custom compaction using the pending previous model", async () => {
    const { handlers } = captureHandlers();
    const handler = handlers["session_before_compact"][0];
    const previousModel = makeModel("anthropic", "opus", 15);
    setPendingHandoff({ previousModel: previousModel as never });
    const ctx = makeFakeCtx();
    const event = {
      type: "session_before_compact",
      preparation: {
        firstKeptEntryId: "keep-1",
        messagesToSummarize: [],
        turnPrefixMessages: [],
        isSplitTurn: false,
        tokensBefore: 1000,
        naiveContextTokens: 1000,
        fileOps: {} as never,
        settings: {
          enabled: true,
          reserveTokens: 16384,
          keepRecentTokens: 20000,
        },
      },
      branchEntries: [],
      signal: new AbortController().signal,
    } as unknown as SessionBeforeCompactEvent;
    vi.mocked(compact).mockResolvedValue({
      summary: "summary",
      firstKeptEntryId: "keep-1",
      tokensBefore: 1000,
      naiveContextTokens: 1000,
    } as never);
    const result = await handler(event as never, ctx);
    expect(compact).toHaveBeenCalledWith(
      event.preparation,
      previousModel,
      "key",
      undefined,
      HANDOFF_INSTRUCTIONS,
      event.signal,
    );
    expect(result).toEqual({
      compaction: {
        summary: "summary",
        firstKeptEntryId: "keep-1",
        tokensBefore: 1000,
        naiveContextTokens: 1000,
      },
    });
  });

  it("cancels when previous model has no usable auth", async () => {
    const { handlers } = captureHandlers();
    const handler = handlers["session_before_compact"][0];
    const previousModel = makeModel("anthropic", "opus", 15);
    setPendingHandoff({ previousModel: previousModel as never });
    const ctx = makeFakeCtx({
      modelRegistry: {
        isUsingOAuth: () => false,
        getApiKeyAndHeaders: () =>
          Promise.resolve({ ok: false, error: "No API key" }),
      } as never,
    });
    const event = {
      type: "session_before_compact",
      preparation: {
        firstKeptEntryId: "keep-1",
        messagesToSummarize: [],
        turnPrefixMessages: [],
        isSplitTurn: false,
        tokensBefore: 1000,
        naiveContextTokens: 1000,
        fileOps: {} as never,
        settings: {
          enabled: true,
          reserveTokens: 16384,
          keepRecentTokens: 20000,
        },
      },
      branchEntries: [],
      signal: new AbortController().signal,
    } as unknown as SessionBeforeCompactEvent;
    const result = await handler(event as never, ctx);
    expect(result).toEqual({ cancel: true });
    expect(ctx.notifyCalls).toContainEqual({
      message: "Handoff cancelled: No API key",
      type: "error",
    });
    expect(getPendingHandoff()).toBeUndefined();
  });

  it("clears pending state when consumed", async () => {
    const { handlers } = captureHandlers();
    const handler = handlers["session_before_compact"][0];
    const previousModel = makeModel("anthropic", "opus", 15);
    setPendingHandoff({ previousModel: previousModel as never });
    const ctx = makeFakeCtx();
    const event = {
      type: "session_before_compact",
      preparation: {
        firstKeptEntryId: "keep-1",
        messagesToSummarize: [],
        turnPrefixMessages: [],
        isSplitTurn: false,
        tokensBefore: 1000,
        naiveContextTokens: 1000,
        fileOps: {} as never,
        settings: {
          enabled: true,
          reserveTokens: 16384,
          keepRecentTokens: 20000,
        },
      },
      branchEntries: [],
      signal: new AbortController().signal,
    } as unknown as SessionBeforeCompactEvent;
    vi.mocked(compact).mockResolvedValue({
      summary: "summary",
      firstKeptEntryId: "keep-1",
      tokensBefore: 1000,
      naiveContextTokens: 1000,
    } as never);
    expect(getPendingHandoff()).toBeDefined();
    await handler(event as never, ctx);
    expect(getPendingHandoff()).toBeUndefined();
  });
});

describe("state clearing", () => {
  beforeEach(() => {
    clearPendingHandoff();
  });

  it("onComplete callback clears pending handoff", async () => {
    setPendingHandoff({
      previousModel: makeModel("anthropic", "opus", 15) as never,
    });
    const { commandHandlers } = captureHandlers();
    const previousModel = makeModel("anthropic", "claude-3-opus", 15);
    const ctx = makeFakeCtx({
      model: makeModel("openai", "gpt-4o", 5),
      branch: [makeAssistantEntry("anthropic", "claude-3-opus", "e1")],
      modelRegistry: {
        isUsingOAuth: () => false,
        getApiKeyAndHeaders: () => Promise.resolve({ ok: true, apiKey: "key" }),
        find: () => previousModel,
      } as never,
    });
    await commandHandlers["handoff"]("", ctx as never);
    const compactOptions = ctx.compactCalls[0] as { onComplete: () => void };
    expect(getPendingHandoff()).toBeDefined();
    compactOptions.onComplete();
    expect(getPendingHandoff()).toBeUndefined();
  });

  it("onError callback clears pending handoff", async () => {
    setPendingHandoff({
      previousModel: makeModel("anthropic", "opus", 15) as never,
    });
    const { commandHandlers } = captureHandlers();
    const previousModel = makeModel("anthropic", "claude-3-opus", 15);
    const ctx = makeFakeCtx({
      model: makeModel("openai", "gpt-4o", 5),
      branch: [makeAssistantEntry("anthropic", "claude-3-opus", "e1")],
      modelRegistry: {
        isUsingOAuth: () => false,
        getApiKeyAndHeaders: () => Promise.resolve({ ok: true, apiKey: "key" }),
        find: () => previousModel,
      } as never,
    });
    await commandHandlers["handoff"]("", ctx as never);
    const compactOptions = ctx.compactCalls[0] as { onError: () => void };
    expect(getPendingHandoff()).toBeDefined();
    compactOptions.onError();
    expect(getPendingHandoff()).toBeUndefined();
  });

  it("session_shutdown clears pending handoff", async () => {
    setPendingHandoff({
      previousModel: makeModel("anthropic", "opus", 15) as never,
    });
    const { handlers } = captureHandlers();
    const handler = handlers["session_shutdown"][0];
    expect(getPendingHandoff()).toBeDefined();
    await handler(
      { type: "session_shutdown", reason: "quit" } as never,
      makeFakeCtx(),
    );
    expect(getPendingHandoff()).toBeUndefined();
  });
});
