import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import registerExtension from "./index.js";

const getAgentDirMock = vi.hoisted(() => vi.fn());
const setDefaultModelAndProviderMock = vi.hoisted(() => vi.fn());

vi.mock("@earendil-works/pi-coding-agent", async () => {
  const actual = await vi.importActual<
    typeof import("@earendil-works/pi-coding-agent")
  >("@earendil-works/pi-coding-agent");
  return {
    ...actual,
    getAgentDir: getAgentDirMock,
    SettingsManager: {
      create: (...args: Parameters<typeof actual.SettingsManager.create>) => {
        const settings = actual.SettingsManager.create(...args);
        const setDefaultModelAndProvider =
          settings.setDefaultModelAndProvider.bind(settings);
        settings.setDefaultModelAndProvider = (provider, modelId) => {
          setDefaultModelAndProviderMock(provider, modelId);
          return setDefaultModelAndProvider(provider, modelId);
        };
        return settings;
      },
    },
  };
});

type Settings = Record<string, unknown>;
type Handler = (event: unknown, ctx: ExtensionContext) => unknown;

function makeFakePi() {
  const handlers = new Map<string, Handler[]>();
  const pi = {
    on: (event: string, handler: Handler) => {
      handlers.set(event, [...(handlers.get(event) || []), handler]);
    },
  } as unknown as ExtensionAPI;

  registerExtension(pi);
  return { handlers };
}

function getHandler(handlers: Map<string, Handler[]>, event: string) {
  const handler = handlers.get(event)?.[0];
  if (!handler) {
    throw new Error(`${event} handler was not registered`);
  }
  return handler;
}

function makeExtensionCtx(cwd: string) {
  return { cwd } as ExtensionContext;
}

function settingsPath(agentDir: string) {
  return join(agentDir, "settings.json");
}

function readSettings(agentDir: string) {
  return JSON.parse(readFileSync(settingsPath(agentDir), "utf-8")) as Settings;
}

function writeSettings(agentDir: string, settings: Settings) {
  writeFileSync(settingsPath(agentDir), JSON.stringify(settings, null, 2));
}

function projectSettingsPath(cwd: string) {
  return join(cwd, ".pi", "settings.json");
}

function writeProjectSettings(cwd: string, settings: Settings) {
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  writeFileSync(projectSettingsPath(cwd), JSON.stringify(settings, null, 2));
}

async function runPendingTimers() {
  await vi.runOnlyPendingTimersAsync();
  await Promise.resolve();
}

