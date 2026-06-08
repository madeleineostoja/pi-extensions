import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import registerExtension from "./index.js";
import { clearHistory, getSessionKey } from "./state.js";

const completeSimpleMock = vi.hoisted(() => vi.fn());
const convertToLlmMock = vi.hoisted(() => vi.fn());

vi.mock("@earendil-works/pi-ai", async () => {
  const actual = await vi.importActual<typeof import("@earendil-works/pi-ai")>(
    "@earendil-works/pi-ai",
  );
  return {
    ...actual,
    completeSimple: completeSimpleMock,
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
    expect(completeSimpleMock).not.toHaveBeenCalled();
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
    expect(completeSimpleMock).not.toHaveBeenCalled();
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
    expect(completeSimpleMock).not.toHaveBeenCalled();
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
    expect(completeSimpleMock).not.toHaveBeenCalled();
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
    expect(completeSimpleMock).not.toHaveBeenCalled();
  });
});

describe("model request shape", () => {
  it("contains converted session messages, prior exchanges, new question, and tools: []", async () => {
    const { commands } = makeFakePi();
    const fakeMessage = { role: "user", content: "hello", timestamp: 1 };
    convertToLlmMock.mockReturnValue([{ role: "user", content: "hello" }]);

    const { ctx } = makeCtx({
      branchEntries: [{ type: "message", message: fakeMessage }],
    });

    completeSimpleMock.mockResolvedValue({
      stopReason: "stop",
      content: [{ type: "text", text: "answer" }],
    } as unknown as AssistantMessage);

    await commands["btw"]("explain this", ctx);
    await flushPromises();

    expect(completeSimpleMock).toHaveBeenCalledTimes(1);
    const [_model, context, _options] = completeSimpleMock.mock.calls[0] as [
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

    const lastMessage = context.messages[
      context.messages.length - 1
    ] as { role: string; content: unknown };
    expect(lastMessage.role).toBe("user");
    expect(lastMessage.content).toEqual([
      { type: "text", text: "explain this" },
    ]);
  });

  it("passes a fresh local abort signal, not ctx.signal", async () => {
    const { commands } = makeFakePi();
    convertToLlmMock.mockReturnValue([]);
    const ctxSignal = new AbortController().signal;

    const { ctx } = makeCtx({ signal: ctxSignal });

    completeSimpleMock.mockResolvedValue({
      stopReason: "stop",
      content: [{ type: "text", text: "answer" }],
    } as unknown as AssistantMessage);

    await commands["btw"]("question", ctx);
    await flushPromises();

    expect(completeSimpleMock).toHaveBeenCalledTimes(1);
    const _call = completeSimpleMock.mock.calls[0] as [
      unknown,
      unknown,
      { signal?: AbortSignal },
    ];
    const options = _call[2];

    expect(options.signal).toBeDefined();
    expect(options.signal).not.toBe(ctxSignal);
    expect(options.signal?.aborted).toBe(false);
  });
});

describe("no transcript mutation", () => {
  it("does not call sendMessage, sendUserMessage, or appendEntry", async () => {
    const { commands, sendMessage, sendUserMessage, appendEntry } =
      makeFakePi();
    const { ctx } = makeCtx();
    convertToLlmMock.mockReturnValue([]);

    completeSimpleMock.mockResolvedValue({
      stopReason: "stop",
      content: [{ type: "text", text: "answer" }],
    } as unknown as AssistantMessage);

    await commands["btw"]("question", ctx);
    await flushPromises();

    expect(sendMessage).not.toHaveBeenCalled();
    expect(sendUserMessage).not.toHaveBeenCalled();
    expect(appendEntry).not.toHaveBeenCalled();
  });
});

describe("follow-up history", () => {
  it("includes prior side Q&A in the prompt for a second question", async () => {
    const { commands } = makeFakePi();
    convertToLlmMock.mockReturnValue([]);

    const { ctx: ctx1 } = makeCtx();
    completeSimpleMock.mockResolvedValue({
      stopReason: "stop",
      content: [{ type: "text", text: "first answer" }],
    } as unknown as AssistantMessage);

    await commands["btw"]("first question", ctx1);
    await flushPromises();

    const { ctx: ctx2 } = makeCtx();
    completeSimpleMock.mockResolvedValue({
      stopReason: "stop",
      content: [{ type: "text", text: "second answer" }],
    } as unknown as AssistantMessage);

    await commands["btw"]("second question", ctx2);
    await flushPromises();

    expect(completeSimpleMock).toHaveBeenCalledTimes(2);
    const [_model, context] = completeSimpleMock.mock.calls[1] as [
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

describe("aborted response", () => {
  it("returns gracefully when stopReason is aborted", async () => {
    const { commands, sendMessage, sendUserMessage, appendEntry } =
      makeFakePi();
    const { ctx, notifications } = makeCtx();
    convertToLlmMock.mockReturnValue([]);

    completeSimpleMock.mockResolvedValue({
      stopReason: "aborted",
      content: [],
    } as unknown as AssistantMessage);

    await commands["btw"]("question", ctx);
    await flushPromises();

    expect(notifications).toContainEqual({
      message: "Aborted",
      type: "warning",
    });
    expect(sendMessage).not.toHaveBeenCalled();
    expect(sendUserMessage).not.toHaveBeenCalled();
    expect(appendEntry).not.toHaveBeenCalled();
  });
});

describe("model error", () => {
  it("notifies when stopReason is error", async () => {
    const { commands } = makeFakePi();
    const { ctx, notifications } = makeCtx();
    convertToLlmMock.mockReturnValue([]);

    completeSimpleMock.mockResolvedValue({
      stopReason: "error",
      errorMessage: "provider blew up",
      content: [],
    } as unknown as AssistantMessage);

    await commands["btw"]("question", ctx);
    await flushPromises();

    expect(notifications).toContainEqual({
      message: "provider blew up",
      type: "error",
    });
  });
});

describe("empty text response", () => {
  it("notifies error when no text parts are returned", async () => {
    const { commands } = makeFakePi();
    const { ctx, notifications } = makeCtx();
    convertToLlmMock.mockReturnValue([]);

    completeSimpleMock.mockResolvedValue({
      stopReason: "stop",
      content: [],
    } as unknown as AssistantMessage);

    await commands["btw"]("question", ctx);
    await flushPromises();

    expect(notifications).toContainEqual({
      message: "Model returned an empty response",
      type: "error",
    });
  });
});

describe("abort error catch", () => {
  it("notifies aborted when completeSimple throws AbortError", async () => {
    const { commands } = makeFakePi();
    const { ctx, notifications } = makeCtx();
    convertToLlmMock.mockReturnValue([]);

    const abortError = new Error("Aborted");
    abortError.name = "AbortError";
    completeSimpleMock.mockRejectedValue(abortError);

    await commands["btw"]("question", ctx);
    await flushPromises();

    expect(notifications).toContainEqual({
      message: "Aborted",
      type: "warning",
    });
  });
});
