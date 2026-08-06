import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { getConfigPath, loadPipkinConfig, presetIssue } from "#lib/config";
import { registerSessionNaming } from "./session-naming.js";

const getAgentDirMock = vi.hoisted(() => vi.fn());
const completeTextMock = vi.hoisted(() => vi.fn());

vi.mock("#lib/complete", async () => {
  const actual =
    await vi.importActual<typeof import("#lib/complete")>("#lib/complete");
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
  const getSessionName = vi.fn(() => sessionName);
  const setSessionName = vi.fn((name: string) => {
    sessionName = name;
  });

  const eventListeners = new Map<string, ((event: unknown) => void)[]>();
  const pi = {
    on: (
      event: string,
      handler: (event: unknown, ctx: ExtensionContext) => unknown,
    ) => {
      handlers.set(event, [...(handlers.get(event) || []), handler]);
    },
    events: {
      emit: (channel: string, event: unknown) => {
        for (const listener of eventListeners.get(channel) ?? []) {
          listener(event);
        }
      },
      on: (channel: string, listener: (event: unknown) => void) => {
        eventListeners.set(channel, [
          ...(eventListeners.get(channel) ?? []),
          listener,
        ]);
        return () =>
          eventListeners.set(
            channel,
            (eventListeners.get(channel) ?? []).filter(
              (entry) => entry !== listener,
            ),
          );
      },
    },
    getSessionName,
    setSessionName,
  } as unknown as ExtensionAPI;

  const agentDir = getAgentDirMock();
  const config = loadPipkinConfig(agentDir);
  registerSessionNaming(pi, {
    utility: config.config.models.utility,
    utilityIssue: presetIssue(config, "utility")?.message,
    configPath: getConfigPath(agentDir),
  });
  return { handlers, getSessionName, setSessionName, events: pi.events };
}

function makeExtensionCtx(options?: {
  model?: Record<string, unknown> | undefined;
  mode?: ExtensionContext["mode"];
}) {
  const notifications: { message: string; type?: "info" | "warning" }[] = [];
  const model = options?.model ?? {
    provider: "openrouter",
    id: "openai/gpt-oss-20b",
  };
  const ctx = {
    mode: options?.mode ?? "tui",
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
  for (let index = 0; index < 6; index++) {
    await Promise.resolve();
  }
}

describe("automatic session naming", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "pipkin-personality-"));
    getAgentDirMock.mockReturnValue(tmpDir);
    mkdirSync(join(tmpDir, "pipkin"), { recursive: true });
    writeFileSync(
      join(tmpDir, "pipkin", "config.json"),
      JSON.stringify({
        models: {
          utility: {
            model: "openrouter/openai/gpt-oss-20b",
            thinking: "minimal",
          },
          low: { model: "openrouter/low", thinking: "low" },
          medium: { model: "openrouter/medium", thinking: "medium" },
          high: { model: "openrouter/high", thinking: "high" },
        },
      }),
    );
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it("does not run in managed print-mode sessions", async () => {
    const { handlers, getSessionName, setSessionName } = makeFakePi();
    const { ctx } = makeExtensionCtx({ mode: "print" });
    const beforeAgentStart = getBeforeAgentStartHandler(handlers);

    await beforeAgentStart({ prompt: "Implement a plan task" }, ctx);
    await flushPromises();

    expect(completeTextMock).not.toHaveBeenCalled();
    expect(getSessionName).not.toHaveBeenCalled();
    expect(setSessionName).not.toHaveBeenCalled();
  });

  it("discards a pending title when its session shuts down", async () => {
    const { handlers, getSessionName, setSessionName } = makeFakePi();
    const { ctx, notifications } = makeExtensionCtx();
    const beforeAgentStart = getBeforeAgentStartHandler(handlers);
    const sessionShutdown = handlers.get("session_shutdown")?.[0];
    if (!sessionShutdown) {
      throw new Error("session_shutdown handler was not registered");
    }
    let resolveComplete: (value: unknown) => void = () => {};
    completeTextMock.mockReturnValue(
      new Promise((resolve) => {
        resolveComplete = resolve;
      }),
    );

    await beforeAgentStart({ prompt: "Implement a plan task" }, ctx);
    await flushPromises();
    const requestSignal = completeTextMock.mock.calls[0][2]
      .signal as AbortSignal;
    await sessionShutdown({}, ctx);
    getSessionName.mockImplementation(() => {
      throw new Error("stale extension context");
    });
    resolveComplete({
      ok: true,
      text: "Implement plan task",
      stopReason: "stop",
    });
    await flushPromises();

    expect(requestSignal.aborted).toBe(true);
    expect(getSessionName).toHaveBeenCalledTimes(1);
    expect(setSessionName).not.toHaveBeenCalled();
    expect(notifications).toEqual([]);
  });

  it("does not start competing title generations from later prompts", async () => {
    const { handlers, setSessionName } = makeFakePi();
    const { ctx, notifications } = makeExtensionCtx();
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
    expect(notifications).toContainEqual({
      message: "(•ᴗ•)ゞ I’m calling this one “Initial prompt fix”.",
      type: "info",
    });
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
    expect(notifications).toContainEqual({
      message:
        "(•ᴗ•)ゞ I’m calling this one “Fix auto name token limit warning”.",
      type: "info",
    });
  });

  it("falls back to a local title when no model is configured", async () => {
    rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = mkdtempSync(join(tmpdir(), "pipkin-personality-"));
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
    expect(notifications).toContainEqual({
      message:
        "(•ᴗ•)ゞ I’m calling this one “Implement local session naming fallback”.",
      type: "info",
    });
  });

  it("silently cancels ordinary naming when Implement claims ownership", async () => {
    const { handlers, setSessionName, events } = makeFakePi();
    const { ctx, notifications } = makeExtensionCtx();
    const beforeAgentStart = getBeforeAgentStartHandler(handlers);
    let resolveComplete: (value: unknown) => void = () => {};
    completeTextMock.mockReturnValue(
      new Promise((resolve) => {
        resolveComplete = resolve;
      }),
    );
    await handlers.get("session_start")?.[0]({}, ctx);
    await beforeAgentStart({ prompt: "Ordinary prompt" }, ctx);
    events.emit("pipkin:personality:implement-naming-claim", undefined);
    resolveComplete({ ok: false, reason: "aborted", text: "" });
    await flushPromises();
    expect(setSessionName).not.toHaveBeenCalled();
    expect(notifications).toEqual([]);
  });

  it("does not overwrite an Implement title set while ordinary naming is pending", async () => {
    const { handlers, setSessionName } = makeFakePi();
    const { ctx } = makeExtensionCtx();
    const beforeAgentStart = getBeforeAgentStartHandler(handlers);
    let resolveComplete: (value: unknown) => void = () => {};
    completeTextMock.mockReturnValue(
      new Promise((resolve) => {
        resolveComplete = resolve;
      }),
    );

    await beforeAgentStart({ prompt: "Ordinary prompt" }, ctx);
    setSessionName("Implement managed processes");
    resolveComplete({
      ok: true,
      text: "Ordinary title",
      stopReason: "stop",
    });
    await flushPromises();

    expect(setSessionName).toHaveBeenCalledTimes(1);
    expect(setSessionName).toHaveBeenCalledWith("Implement managed processes");
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
    await vi.waitFor(() => expect(completeTextMock).toHaveBeenCalledTimes(1));
    await vi.waitFor(async () => {
      await beforeAgentStart(
        { prompt: "The auto-name extension uses the second prompt" },
        ctx,
      );
      expect(completeTextMock).toHaveBeenCalledTimes(2);
    });

    expect(titlePromptForCall(1)).toContain("Prompt 1:\nHelp me debug this");
    expect(titlePromptForCall(1)).toContain(
      "Prompt 2:\nThe auto-name extension uses the second prompt",
    );
  });
});
