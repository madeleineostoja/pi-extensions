import { describe, it, expect, afterEach, vi } from "vitest";
import type { UsageSnapshot } from "./provider.js";
import { STATUS_KEY } from "./constants.js";

type EventHandler = (event: unknown, ctx: unknown) => unknown;

type FakePi = {
  handlers: Map<string, EventHandler>;
  commands: Map<
    string,
    {
      description: string;
      handler: (args: string, ctx: unknown) => Promise<void>;
    }
  >;
  on(event: string, handler: EventHandler): void;
  registerCommand(
    name: string,
    options: {
      description: string;
      handler: (args: string, ctx: unknown) => Promise<void>;
    },
  ): void;
};

function makePi(): FakePi {
  const handlers = new Map<string, EventHandler>();
  const commands = new Map<
    string,
    {
      description: string;
      handler: (args: string, ctx: unknown) => Promise<void>;
    }
  >();
  return {
    handlers,
    commands,
    on(event: string, handler: EventHandler) {
      handlers.set(event, handler);
    },
    registerCommand(name, options) {
      commands.set(name, options);
    },
  };
}

type FakeModel = { provider: string; id: string; name?: string };

type FakeCtx = {
  mode: "tui" | "rpc" | "json" | "print";
  model: FakeModel | null;
  ui: {
    theme: {
      fg(color: string, text: string): string;
      bg(_color: string, text: string): string;
      bold: (t: string) => string;
      italic: (t: string) => string;
      underline: (t: string) => string;
      inverse: (t: string) => string;
      strikethrough: (t: string) => string;
      getFgAnsi: () => string;
      getBgAnsi: () => string;
      getColorMode: () => "truecolor";
      getThinkingBorderColor: () => (s: string) => string;
      getBashModeBorderColor: () => (s: string) => string;
    };
    setStatus: ReturnType<typeof vi.fn>;
    notify: ReturnType<typeof vi.fn>;
  };
  modelRegistry: {
    getAvailable: () => FakeModel[];
    getApiKeyAndHeaders: () => Promise<{ ok: false; error: string }>;
  };
};

function makeCtx(
  provider = "openai-codex",
  modeOrTui: "tui" | "rpc" | "json" | "print" | boolean = "tui",
  available: FakeModel[] = [],
): FakeCtx {
  const mode =
    typeof modeOrTui === "boolean" ? (modeOrTui ? "tui" : "rpc") : modeOrTui;
  return {
    mode,
    model: provider ? { provider, id: "model-1" } : null,
    ui: {
      theme: {
        fg: (_color: string, text: string) => text,
        bg: (_color: string, text: string) => text,
        bold: (t: string) => t,
        italic: (t: string) => t,
        underline: (t: string) => t,
        inverse: (t: string) => t,
        strikethrough: (t: string) => t,
        getFgAnsi: () => "",
        getBgAnsi: () => "",
        getColorMode: () => "truecolor" as const,
        getThinkingBorderColor: () => (s: string) => s,
        getBashModeBorderColor: () => (s: string) => s,
      },
      setStatus: vi.fn(),
      notify: vi.fn(),
    },
    modelRegistry: {
      getAvailable: () => available,
      getApiKeyAndHeaders: async () => ({ ok: false, error: "no auth" }),
    },
  };
}

async function loadExtension(
  getUsageMock: (...args: unknown[]) => Promise<UsageSnapshot | null>,
  runOpencodeAuthSetupMock = vi.fn(),
): Promise<{ pi: FakePi; defaultExport: (pi: FakePi) => void }> {
  vi.resetModules();
  vi.doMock("./provider.js", async (importOriginal) => {
    const actual = (await importOriginal()) as Record<string, unknown>;
    return {
      ...actual,
      getUsage: getUsageMock,
    };
  });
  vi.doMock("./config.js", async () => {
    return {
      runOpencodeAuthSetup: runOpencodeAuthSetupMock,
    };
  });
  const mod = await import("./index.js");
  return {
    pi: makePi(),
    defaultExport: mod.default as unknown as (pi: FakePi) => void,
  };
}