describe("pi-defaults", () => {
  let tmpDir: string;
  let cwd: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "pi-defaults-"));
    cwd = join(tmpDir, "project");
    getAgentDirMock.mockReturnValue(tmpDir);
    vi.useFakeTimers();
  });

  afterEach(async () => {
    await vi.runOnlyPendingTimersAsync();
    vi.useRealTimers();
    vi.clearAllMocks();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("caches model and thinking defaults from settings.json on session_start", async () => {
    writeSettings(tmpDir, {
      defaultProvider: "openrouter",
      defaultModel: "anthropic/claude-sonnet-4",
      defaultThinkingLevel: "medium",
    });
    const { handlers } = makeFakePi();
    const ctx = makeExtensionCtx(cwd);

    await getHandler(handlers, "session_start")({}, ctx);
    writeSettings(tmpDir, {
      defaultProvider: "openai",
      defaultModel: "gpt-5-mini",
      defaultThinkingLevel: "low",
    });
    await getHandler(handlers, "model_select")({}, ctx);
    await getHandler(handlers, "thinking_level_select")({}, ctx);
    await runPendingTimers();

    expect(readSettings(tmpDir)).toEqual({
      defaultProvider: "openrouter",
      defaultModel: "anthropic/claude-sonnet-4",
      defaultThinkingLevel: "medium",
    });
  });

  it("resets cached defaults on a second session_start", async () => {
    writeSettings(tmpDir, {
      defaultProvider: "openrouter",
      defaultModel: "anthropic/claude-sonnet-4",
      defaultThinkingLevel: "medium",
    });
    const { handlers } = makeFakePi();
    const ctx = makeExtensionCtx(cwd);

    await getHandler(handlers, "session_start")({}, ctx);
    writeSettings(tmpDir, {
      defaultProvider: "openai",
      defaultModel: "gpt-5-mini",
      defaultThinkingLevel: "low",
    });
    await getHandler(handlers, "session_start")({}, ctx);
    writeSettings(tmpDir, {
      defaultProvider: "anthropic",
      defaultModel: "claude-haiku-4",
      defaultThinkingLevel: "high",
    });
    await getHandler(handlers, "model_select")({}, ctx);
    await getHandler(handlers, "thinking_level_select")({}, ctx);
    await runPendingTimers();

    expect(readSettings(tmpDir)).toEqual({
      defaultProvider: "openai",
      defaultModel: "gpt-5-mini",
      defaultThinkingLevel: "low",
    });
  });

  it("restores cached model defaults and preserves unrelated settings", async () => {
    writeSettings(tmpDir, {
      defaultProvider: "openrouter",
      defaultModel: "anthropic/claude-sonnet-4",
      theme: "dracula",
      retry: { enabled: false, maxRetries: 1 },
    });
    const { handlers } = makeFakePi();
    const ctx = makeExtensionCtx(cwd);

    await getHandler(handlers, "session_start")({}, ctx);
    writeSettings(tmpDir, {
      defaultProvider: "openai",
      defaultModel: "gpt-5-mini",
      theme: "dracula",
      retry: { enabled: false, maxRetries: 1 },
    });
    await getHandler(handlers, "model_select")({}, ctx);
    await runPendingTimers();

    expect(readSettings(tmpDir)).toEqual({
      defaultProvider: "openrouter",
      defaultModel: "anthropic/claude-sonnet-4",
      theme: "dracula",
      retry: { enabled: false, maxRetries: 1 },
    });
  });

  it("restores cached thinking defaults", async () => {
    writeSettings(tmpDir, { defaultThinkingLevel: "high" });
    const { handlers } = makeFakePi();
    const ctx = makeExtensionCtx(cwd);

    await getHandler(handlers, "session_start")({}, ctx);
    writeSettings(tmpDir, { defaultThinkingLevel: "minimal" });
    await getHandler(handlers, "thinking_level_select")({}, ctx);
    await runPendingTimers();

    expect(readSettings(tmpDir)).toEqual({ defaultThinkingLevel: "high" });
  });

  it("restores global model defaults when project settings mask the clobbered global defaults", async () => {
    writeSettings(tmpDir, {
      defaultProvider: "global-provider",
      defaultModel: "global-model",
      theme: "dracula",
    });
    writeProjectSettings(cwd, {
      defaultProvider: "project-provider",
      defaultModel: "project-model",
    });
    const { handlers } = makeFakePi();
    const ctx = makeExtensionCtx(cwd);

    await getHandler(handlers, "session_start")({}, ctx);
    writeSettings(tmpDir, {
      defaultProvider: "openai",
      defaultModel: "gpt-5-mini",
      theme: "dracula",
    });
    await getHandler(handlers, "model_select")({}, ctx);
    await runPendingTimers();

    expect(readSettings(tmpDir)).toEqual({
      defaultProvider: "project-provider",
      defaultModel: "project-model",
      theme: "dracula",
    });
  });

  it("restores global thinking defaults when project settings mask the clobbered global default", async () => {
    writeSettings(tmpDir, {
      defaultThinkingLevel: "low",
      theme: "dracula",
    });
    writeProjectSettings(cwd, { defaultThinkingLevel: "high" });
    const { handlers } = makeFakePi();
    const ctx = makeExtensionCtx(cwd);

    await getHandler(handlers, "session_start")({}, ctx);
    writeSettings(tmpDir, {
      defaultThinkingLevel: "minimal",
      theme: "dracula",
    });
    await getHandler(handlers, "thinking_level_select")({}, ctx);
    await runPendingTimers();

    expect(readSettings(tmpDir)).toEqual({
      defaultThinkingLevel: "high",
      theme: "dracula",
    });
  });

  it("does not invent model defaults missing at session start", async () => {
    writeSettings(tmpDir, { theme: "dracula" });
    const { handlers } = makeFakePi();
    const ctx = makeExtensionCtx(cwd);

    await getHandler(handlers, "session_start")({}, ctx);
    writeSettings(tmpDir, {
      theme: "dracula",
      defaultProvider: "openai",
      defaultModel: "gpt-5-mini",
    });
    await getHandler(handlers, "model_select")({}, ctx);
    await runPendingTimers();

    expect(readSettings(tmpDir)).toEqual({
      theme: "dracula",
      defaultProvider: "openai",
      defaultModel: "gpt-5-mini",
    });
  });

  it("does not invent thinking defaults missing at session start", async () => {
    writeSettings(tmpDir, { theme: "dracula" });
    const { handlers } = makeFakePi();
    const ctx = makeExtensionCtx(cwd);

    await getHandler(handlers, "session_start")({}, ctx);
    writeSettings(tmpDir, {
      theme: "dracula",
      defaultThinkingLevel: "minimal",
    });
    await getHandler(handlers, "thinking_level_select")({}, ctx);
    await runPendingTimers();

    expect(readSettings(tmpDir)).toEqual({
      theme: "dracula",
      defaultThinkingLevel: "minimal",
    });
  });

  it("does not write when cached defaults already match persisted settings", async () => {
    writeSettings(tmpDir, {
      defaultProvider: "openrouter",
      defaultModel: "anthropic/claude-sonnet-4",
    });
    const { handlers } = makeFakePi();
    const ctx = makeExtensionCtx(cwd);

    await getHandler(handlers, "session_start")({}, ctx);
    setDefaultModelAndProviderMock.mockClear();
    await getHandler(handlers, "model_select")({}, ctx);
    await runPendingTimers();

    expect(readSettings(tmpDir)).toEqual({
      defaultProvider: "openrouter",
      defaultModel: "anthropic/claude-sonnet-4",
    });
    expect(setDefaultModelAndProviderMock).not.toHaveBeenCalled();
  });

  it("coalesces rapid model_select events into one debounced restore write", async () => {
    writeSettings(tmpDir, {
      defaultProvider: "openrouter",
      defaultModel: "anthropic/claude-sonnet-4",
    });
    const { handlers } = makeFakePi();
    const ctx = makeExtensionCtx(cwd);

    await getHandler(handlers, "session_start")({}, ctx);
    writeSettings(tmpDir, {
      defaultProvider: "openai",
      defaultModel: "gpt-5-mini",
    });
    setDefaultModelAndProviderMock.mockClear();

    await getHandler(handlers, "model_select")({}, ctx);
    await getHandler(handlers, "model_select")({}, ctx);
    await getHandler(handlers, "model_select")({}, ctx);
    await runPendingTimers();

    expect(readSettings(tmpDir)).toEqual({
      defaultProvider: "openrouter",
      defaultModel: "anthropic/claude-sonnet-4",
    });
    expect(setDefaultModelAndProviderMock).toHaveBeenCalledTimes(1);
  });

  it("does not create settings.json when no model defaults were cached", async () => {
    const { handlers } = makeFakePi();
    const ctx = makeExtensionCtx(cwd);

    await getHandler(handlers, "session_start")({}, ctx);
    await getHandler(handlers, "model_select")({}, ctx);
    await runPendingTimers();

    expect(existsSync(settingsPath(tmpDir))).toBe(false);
  });
});
