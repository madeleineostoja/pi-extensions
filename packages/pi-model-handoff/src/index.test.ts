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
  };
});

vi.mock("./compaction", async () => {
  return {
    prepareCompaction: vi.fn(),
  };
});

const refreshCurrencyRateMock = vi.hoisted(() => vi.fn());

vi.mock("@pi-extensions/lib", () => {
  return {
    refreshCurrencyRate: refreshCurrencyRateMock,
    convertCurrency: vi.fn(),
  };
});

function makeFakeExtensionAPI() {
  const handlers: Record<
    string,
    ((event: never, ctx: ExtensionContext) => Promise<unknown>)[]
  > = {};
  const commandRegistrations: string[] = [];
  const shortcutRegistrations: string[] = [];

  const pi = {
    on(event: string, handler: (e: never, ctx: never) => Promise<unknown>) {
      if (!handlers[event]) {
        handlers[event] = [];
      }
      handlers[event].push(handler as never);
    },
    registerCommand: (name: string) => {
      commandRegistrations.push(name);
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

  return { pi, handlers, commandRegistrations, shortcutRegistrations };
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

function makeFakeCtx(
  overrides: {
    hasUI?: boolean;
    selectResult?: string | undefined;
    modelRegistry?: ExtensionContext["modelRegistry"];
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
    hasUI: overrides.hasUI ?? true,
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
      getBranch: () => [],
    } as never,
    modelRegistry:
      overrides.modelRegistry ??
      ({
        isUsingOAuth: () => false,
        getApiKeyAndHeaders: () => Promise.resolve({ ok: true, apiKey: "key" }),
      } as never),
    model: undefined,
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
  const { pi, handlers, commandRegistrations, shortcutRegistrations } =
    makeFakeExtensionAPI();
  registerExtension(pi);
  return { handlers, commandRegistrations, shortcutRegistrations };
}

describe("extension registration", () => {
  it("does not register a command or shortcut", () => {
    const { commandRegistrations, shortcutRegistrations } = captureHandlers();
    expect(commandRegistrations).toHaveLength(0);
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

  it("ignores restore source", async () => {
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
  });

  it("ignores missing previousModel", async () => {
    const { handlers } = captureHandlers();
    const handler = handlers["model_select"][0];
    const ctx = makeFakeCtx();
    const event = makeModelSelectEvent({ previousModel: undefined });
    await handler(event as never, ctx);
    expect(ctx.compactCalls).toHaveLength(0);
  });

  it("ignores same model", async () => {
    const { handlers } = captureHandlers();
    const handler = handlers["model_select"][0];
    const ctx = makeFakeCtx();
    const model = makeModel("openai", "gpt-4o", 5);
    const event = makeModelSelectEvent({ previousModel: model, model });
    await handler(event as never, ctx);
    expect(ctx.compactCalls).toHaveLength(0);
  });

  it("ignores when hasUI is false", async () => {
    const { handlers } = captureHandlers();
    const handler = handlers["model_select"][0];
    const ctx = makeFakeCtx({ hasUI: false });
    const event = makeModelSelectEvent({
      previousModel: makeModel("anthropic", "opus", 15),
      model: makeModel("openai", "gpt-4o", 5),
    });
    await handler(event as never, ctx);
    expect(ctx.compactCalls).toHaveLength(0);
  });

  it("does not call ctx.compact before user accepts (dry run)", async () => {
    const { handlers } = captureHandlers();
    const handler = handlers["model_select"][0];
    const ctx = makeFakeCtx({ selectResult: undefined });
    vi.mocked(prepareCompaction).mockReturnValue({
      firstKeptEntryId: "keep-1",
      messagesToSummarize: [{ role: "user", content: "a".repeat(8000) }],
      turnPrefixMessages: [],
      isSplitTurn: false,
      tokensBefore: 1000,
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
    expect(prepareCompaction).toHaveBeenCalled();
    expect(ctx.compactCalls).toHaveLength(0);
  });

  it("skips prompting when there are no messages to summarize", async () => {
    const { handlers } = captureHandlers();
    const handler = handlers["model_select"][0];
    const ctx = makeFakeCtx();
    vi.mocked(prepareCompaction).mockReturnValue({
      firstKeptEntryId: "keep-1",
      messagesToSummarize: [],
      turnPrefixMessages: [],
      isSplitTurn: false,
      tokensBefore: 1000,
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
  });

  it("calls ctx.ui.select immediately during the handler", async () => {
    const { handlers } = captureHandlers();
    const handler = handlers["model_select"][0];
    let selectCalled = false;
    const ctx = makeFakeCtx({ selectResult: undefined });
    const originalSelect = ctx.ui.select;
    ctx.ui.select = async (...args: Parameters<typeof ctx.ui.select>) => {
      selectCalled = true;
      return originalSelect(...args);
    };
    vi.mocked(prepareCompaction).mockReturnValue({
      firstKeptEntryId: "keep-1",
      messagesToSummarize: [{ role: "user", content: "a".repeat(8000) }],
      turnPrefixMessages: [],
      isSplitTurn: false,
      tokensBefore: 1000,
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
    expect(selectCalled).toBe(true);
  });

  it("awaits refreshCurrencyRate before formatting the prompt", async () => {
    let refreshed = false;
    refreshCurrencyRateMock.mockImplementation(async () => {
      refreshed = true;
    });
    const { handlers } = captureHandlers();
    const handler = handlers["model_select"][0];
    let selectCalled = false;
    const ctx = makeFakeCtx({ selectResult: undefined });
    const originalSelect = ctx.ui.select;
    ctx.ui.select = async (...args: Parameters<typeof ctx.ui.select>) => {
      selectCalled = true;
      return originalSelect(...args);
    };
    vi.mocked(prepareCompaction).mockReturnValue({
      firstKeptEntryId: "keep-1",
      messagesToSummarize: [{ role: "user", content: "a".repeat(8000) }],
      turnPrefixMessages: [],
      isSplitTurn: false,
      tokensBefore: 1000,
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
    expect(refreshed).toBe(true);
    expect(selectCalled).toBe(true);
  });

  it("dismissal/undefined behaves like continue full context", async () => {
    const { handlers } = captureHandlers();
    const handler = handlers["model_select"][0];
    const ctx = makeFakeCtx({ selectResult: undefined });
    vi.mocked(prepareCompaction).mockReturnValue({
      firstKeptEntryId: "keep-1",
      messagesToSummarize: [{ role: "user", content: "a".repeat(8000) }],
      turnPrefixMessages: [],
      isSplitTurn: false,
      tokensBefore: 1000,
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
    expect(getPendingHandoff()).toBeUndefined();
  });

  it("choosing continue full context does not call ctx.compact or set pending", async () => {
    const { handlers } = captureHandlers();
    const handler = handlers["model_select"][0];
    const ctx = makeFakeCtx({ selectResult: "Continue full context" });
    vi.mocked(prepareCompaction).mockReturnValue({
      firstKeptEntryId: "keep-1",
      messagesToSummarize: [{ role: "user", content: "a".repeat(8000) }],
      turnPrefixMessages: [],
      isSplitTurn: false,
      tokensBefore: 1000,
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
    expect(getPendingHandoff()).toBeUndefined();
  });

  it("choosing create handoff sets pending and calls ctx.compact with callbacks", async () => {
    const { handlers } = captureHandlers();
    const handler = handlers["model_select"][0];
    const ctx = makeFakeCtx({ selectResult: "Create handoff" });
    vi.mocked(prepareCompaction).mockReturnValue({
      firstKeptEntryId: "keep-1",
      messagesToSummarize: [{ role: "user", content: "a".repeat(8000) }],
      turnPrefixMessages: [],
      isSplitTurn: false,
      tokensBefore: 1000,
      fileOps: {} as never,
      settings: {
        enabled: true,
        reserveTokens: 16384,
        keepRecentTokens: 20000,
      },
    } as never);
    const previousModel = makeModel("anthropic", "opus", 15);
    const event = makeModelSelectEvent({
      previousModel,
      model: makeModel("openai", "gpt-4o", 5),
    });
    await handler(event as never, ctx);
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

  it("later eligible model switch replaces prior pending state", async () => {
    const { handlers } = captureHandlers();
    const handler = handlers["model_select"][0];
    const firstModel = makeModel("anthropic", "opus", 15);
    const laterModel = makeModel("openai", "gpt-4o", 5);
    const ctx1 = makeFakeCtx({ selectResult: "Create handoff" });
    vi.mocked(prepareCompaction).mockReturnValue({
      firstKeptEntryId: "keep-1",
      messagesToSummarize: [{ role: "user", content: "a".repeat(8000) }],
      turnPrefixMessages: [],
      isSplitTurn: false,
      tokensBefore: 1000,
      fileOps: {} as never,
      settings: {
        enabled: true,
        reserveTokens: 16384,
        keepRecentTokens: 20000,
      },
    } as never);
    await handler(
      makeModelSelectEvent({
        previousModel: firstModel,
        model: makeModel("openai", "gpt-4o-mini", 1),
      }) as never,
      ctx1,
    );
    expect(getPendingHandoff()?.previousModel).toBe(firstModel);

    const ctx2 = makeFakeCtx({ selectResult: "Create handoff" });
    await handler(
      makeModelSelectEvent({
        previousModel: laterModel,
        model: makeModel("openai", "gpt-4o-mini", 1),
      }) as never,
      ctx2,
    );
    expect(getPendingHandoff()?.previousModel).toBe(laterModel);
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
    const { handlers } = captureHandlers();
    const modelSelectHandler = handlers["model_select"][0];
    const ctx = makeFakeCtx({ selectResult: "Create handoff" });
    vi.mocked(prepareCompaction).mockReturnValue({
      firstKeptEntryId: "keep-1",
      messagesToSummarize: [{ role: "user", content: "a".repeat(8000) }],
      turnPrefixMessages: [],
      isSplitTurn: false,
      tokensBefore: 1000,
      fileOps: {} as never,
      settings: {
        enabled: true,
        reserveTokens: 16384,
        keepRecentTokens: 20000,
      },
    } as never);
    await modelSelectHandler(
      makeModelSelectEvent({
        previousModel: makeModel("anthropic", "opus", 15),
        model: makeModel("openai", "gpt-4o", 5),
      }) as never,
      ctx,
    );
    const compactOptions = ctx.compactCalls[0] as { onComplete: () => void };
    expect(getPendingHandoff()).toBeDefined();
    compactOptions.onComplete();
    expect(getPendingHandoff()).toBeUndefined();
  });

  it("onError callback clears pending handoff", async () => {
    setPendingHandoff({
      previousModel: makeModel("anthropic", "opus", 15) as never,
    });
    const { handlers } = captureHandlers();
    const modelSelectHandler = handlers["model_select"][0];
    const ctx = makeFakeCtx({ selectResult: "Create handoff" });
    vi.mocked(prepareCompaction).mockReturnValue({
      firstKeptEntryId: "keep-1",
      messagesToSummarize: [{ role: "user", content: "a".repeat(8000) }],
      turnPrefixMessages: [],
      isSplitTurn: false,
      tokensBefore: 1000,
      fileOps: {} as never,
      settings: {
        enabled: true,
        reserveTokens: 16384,
        keepRecentTokens: 20000,
      },
    } as never);
    await modelSelectHandler(
      makeModelSelectEvent({
        previousModel: makeModel("anthropic", "opus", 15),
        model: makeModel("openai", "gpt-4o", 5),
      }) as never,
      ctx,
    );
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