const fakeSnapshot: UsageSnapshot = {
  provider: "codex",
  primary: { usedPercent: 42 },
  secondary: { usedPercent: 71 },
  fetchedAt: Date.now(),
};

describe("extension lifecycle", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("registers handlers for session_start, model_select, message_end, session_shutdown", async () => {
    const { pi, defaultExport } = await loadExtension(async () => fakeSnapshot);
    defaultExport(pi as never);
    expect(pi.handlers.has("session_start")).toBe(true);
    expect(pi.handlers.has("model_select")).toBe(true);
    expect(pi.handlers.has("message_end")).toBe(true);
    expect(pi.handlers.has("session_shutdown")).toBe(true);
  });

  it("calls setStatus after session_start with Codex model", async () => {
    const { pi, defaultExport } = await loadExtension(async () => fakeSnapshot);
    defaultExport(pi as never);
    const ctx = makeCtx("openai-codex");
    const handler = pi.handlers.get("session_start")!;
    await handler({}, ctx);
    expect(ctx.ui.setStatus).toHaveBeenCalledWith(
      STATUS_KEY,
      expect.any(String),
    );
  });

  it("calls setStatus after session_start with Opencode model", async () => {
    const { pi, defaultExport } = await loadExtension(async () => ({
      provider: "opencode" as const,
      primary: { usedPercent: 42 },
      fetchedAt: Date.now(),
    }));
    defaultExport(pi as never);
    const ctx = makeCtx("opencode");
    const handler = pi.handlers.get("session_start")!;
    await handler({}, ctx);
    expect(ctx.ui.setStatus).toHaveBeenCalledWith(
      STATUS_KEY,
      expect.any(String),
    );
  });

  it("clears status after session_start with non-supported model", async () => {
    const { pi, defaultExport } = await loadExtension(async () => fakeSnapshot);
    defaultExport(pi as never);
    const ctx = makeCtx("anthropic");
    const handler = pi.handlers.get("session_start")!;
    await handler({}, ctx);
    expect(ctx.ui.setStatus).toHaveBeenCalledWith(STATUS_KEY, undefined);
  });

  it("calls setStatus after model_select switches to Codex", async () => {
    const { pi, defaultExport } = await loadExtension(async () => fakeSnapshot);
    defaultExport(pi as never);
    const ctx = makeCtx("openai-codex");
    const handler = pi.handlers.get("model_select")!;
    await handler({ model: { provider: "openai-codex", id: "codex-1" } }, ctx);
    expect(ctx.ui.setStatus).toHaveBeenCalledWith(
      STATUS_KEY,
      expect.any(String),
    );
  });

  it("calls setStatus after model_select switches to Opencode", async () => {
    const { pi, defaultExport } = await loadExtension(async () => ({
      provider: "opencode" as const,
      primary: { usedPercent: 42 },
      fetchedAt: Date.now(),
    }));
    defaultExport(pi as never);
    const ctx = makeCtx("opencode");
    const handler = pi.handlers.get("model_select")!;
    await handler({ model: { provider: "opencode", id: "go-1" } }, ctx);
    expect(ctx.ui.setStatus).toHaveBeenCalledWith(
      STATUS_KEY,
      expect.any(String),
    );
  });

  it("clears status after model_select switches away from supported provider", async () => {
    const { pi, defaultExport } = await loadExtension(async () => fakeSnapshot);
    defaultExport(pi as never);
    const ctx = makeCtx("anthropic");
    const handler = pi.handlers.get("model_select")!;
    await handler({ model: { provider: "anthropic", id: "claude-1" } }, ctx);
    expect(ctx.ui.setStatus).toHaveBeenCalledWith(STATUS_KEY, undefined);
  });

  it("clears status on session_shutdown", async () => {
    const { pi, defaultExport } = await loadExtension(async () => fakeSnapshot);
    defaultExport(pi as never);
    const ctx = makeCtx("openai-codex");
    const handler = pi.handlers.get("session_shutdown")!;
    handler({}, ctx);
    expect(ctx.ui.setStatus).toHaveBeenCalledWith(STATUS_KEY, undefined);
  });

  it("does not call setStatus when mode is not tui", async () => {
    const { pi, defaultExport } = await loadExtension(async () => fakeSnapshot);
    defaultExport(pi as never);
    const ctx = makeCtx("openai-codex", false);
    const handler = pi.handlers.get("session_start")!;
    await handler({}, ctx);
    expect(ctx.ui.setStatus).not.toHaveBeenCalled();
  });

  it("message_end returns undefined when message is not a limit error", async () => {
    const { pi, defaultExport } = await loadExtension(async () => fakeSnapshot);
    defaultExport(pi as never);
    const ctx = makeCtx("openai-codex");
    const handler = pi.handlers.get("message_end")!;
    const result = await handler(
      {
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Hello, everything is fine!" }],
        },
      },
      ctx,
    );
    expect(result).toBeUndefined();
  });

  it("message_end returns undefined when model is not Codex", async () => {
    const { pi, defaultExport } = await loadExtension(async () => fakeSnapshot);
    defaultExport(pi as never);
    const ctx = makeCtx("opencode");
    const handler = pi.handlers.get("message_end")!;
    const result = await handler(
      {
        message: {
          role: "assistant",
          content: [
            {
              type: "text",
              text: "chatgpt openai rate_limit quota exceeded 429",
            },
          ],
        },
      },
      ctx,
    );
    expect(result).toBeUndefined();
  });

  it("message_end returns replacement and forces a refresh when message is a Codex limit error", async () => {
    const getUsageMock = vi.fn(async () => fakeSnapshot);
    const { pi, defaultExport } = await loadExtension(getUsageMock);
    defaultExport(pi as never);
    const ctx = makeCtx("openai-codex");
    const handler = pi.handlers.get("message_end")!;
    const result = (await handler(
      {
        message: {
          role: "assistant",
          content: [],
          errorMessage: "OpenAI Codex rate_limit exceeded",
        },
      },
      ctx,
    )) as { message: { role: string; content: unknown[] } } | undefined;
    expect(result).toBeDefined();
    expect(result!.message.role).toBe("assistant");
    expect(Array.isArray(result!.message.content)).toBe(true);
    expect(getUsageMock).toHaveBeenCalledWith(ctx.model, ctx, true);
  });

  it("session_start with null model clears status", async () => {
    const { pi, defaultExport } = await loadExtension(async () => fakeSnapshot);
    defaultExport(pi as never);
    const ctx = makeCtx("openai-codex");
    ctx.model = null;
    const handler = pi.handlers.get("session_start")!;
    await handler({}, ctx);
    expect(ctx.ui.setStatus).toHaveBeenCalledWith(STATUS_KEY, undefined);
  });

  it("sets opencode usage ? footer when opencode model is active and usage is null", async () => {
    const { pi, defaultExport } = await loadExtension(async () => null);
    defaultExport(pi as never);
    const ctx = makeCtx("opencode");
    const handler = pi.handlers.get("session_start")!;
    await handler({}, ctx);
    expect(ctx.ui.setStatus).toHaveBeenCalledWith(
      STATUS_KEY,
      expect.stringContaining("opencode usage ?"),
    );
  });

  it("shows actionable error footer when opencode credentials are missing", async () => {
    const { pi, defaultExport } = await loadExtension(async () => ({
      provider: "opencode" as const,
      fetchedAt: Date.now(),
      error:
        "Opencode credentials not configured. Run /usage auth to set them up.",
    }));
    defaultExport(pi as never);
    const ctx = makeCtx("opencode");
    const handler = pi.handlers.get("session_start")!;
    await handler({}, ctx);
    expect(ctx.ui.setStatus).toHaveBeenCalledWith(
      STATUS_KEY,
      expect.stringContaining("/usage auth"),
    );
  });

  it("triggers background refresh after stale snapshot", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let callCount = 0;
    const getUsageMock = vi.fn(async () => {
      callCount++;
      if (callCount === 1) {
        return {
          provider: "opencode" as const,
          primary: { usedPercent: 42 },
          fetchedAt: Date.now(),
          stale: true,
        };
      }
      return {
        provider: "opencode" as const,
        primary: { usedPercent: 42 },
        fetchedAt: Date.now(),
      };
    });
    const { pi, defaultExport } = await loadExtension(getUsageMock);
    defaultExport(pi as never);
    const ctx = makeCtx("opencode");
    const handler = pi.handlers.get("session_start")!;
    await handler({}, ctx);
    expect(ctx.ui.setStatus).toHaveBeenCalledWith(
      STATUS_KEY,
      expect.stringContaining("opencode"),
    );
    expect(getUsageMock).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(5000);
    await vi.waitFor(() => expect(getUsageMock).toHaveBeenCalledTimes(2));
    vi.useRealTimers();
  });

  it("cancels stale retry timer when switching to unsupported provider", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let callCount = 0;
    const getUsageMock = vi.fn(async () => {
      callCount++;
      if (callCount === 1) {
        return {
          provider: "opencode" as const,
          primary: { usedPercent: 42 },
          fetchedAt: Date.now(),
          stale: true,
        };
      }
      return null;
    });
    const { pi, defaultExport } = await loadExtension(getUsageMock);
    defaultExport(pi as never);
    const ctx = makeCtx("opencode");
    const handler = pi.handlers.get("session_start")!;
    await handler({}, ctx);
    expect(getUsageMock).toHaveBeenCalledTimes(1);

    const modelSelectHandler = pi.handlers.get("model_select")!;
    await modelSelectHandler(
      { model: { provider: "anthropic", id: "claude-1" } },
      makeCtx("anthropic"),
    );

    vi.advanceTimersByTime(5000);
    expect(getUsageMock).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});

