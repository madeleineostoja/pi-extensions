import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import registerExtension from "./index.js";
import { clearHistory, getHistory, getSessionKey } from "./state.js";

const completeTextMock = vi.hoisted(() => vi.fn());
const convertToLlmMock = vi.hoisted(() => vi.fn());

vi.mock("@pi-extensions/lib", async () => {
  const actual =
    await vi.importActual<typeof import("@pi-extensions/lib")>(
      "@pi-extensions/lib",
    );
  return {
    ...actual,
    completeText: completeTextMock,
  };
});

vi.mock("@earendil-works/pi-coding-agent", async () => {
  const actual = await vi.importActual<
    typeof import("@earendil-works/pi-coding-agent")
  >("@earendil-works/pi-coding-agent");
  return {
    ...actual,
    convertToLlm: convertToLlmMock,
  };
});

function makeFakePi() {
  const commands: Record<
    string,
    (args: string, ctx: ExtensionCommandContext) => Promise<void>
  > = {};
  const sendMessage = vi.fn();
  const sendUserMessage = vi.fn();
  const appendEntry = vi.fn();

  const pi = {
    registerCommand: (
      name: string,
      options: {
        description: string;
        handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
      },
    ) => {
      commands[name] = options.handler;
    },
    sendMessage,
    sendUserMessage,
    appendEntry,
  } as unknown as ExtensionAPI;

  registerExtension(pi);
  return { commands, sendMessage, sendUserMessage, appendEntry };
}

function makeTheme(): Theme {
  return {
    fg: (color: string, text: string) => `[${color}]${text}[/${color}]`,
    bg: (_color: string, text: string) => text,
    bold: (text: string) => `**${text}**`,
    italic: (text: string) => `_${text}_`,
    underline: (text: string) => `__${text}__`,
    inverse: (text: string) => text,
    strikethrough: (text: string) => text,
    getFgAnsi: (_color: string) => "",
    getBgAnsi: (_color: string) => "",
    getColorMode: () => "truecolor",
    getThinkingBorderColor: () => (text: string) => text,
    getBashModeBorderColor: () => (text: string) => text,
  } as unknown as Theme;
}

function makeFakeCustom() {
  const requestRender = vi.fn();
  const tui = {
    terminal: { rows: 24 },
    requestRender,
  } as unknown as TUI;

  const theme = makeTheme();

  let resolveCustom: ((value: unknown) => void) | undefined;
  let capturedDone: ((result?: unknown) => void) | undefined;
  let capturedComponent: Component | undefined;

  const custom = vi.fn(
    (
      factory: (
        tui: TUI,
        theme: Theme,
        kb: unknown,
        done: (result: unknown) => void,
      ) => Component,
      _options?: unknown,
    ) => {
      capturedDone = (result?: unknown) => {
        resolveCustom?.(result);
      };
      capturedComponent = factory(tui, theme, {}, capturedDone);
      return new Promise((resolve) => {
        resolveCustom = resolve;
      });
    },
  );

  return {
    custom,
    tui,
    theme,
    requestRender,
    get component() {
      return capturedComponent;
    },
    done(result?: unknown) {
      capturedDone?.(result);
    },
  };
}

type FakeCtxOptions = {
  hasUI?: boolean;
  model?: { provider: string; id: string } | null;
  authResult?: {
    ok: boolean;
    apiKey?: string;
    headers?: Record<string, string>;
    error?: string;
  };
  branchEntries?: { type: string; message: unknown }[];
  sessionFile?: string;
  sessionId?: string;
  signal?: AbortSignal;
  custom?: ReturnType<typeof makeFakeCustom>["custom"];
};

function makeCtx(options: FakeCtxOptions = {}) {
  const notifications: {
    message: string;
    type?: "info" | "warning" | "error";
  }[] = [];

  const ctx = {
    hasUI: options.hasUI ?? true,
    mode: (options.hasUI ?? true) ? "tui" : "json",
    model:
      "model" in options
        ? options.model
        : { provider: "openrouter", id: "test-model" },
    signal: options.signal ?? undefined,
    ui: {
      notify: (message: string, type?: "info" | "warning" | "error") => {
        notifications.push({ message, type });
      },
      custom: options.custom ?? vi.fn(),
    },
    modelRegistry: {
      getApiKeyAndHeaders: vi.fn(
        async () =>
          options.authResult ?? { ok: true, apiKey: "test-key", headers: {} },
      ),
    },
    sessionManager: {
      getBranch: () => options.branchEntries ?? [],
      getSessionFile: () => options.sessionFile ?? "/tmp/session.json",
      getSessionId: () => options.sessionId ?? "session-1",
    },
  } as unknown as ExtensionCommandContext;

  return { ctx, notifications };
}

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  vi.resetAllMocks();
  const key = getSessionKey({
    getSessionFile: () => "/tmp/session.json",
    getSessionId: () => "session-1",
  });
  clearHistory(key);
});

