import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import registerExtension from "./index.js";
import { writeConfig } from "./config.js";

const getAgentDirMock = vi.hoisted(() => vi.fn());
const completeTextMock = vi.hoisted(() => vi.fn());

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
    getAgentDir: getAgentDirMock,
  };
});

function makeFakePi() {
  const handlers = new Map<
    string,
    ((event: unknown, ctx: ExtensionContext) => unknown)[]
  >();
  let sessionName: string | undefined;
  const setSessionName = vi.fn((name: string) => {
    sessionName = name;
  });

  const pi = {
    on: (
      event: string,
      handler: (event: unknown, ctx: ExtensionContext) => unknown,
    ) => {
      handlers.set(event, [...(handlers.get(event) || []), handler]);
    },
    getSessionName: () => sessionName,
    setSessionName,
  } as unknown as ExtensionAPI;

  registerExtension(pi);
  return { handlers, setSessionName };
}

function makeExtensionCtx(options?: {
  model?: Record<string, unknown> | undefined;
}) {
  const notifications: { message: string; type?: "info" | "warning" }[] = [];
  const model = options?.model ?? {
    provider: "openrouter",
    id: "openai/gpt-oss-20b",
  };
  const ctx = {
    mode: "tui",
    ui: {
      notify: (message: string, type?: "info" | "warning") => {
        notifications.push({ message, type });
      },
    },
    modelRegistry: {
      find: vi.fn(() => model),
      getApiKeyAndHeaders: vi.fn(async () => ({
        ok: true,
        apiKey: "test-key",
        headers: {},
      })),
    },
    signal: new AbortController().signal,
  } as unknown as ExtensionContext;

  return { ctx, notifications };
}

function getBeforeAgentStartHandler(
  handlers: Map<string, ((event: unknown, ctx: ExtensionContext) => unknown)[]>,
) {
  const handler = handlers.get("before_agent_start")?.[0];
  if (!handler) {
    throw new Error("before_agent_start handler was not registered");
  }
  return handler;
}

function titlePromptForCall(index: number) {
  const request = completeTextMock.mock.calls[index][1] as {
    messages: { content: { text: string }[] }[];
  };
  return request.messages[0].content[0].text;
}

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("automatic session naming", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "pi-auto-name-"));
    getAgentDirMock.mockReturnValue(tmpDir);
    writeConfig(tmpDir, { model: "openrouter/openai/gpt-oss-20b" });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it("does not start competing title generations from later prompts", async () => {
    const { handlers, setSessionName } = makeFakePi();
    const { ctx } = makeExtensionCtx();
    const beforeAgentStart = getBeforeAgentStartHandler(handlers);
    let resolveComplete: (value: unknown) => void = () => {};
    completeTextMock.mockReturnValue(
      new Promise((resolve) => {
        resolveComplete = resolve;
      }),
    );

    await beforeAgentStart({ prompt: "Initial prompt" }, ctx);
    await beforeAgentStart({ prompt: "Second prompt" }, ctx);

    expect(completeTextMock).toHaveBeenCalledTimes(1);
    expect(titlePromptForCall(0)).toContain("Initial prompt");
    expect(titlePromptForCall(0)).not.toContain("Second prompt");

    resolveComplete({
      ok: true,
      text: "Initial prompt fix",
      stopReason: "stop",
    });
    await flushPromises();

    expect(setSessionName).toHaveBeenCalledWith("Initial prompt fix");
  });

  it("uses minimal reasoning for title generation", async () => {
    const { handlers } = makeFakePi();
    const { ctx } = makeExtensionCtx({
      model: { provider: "deepseek", id: "deepseek-v4-flash", reasoning: true },
    });
    const beforeAgentStart = getBeforeAgentStartHandler(handlers);
    completeTextMock.mockResolvedValue({
      ok: true,
      text: "Token Limit Fix",
      stopReason: "stop",
    });

    await beforeAgentStart({ prompt: "Fix token limit warning" }, ctx);
    await flushPromises();

    expect(completeTextMock).toHaveBeenCalledTimes(1);
    expect(completeTextMock.mock.calls[0][2]).toMatchObject({
      maxTokens: 1024,
      reasoning: "minimal",
    });
  });

  it("falls back to a local title when the model hits the token limit without text", async () => {
    const { handlers, setSessionName } = makeFakePi();
    const { ctx, notifications } = makeExtensionCtx();
    const beforeAgentStart = getBeforeAgentStartHandler(handlers);
    completeTextMock.mockResolvedValue({
      ok: false,
      reason: "length",
      text: "",
    });

    await beforeAgentStart(
      { prompt: "Fix auto name token limit warning" },
      ctx,
    );
    await flushPromises();

    expect(setSessionName).toHaveBeenCalledWith(
      "Fix auto name token limit warning",
    );
    expect(notifications).toEqual([]);
  });

  it("falls back to a local title when no model is configured", async () => {
    rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = mkdtempSync(join(tmpdir(), "pi-auto-name-"));
    getAgentDirMock.mockReturnValue(tmpDir);
    const { handlers, setSessionName } = makeFakePi();
    const { ctx, notifications } = makeExtensionCtx();
    const beforeAgentStart = getBeforeAgentStartHandler(handlers);

    await beforeAgentStart(
      { prompt: "Implement local session naming fallback" },
      ctx,
    );
    await flushPromises();

    expect(completeTextMock).not.toHaveBeenCalled();
    expect(setSessionName).toHaveBeenCalledWith(
      "Implement local session naming fallback",
    );
    expect(notifications).toEqual([]);
  });

  it("retries transient failures with accumulated early prompts", async () => {
    const { handlers } = makeFakePi();
    const { ctx } = makeExtensionCtx();
    const beforeAgentStart = getBeforeAgentStartHandler(handlers);
    completeTextMock
      .mockResolvedValueOnce({
        ok: false,
        reason: "error",
        message: "temporary provider error",
        text: "",
      })
      .mockResolvedValueOnce({
        ok: true,
        text: "Auto Name Race",
        stopReason: "stop",
      });

    await beforeAgentStart({ prompt: "Help me debug this" }, ctx);
    await flushPromises();
    await beforeAgentStart(
      { prompt: "The auto-name extension uses the second prompt" },
      ctx,
    );

    expect(completeTextMock).toHaveBeenCalledTimes(2);
    expect(titlePromptForCall(1)).toContain("Prompt 1:\nHelp me debug this");
    expect(titlePromptForCall(1)).toContain(
      "Prompt 2:\nThe auto-name extension uses the second prompt",
    );
  });
});