describe("command registration", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("registers the usage command", async () => {
    const { pi, defaultExport } = await loadExtension(async () => fakeSnapshot);
    defaultExport(pi as never);
    expect(pi.commands.has("usage")).toBe(true);
  });

  it("does not register the codex-usage command", async () => {
    const { pi, defaultExport } = await loadExtension(async () => fakeSnapshot);
    defaultExport(pi as never);
    expect(pi.commands.has("codex-usage")).toBe(false);
  });
});

describe("command handler", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("does nothing when mode is not tui", async () => {
    const getUsageMock = vi.fn(async () => fakeSnapshot);
    const { pi, defaultExport } = await loadExtension(getUsageMock);
    defaultExport(pi as never);
    const cmd = pi.commands.get("usage")!;
    const ctx = makeCtx("openai-codex", false);
    await cmd.handler("", ctx);
    expect(ctx.ui.notify).not.toHaveBeenCalled();
  });

  it("runs auth setup when args is 'auth'", async () => {
    const authMock = vi.fn(async () => true);
    const getUsageMock = vi.fn(async () => fakeSnapshot);
    const { pi, defaultExport } = await loadExtension(getUsageMock, authMock);
    defaultExport(pi as never);
    const cmd = pi.commands.get("usage")!;
    const ctx = makeCtx("openai-codex");
    await cmd.handler("auth", ctx);
    expect(authMock).toHaveBeenCalledWith(ctx);
    expect(getUsageMock).not.toHaveBeenCalled();
    expect(ctx.ui.notify).not.toHaveBeenCalled();
  });

  it("refreshes the Opencode footer after auth setup", async () => {
    const authMock = vi.fn(async () => true);
    const getUsageMock = vi.fn(async () => ({
      provider: "opencode" as const,
      primary: { usedPercent: 12 },
      fetchedAt: Date.now(),
    }));
    const { pi, defaultExport } = await loadExtension(getUsageMock, authMock);
    defaultExport(pi as never);
    const cmd = pi.commands.get("usage")!;
    const ctx = makeCtx("opencode");
    await cmd.handler("auth", ctx);
    expect(authMock).toHaveBeenCalledWith(ctx);
    expect(getUsageMock).toHaveBeenCalledWith(ctx.model, ctx, true);
    expect(ctx.ui.setStatus).toHaveBeenCalledWith(
      STATUS_KEY,
      expect.stringContaining("opencode 12%"),
    );
  });

  it("does not refresh the Opencode footer when auth setup is cancelled", async () => {
    const authMock = vi.fn(async () => false);
    const getUsageMock = vi.fn(async () => ({
      provider: "opencode" as const,
      primary: { usedPercent: 12 },
      fetchedAt: Date.now(),
    }));
    const { pi, defaultExport } = await loadExtension(getUsageMock, authMock);
    defaultExport(pi as never);
    const cmd = pi.commands.get("usage")!;
    const ctx = makeCtx("opencode");
    await cmd.handler("auth", ctx);
    expect(getUsageMock).not.toHaveBeenCalled();
    expect(ctx.ui.setStatus).not.toHaveBeenCalled();
  });

  it("warns for unknown subcommands", async () => {
    const { pi, defaultExport } = await loadExtension(async () => fakeSnapshot);
    defaultExport(pi as never);
    const cmd = pi.commands.get("usage")!;
    const ctx = makeCtx("openai-codex");
    await cmd.handler("foo", ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "usage: /usage [auth]",
      "warning",
    );
  });

  it("warns when no providers are available", async () => {
    const { pi, defaultExport } = await loadExtension(async () => fakeSnapshot);
    defaultExport(pi as never);
    const cmd = pi.commands.get("usage")!;
    const ctx = makeCtx("anthropic", true, []);
    await cmd.handler("", ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "No usage providers configured. Sign in via /login.",
      "warning",
    );
  });

  it("notifies summary for a single available Codex provider", async () => {
    const getUsageMock = vi.fn(async () => fakeSnapshot);
    const { pi, defaultExport } = await loadExtension(getUsageMock);
    defaultExport(pi as never);
    const cmd = pi.commands.get("usage")!;
    const ctx = makeCtx("anthropic", true, [
      { provider: "openai-codex", id: "c1" },
    ]);
    await cmd.handler("", ctx);
    expect(getUsageMock).toHaveBeenCalledTimes(1);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Codex"),
      "info",
    );
  });

  it("notifies summary for a single available Opencode provider", async () => {
    const getUsageMock = vi.fn(async () => ({
      provider: "opencode" as const,
      primary: { usedPercent: 12, resetInSec: 3600 },
      fetchedAt: Date.now(),
    }));
    const { pi, defaultExport } = await loadExtension(getUsageMock);
    defaultExport(pi as never);
    const cmd = pi.commands.get("usage")!;
    const ctx = makeCtx("anthropic", true, [
      { provider: "opencode", id: "o1" },
    ]);
    await cmd.handler("", ctx);
    expect(getUsageMock).toHaveBeenCalledTimes(1);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Opencode"),
      "info",
    );
  });

  it("notifies summary for both available providers", async () => {
    const getUsageMock = vi.fn(async (...args: unknown[]) => {
      const model = args[0] as FakeModel;
      if (model.provider === "openai-codex") {
        return fakeSnapshot;
      }
      return {
        provider: "opencode" as const,
        primary: { usedPercent: 12, resetInSec: 3600 },
        fetchedAt: Date.now(),
      };
    });
    const { pi, defaultExport } = await loadExtension(getUsageMock);
    defaultExport(pi as never);
    const cmd = pi.commands.get("usage")!;
    const ctx = makeCtx("anthropic", true, [
      { provider: "openai-codex", id: "c1" },
      { provider: "opencode", id: "o1" },
    ]);
    await cmd.handler("", ctx);
    expect(getUsageMock).toHaveBeenCalledTimes(2);
    const notified = ctx.ui.notify.mock.calls[0][0] as string;
    expect(notified).toContain("Codex");
    expect(notified).toContain("Opencode");
  });

  it("shows missing-auth message for Opencode when config is invalid", async () => {
    const getUsageMock = vi.fn(async () => ({
      provider: "opencode" as const,
      fetchedAt: Date.now(),
      error:
        "Opencode credentials not configured. Run /usage auth to set them up.",
    }));
    const { pi, defaultExport } = await loadExtension(getUsageMock);
    defaultExport(pi as never);
    const cmd = pi.commands.get("usage")!;
    const ctx = makeCtx("anthropic", true, [
      { provider: "opencode", id: "o1" },
    ]);
    await cmd.handler("", ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Run /usage auth"),
      "info",
    );
  });
});