afterEach(() => {
  vi.resetAllMocks();
});

describe("command registration", () => {
  it("registers the btw command", () => {
    const { commands } = makeFakePi();
    expect(commands["btw"]).toBeDefined();
  });
});

describe("empty input", () => {
  it("notifies usage guidance and does not call the model", async () => {
    const { commands, sendMessage, sendUserMessage, appendEntry } =
      makeFakePi();
    const { ctx, notifications } = makeCtx();

    await commands["btw"]("   ", ctx);

    expect(notifications).toEqual([
      { message: "usage: /btw <question>", type: "warning" },
    ]);
    expect(completeTextMock).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(sendUserMessage).not.toHaveBeenCalled();
    expect(appendEntry).not.toHaveBeenCalled();
  });
});

describe("non-interactive context", () => {
  it("rejects before model work starts", async () => {
    const { commands, sendMessage, sendUserMessage, appendEntry } =
      makeFakePi();
    const { ctx, notifications } = makeCtx({ hasUI: false });

    await commands["btw"]("what is this", ctx);

    expect(notifications).toEqual([
      { message: "/btw requires an interactive session", type: "warning" },
    ]);
    expect(completeTextMock).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(sendUserMessage).not.toHaveBeenCalled();
    expect(appendEntry).not.toHaveBeenCalled();
  });
});

describe("missing model", () => {
  it("surfaces an error and does not open an overlay", async () => {
    const { commands, sendMessage, sendUserMessage, appendEntry } =
      makeFakePi();
    const { ctx, notifications } = makeCtx({ model: null });

    await commands["btw"]("what is this", ctx);

    expect(notifications).toEqual([
      { message: "No active model. Set a model first.", type: "warning" },
    ]);
    expect(completeTextMock).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(sendUserMessage).not.toHaveBeenCalled();
    expect(appendEntry).not.toHaveBeenCalled();
  });
});

describe("credential failures", () => {
  it("surfaces auth error when getApiKeyAndHeaders fails", async () => {
    const { commands } = makeFakePi();
    const { ctx, notifications } = makeCtx({
      authResult: { ok: false, error: "bad creds" },
    });

    await commands["btw"]("what is this", ctx);

    expect(notifications).toEqual([
      { message: "Auth error: bad creds", type: "warning" },
    ]);
    expect(completeTextMock).not.toHaveBeenCalled();
  });

  it("surfaces error when apiKey is missing", async () => {
    const { commands } = makeFakePi();
    const { ctx, notifications } = makeCtx({
      authResult: { ok: true, apiKey: undefined, headers: {} },
    });

    await commands["btw"]("what is this", ctx);

    expect(notifications).toEqual([
      { message: "No API key for openrouter", type: "warning" },
    ]);
    expect(completeTextMock).not.toHaveBeenCalled();
  });
});

