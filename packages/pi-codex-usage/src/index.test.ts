import { describe, it, expect, afterEach, vi } from "vitest";
import type { UsageSnapshot } from "./usage.js";
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

type FakeCtx = {
  hasUI: boolean;
  model: { provider: string; id: string; name?: string } | null;
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
    getApiKeyAndHeaders: () => Promise<{ ok: false; error: string }>;
  };
};

function makeCtx(provider = "openai-codex", hasUI = true): FakeCtx {
  return {
    hasUI,
    model: { provider, id: "model-1" },
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
      getApiKeyAndHeaders: async () => ({ ok: false, error: "no auth" }),
    },
  };
}

async function loadExtension(
  getUsageMock: (...args: unknown[]) => Promise<UsageSnapshot | null>,
): Promise<{ pi: FakePi; defaultExport: (pi: FakePi) => void }> {
  vi.resetModules();
  vi.doMock("./usage.js", async (importOriginal) => {
    const actual = (await importOriginal()) as Record<string, unknown>;
    return {
      ...actual,
      getUsage: getUsageMock,
    };
  });
  const mod = await import("./index.js");
  return {
    pi: makePi(),
    defaultExport: mod.default as unknown as (pi: FakePi) => void,
  };
}

const fakeSnapshot: UsageSnapshot = {
  fiveHour: { usedPercent: 42 },
  weekly: { usedPercent: 71 },
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

  it("clears status after session_start with non-Codex model", async () => {
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

  it("clears status after model_select switches away from Codex", async () => {
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

  it("does not call setStatus when hasUI is false", async () => {
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
    const ctx = makeCtx("anthropic");
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

  it("registers the codex-usage command", async () => {
    const { pi, defaultExport } = await loadExtension(async () => fakeSnapshot);
    defaultExport(pi as never);
    expect(pi.commands.has("codex-usage")).toBe(true);
  });

  it("command handler notifies info when Codex model is active and usage is fetched", async () => {
    const getUsageMock = vi.fn(async () => fakeSnapshot);
    const { pi, defaultExport } = await loadExtension(getUsageMock);
    defaultExport(pi as never);
    const cmd = pi.commands.get("codex-usage")!;
    const ctx = makeCtx("openai-codex");
    await cmd.handler("", ctx);
    expect(getUsageMock).toHaveBeenCalledWith(ctx.model, ctx, true);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Codex 5h window"),
      "info",
    );
  });

  it("command handler warns when no Codex model is active", async () => {
    const getUsageMock = vi.fn(async () => fakeSnapshot);
    const { pi, defaultExport } = await loadExtension(getUsageMock);
    defaultExport(pi as never);
    const cmd = pi.commands.get("codex-usage")!;
    const ctx = makeCtx("anthropic");
    await cmd.handler("", ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "No Codex model is active.",
      "warning",
    );
  });

  it("command handler does nothing when hasUI is false", async () => {
    const getUsageMock = vi.fn(async () => fakeSnapshot);
    const { pi, defaultExport } = await loadExtension(getUsageMock);
    defaultExport(pi as never);
    const cmd = pi.commands.get("codex-usage")!;
    const ctx = makeCtx("openai-codex", false);
    await cmd.handler("", ctx);
    expect(ctx.ui.notify).not.toHaveBeenCalled();
  });
});
