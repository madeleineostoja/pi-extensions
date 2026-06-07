import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import registerExtension from "./index.js";
import { readConfig, writeConfig } from "./config.js";

const getAgentDirMock = vi.hoisted(() => vi.fn());
const completeSimpleMock = vi.hoisted(() => vi.fn());

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
    getAgentDir: getAgentDirMock,
  };
});

function makeFakePi() {
  const commands: Record<
    string,
    (args: string, ctx: ExtensionCommandContext) => Promise<void>
  > = {};
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
    registerCommand: (
      name: string,
      options: {
        handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
      },
    ) => {
      commands[name] = options.handler;
    },
    getSessionName: () => sessionName,
    setSessionName,
  } as unknown as ExtensionAPI;

  registerExtension(pi);
  return { commands, handlers, setSessionName };
}

function makeCommandCtx(options: { modelFound: boolean }) {
  const notifications: { message: string; type?: "info" | "warning" }[] = [];
  const ctx = {
    ui: {
      notify: (message: string, type?: "info" | "warning") => {
        notifications.push({ message, type });
      },
    },
    modelRegistry: {
      find: () => (options.modelFound ? {} : undefined),
    },
  } as unknown as ExtensionCommandContext;

  return { ctx, notifications };
}

function makeExtensionCtx() {
  const notifications: { message: string; type?: "info" | "warning" }[] = [];
  const ctx = {
    mode: "tui",
    ui: {
      notify: (message: string, type?: "info" | "warning") => {
        notifications.push({ message, type });
      },
    },
    modelRegistry: {
      find: vi.fn(() => ({ provider: "openrouter", id: "openai/gpt-oss-20b" })),
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
  const request = completeSimpleMock.mock.calls[index][1] as {
    messages: { content: { text: string }[] }[];
  };
  return request.messages[0].content[0].text;
}

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("auto-name command", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "pi-auto-name-"));
    getAgentDirMock.mockReturnValue(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it("persists the configured model to global user config", async () => {
    const { commands } = makeFakePi();
    const { ctx, notifications } = makeCommandCtx({ modelFound: true });

    await commands["auto-name"]("openrouter/openai/gpt-oss-20b", ctx);

    expect(readConfig(tmpDir)).toEqual({
      model: "openrouter/openai/gpt-oss-20b",
    });
    expect(notifications).toEqual([
      {
        message: "pi-auto-name model set: openrouter/openai/gpt-oss-20b",
        type: "info",
      },
    ]);
  });

  it("does not persist an unknown model", async () => {
    const { commands } = makeFakePi();
    const { ctx, notifications } = makeCommandCtx({ modelFound: false });

    await commands["auto-name"]("openrouter/openai/gpt-oss-20b", ctx);

    expect(readConfig(tmpDir)).toEqual({});
    expect(notifications).toEqual([
      {
        message: "Model not found: openrouter/openai/gpt-oss-20b",
        type: "warning",
      },
    ]);
  });
});

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
    completeSimpleMock.mockReturnValue(
      new Promise((resolve) => {
        resolveComplete = resolve;
      }),
    );

    await beforeAgentStart({ prompt: "Initial prompt" }, ctx);
    await beforeAgentStart({ prompt: "Second prompt" }, ctx);

    expect(completeSimpleMock).toHaveBeenCalledTimes(1);
    expect(titlePromptForCall(0)).toContain("Initial prompt");
    expect(titlePromptForCall(0)).not.toContain("Second prompt");

    resolveComplete({
      stopReason: "stop",
      content: [{ type: "text", text: "Initial prompt fix" }],
    });
    await flushPromises();

    expect(setSessionName).toHaveBeenCalledWith("Initial prompt fix");
  });

  it("retries transient failures with accumulated early prompts", async () => {
    const { handlers } = makeFakePi();
    const { ctx } = makeExtensionCtx();
    const beforeAgentStart = getBeforeAgentStartHandler(handlers);
    completeSimpleMock
      .mockResolvedValueOnce({
        stopReason: "error",
        errorMessage: "temporary provider error",
        content: [],
      })
      .mockResolvedValueOnce({
        stopReason: "stop",
        content: [{ type: "text", text: "Auto Name Race" }],
      });

    await beforeAgentStart({ prompt: "Help me debug this" }, ctx);
    await flushPromises();
    await beforeAgentStart(
      { prompt: "The auto-name extension uses the second prompt" },
      ctx,
    );

    expect(completeSimpleMock).toHaveBeenCalledTimes(2);
    expect(titlePromptForCall(1)).toContain("Prompt 1:\nHelp me debug this");
    expect(titlePromptForCall(1)).toContain(
      "Prompt 2:\nThe auto-name extension uses the second prompt",
    );
  });
});