describe("model request shape", () => {
  it("contains converted session messages, prior exchanges, new question, and tools: []", async () => {
    const { commands } = makeFakePi();
    const fakeCustom = makeFakeCustom();
    const fakeMessage = { role: "user", content: "hello", timestamp: 1 };
    convertToLlmMock.mockReturnValue([{ role: "user", content: "hello" }]);

    const { ctx } = makeCtx({
      custom: fakeCustom.custom,
      branchEntries: [{ type: "message", message: fakeMessage }],
    });

    completeTextMock.mockResolvedValue({
      ok: true,
      text: "answer",
      stopReason: "stop",
    });

    const promise = commands["btw"]("explain this", ctx);
    await flushPromises();

    expect(completeTextMock).toHaveBeenCalledTimes(1);
    const [_model, context, _options] = completeTextMock.mock.calls[0] as [
      unknown,
      {
        systemPrompt?: string;
        messages: unknown[];
        tools?: unknown[];
      },
      unknown,
    ];

    expect(context.tools).toEqual([]);
    expect(context.systemPrompt).toContain("side question");
    expect(context.messages).toHaveLength(2);
    expect(context.messages[0]).toEqual({
      role: "user",
      content: "hello",
    });

    const lastMessage = context.messages[context.messages.length - 1] as {
      role: string;
      content: unknown;
    };
    expect(lastMessage.role).toBe("user");
    expect(lastMessage.content).toEqual([
      { type: "text", text: "explain this" },
    ]);

    fakeCustom.done();
    await promise;
  });

  it("passes a fresh local abort signal, not ctx.signal", async () => {
    const { commands } = makeFakePi();
    const fakeCustom = makeFakeCustom();
    convertToLlmMock.mockReturnValue([]);
    const ctxSignal = new AbortController().signal;

    const { ctx } = makeCtx({ custom: fakeCustom.custom, signal: ctxSignal });

    completeTextMock.mockResolvedValue({
      ok: true,
      text: "answer",
      stopReason: "stop",
    });

    const promise = commands["btw"]("question", ctx);
    await flushPromises();

    expect(completeTextMock).toHaveBeenCalledTimes(1);
    const _call = completeTextMock.mock.calls[0] as [
      unknown,
      unknown,
      { signal?: AbortSignal },
    ];
    const options = _call[2];

    expect(options.signal).toBeDefined();
    expect(options.signal).not.toBe(ctxSignal);
    expect(options.signal?.aborted).toBe(false);

    fakeCustom.done();
    await promise;
  });
});

describe("no transcript mutation", () => {
  it("does not call sendMessage, sendUserMessage, or appendEntry", async () => {
    const { commands, sendMessage, sendUserMessage, appendEntry } =
      makeFakePi();
    const fakeCustom = makeFakeCustom();
    const { ctx } = makeCtx({ custom: fakeCustom.custom });
    convertToLlmMock.mockReturnValue([]);

    completeTextMock.mockResolvedValue({
      ok: true,
      text: "answer",
      stopReason: "stop",
    });

    const promise = commands["btw"]("question", ctx);
    await flushPromises();

    expect(sendMessage).not.toHaveBeenCalled();
    expect(sendUserMessage).not.toHaveBeenCalled();
    expect(appendEntry).not.toHaveBeenCalled();

    fakeCustom.done();
    await promise;
  });
});

describe("follow-up history", () => {
  it("includes prior side Q&A in the prompt for a second question", async () => {
    const { commands } = makeFakePi();
    const fakeCustom = makeFakeCustom();
    convertToLlmMock.mockReturnValue([]);

    const { ctx: ctx1 } = makeCtx({ custom: fakeCustom.custom });
    completeTextMock.mockResolvedValue({
      ok: true,
      text: "first answer",
      stopReason: "stop",
    });

    const p1 = commands["btw"]("first question", ctx1);
    await flushPromises();
    fakeCustom.done();
    await p1;

    const { ctx: ctx2 } = makeCtx({ custom: fakeCustom.custom });
    completeTextMock.mockResolvedValue({
      ok: true,
      text: "second answer",
      stopReason: "stop",
    });

    const p2 = commands["btw"]("second question", ctx2);
    await flushPromises();
    fakeCustom.done();
    await p2;

    expect(completeTextMock).toHaveBeenCalledTimes(2);
    const [_model, context] = completeTextMock.mock.calls[1] as [
      unknown,
      { messages: unknown[] },
      unknown,
    ];

    const texts = context.messages
      .filter(
        (m): m is { role: string; content: unknown } =>
          typeof m === "object" && m !== null && "role" in m,
      )
      .map((m) => {
        if (m.role === "user" && Array.isArray(m.content)) {
          return (m.content as { text: string }[])[0]?.text;
        }
        if (m.role === "assistant" && Array.isArray(m.content)) {
          return (m.content as { text: string }[])[0]?.text;
        }
        return "";
      });

    expect(texts).toContain("Previous side question: first question");
    expect(texts).toContain("first answer");
    expect(texts).toContain("second question");
  });
});

describe("overlay lifecycle", () => {
  it("shows pending then answer on success", async () => {
    const { commands } = makeFakePi();
    const fakeCustom = makeFakeCustom();
    const { ctx } = makeCtx({ custom: fakeCustom.custom });
    convertToLlmMock.mockReturnValue([]);

    let resolveModel: (value: unknown) => void = () => {};
    completeTextMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveModel = resolve;
        }),
    );

    const promise = commands["btw"]("question", ctx);
    await flushPromises();

    const component = fakeCustom.component!;
    const pendingLines = component.render(80);
    expect(pendingLines.some((l) => l.includes("Thinking..."))).toBe(true);

    resolveModel({
      ok: true,
      text: "the answer",
      stopReason: "stop",
    });
    await flushPromises();
    fakeCustom.done();
    await promise;

    const answerLines = component.render(80);
    expect(answerLines.some((l) => l.includes("the answer"))).toBe(true);
  });

  it("stores exchange after successful non-empty response", async () => {
    const { commands } = makeFakePi();
    const fakeCustom = makeFakeCustom();
    const { ctx } = makeCtx({ custom: fakeCustom.custom });
    convertToLlmMock.mockReturnValue([]);

    completeTextMock.mockResolvedValue({
      ok: true,
      text: "stored answer",
      stopReason: "stop",
    });

    const promise = commands["btw"]("question", ctx);
    await flushPromises();
    fakeCustom.done();
    await promise;

    const key = getSessionKey({
      getSessionFile: () => "/tmp/session.json",
      getSessionId: () => "session-1",
    });
    const history = getHistory(key);
    expect(history).toHaveLength(1);
    expect(history[0]).toEqual({
      question: "question",
      answer: "stored answer",
    });
  });

  it("shows error state on model error", async () => {
    const { commands } = makeFakePi();
    const fakeCustom = makeFakeCustom();
    const { ctx } = makeCtx({ custom: fakeCustom.custom });
    convertToLlmMock.mockReturnValue([]);

    completeTextMock.mockResolvedValue({
      ok: false,
      reason: "error",
      message: "provider blew up",
      text: "",
    });

    const promise = commands["btw"]("question", ctx);
    await flushPromises();
    fakeCustom.done();
    await promise;

    const component = fakeCustom.component!;
    const lines = component.render(80);
    expect(lines.some((l) => l.includes("provider blew up"))).toBe(true);
  });

  it("shows error state on empty text response", async () => {
    const { commands } = makeFakePi();
    const fakeCustom = makeFakeCustom();
    const { ctx } = makeCtx({ custom: fakeCustom.custom });
    convertToLlmMock.mockReturnValue([]);

    completeTextMock.mockResolvedValue({
      ok: false,
      reason: "empty",
      text: "",
    });

    const promise = commands["btw"]("question", ctx);
    await flushPromises();
    fakeCustom.done();
    await promise;

    const component = fakeCustom.component!;
    const lines = component.render(80);
    expect(
      lines.some((l) => l.includes("Model returned an empty response")),
    ).toBe(true);
  });

  it("aborts in-flight request on Esc and does not add to history", async () => {
    const { commands } = makeFakePi();
    const fakeCustom = makeFakeCustom();
    const { ctx } = makeCtx({ custom: fakeCustom.custom });
    convertToLlmMock.mockReturnValue([]);

    completeTextMock.mockImplementation((_model, _context, options) => {
      return new Promise((_resolve, reject) => {
        options.signal?.addEventListener("abort", () => {
          const err = new Error("Aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    });

    const promise = commands["btw"]("question", ctx);
    await flushPromises();

    const component = fakeCustom.component!;
    component.handleInput!("\x1B");

    expect(completeTextMock).toHaveBeenCalledTimes(1);
    const options = completeTextMock.mock.calls[0][2] as {
      signal?: AbortSignal;
    };
    expect(options.signal?.aborted).toBe(true);

    fakeCustom.done();
    await promise;

    const key = getSessionKey({
      getSessionFile: () => "/tmp/session.json",
      getSessionId: () => "session-1",
    });
    expect(getHistory(key)).toHaveLength(0);
  });

  it("shows aborted state when completion is aborted", async () => {
    const { commands } = makeFakePi();
    const fakeCustom = makeFakeCustom();
    const { ctx } = makeCtx({ custom: fakeCustom.custom });
    convertToLlmMock.mockReturnValue([]);

    completeTextMock.mockResolvedValue({ ok: false, reason: "aborted" });

    const promise = commands["btw"]("question", ctx);
    await flushPromises();
    fakeCustom.done();
    await promise;

    const component = fakeCustom.component!;
    const lines = component.render(80);
    expect(lines.some((l) => l.includes("Aborted"))).toBe(true);
  });

  it("shows prior exchanges in overlay on follow-up", async () => {
    const { commands } = makeFakePi();
    const fakeCustom = makeFakeCustom();
    convertToLlmMock.mockReturnValue([]);

    const { ctx: ctx1 } = makeCtx({ custom: fakeCustom.custom });
    completeTextMock.mockResolvedValue({
      ok: true,
      text: "first answer",
      stopReason: "stop",
    });

    const p1 = commands["btw"]("first question", ctx1);
    await flushPromises();
    fakeCustom.done();
    await p1;

    const { ctx: ctx2 } = makeCtx({ custom: fakeCustom.custom });
    completeTextMock.mockResolvedValue({
      ok: true,
      text: "second answer",
      stopReason: "stop",
    });

    const p2 = commands["btw"]("second question", ctx2);
    await flushPromises();

    const component = fakeCustom.component!;
    const lines = component.render(80);
    expect(lines.some((l) => l.includes("first question"))).toBe(true);
    expect(lines.some((l) => l.includes("first answer"))).toBe(true);
    expect(lines.some((l) => l.includes("second answer"))).toBe(true);

    fakeCustom.done();
    await p2;
  });

  it("clears history on x and rerenders without earlier entries", async () => {
    const { commands } = makeFakePi();
    const fakeCustom = makeFakeCustom();
    convertToLlmMock.mockReturnValue([]);

    const { ctx: ctx1 } = makeCtx({ custom: fakeCustom.custom });
    completeTextMock.mockResolvedValue({
      ok: true,
      text: "first answer",
      stopReason: "stop",
    });

    const p1 = commands["btw"]("first question", ctx1);
    await flushPromises();
    fakeCustom.done();
    await p1;

    const { ctx: ctx2 } = makeCtx({ custom: fakeCustom.custom });
    completeTextMock.mockResolvedValue({
      ok: true,
      text: "second answer",
      stopReason: "stop",
    });

    const p2 = commands["btw"]("second question", ctx2);
    await flushPromises();

    const component = fakeCustom.component!;
    expect(component.render(80).some((l) => l.includes("first question"))).toBe(
      true,
    );

    component.handleInput!("x");
    expect(component.render(80).some((l) => l.includes("first question"))).toBe(
      false,
    );

    fakeCustom.done();
    await p2;

    const key = getSessionKey({
      getSessionFile: () => "/tmp/session.json",
      getSessionId: () => "session-1",
    });
    expect(getHistory(key)).toHaveLength(0);
  });

  it("scrolls with arrow keys when content overflows", async () => {
    const { commands } = makeFakePi();
    const fakeCustom = makeFakeCustom();
    convertToLlmMock.mockReturnValue([]);

    const history = Array.from({ length: 6 }, (_, i) => ({
      question: `q${i}`,
      answer: `a${i}`,
    }));

    const { ctx } = makeCtx({ custom: fakeCustom.custom });
    completeTextMock.mockResolvedValue({
      ok: true,
      text: "final answer",
      stopReason: "stop",
    });

    // Pre-seed history so the overlay has overflowing content
    const key = getSessionKey({
      getSessionFile: () => "/tmp/session.json",
      getSessionId: () => "session-1",
    });
    for (const ex of history) {
      const { addExchange } = await import("./state.js");
      addExchange(key, ex);
    }

    const promise = commands["btw"]("question", ctx);
    await flushPromises();

    const component = fakeCustom.component!;
    const initial = component.render(80);
    expect(initial.some((l) => l.includes("final answer"))).toBe(true);
    expect(initial.some((l) => l.includes("q0"))).toBe(false);

    for (let i = 0; i < 20; i++) {
      component.handleInput!("\x1B[A");
    }
    const scrolledUp = component.render(80);
    expect(scrolledUp.some((l) => l.includes("q0"))).toBe(true);

    for (let i = 0; i < 20; i++) {
      component.handleInput!("\x1B[B");
    }
    const scrolledDown = component.render(80);
    expect(scrolledDown.some((l) => l.includes("final answer"))).toBe(true);

    fakeCustom.done();
    await promise;
  });
});
