import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { completeText } from "#lib/complete";
import { registerBtwCommand } from "./command.js";
import { getHistory } from "./state.js";

const completeTextMock = vi.mocked(completeText);

vi.mock("#lib/complete", async () => {
  const actual =
    await vi.importActual<typeof import("#lib/complete")>("#lib/complete");
  return { ...actual, completeText: vi.fn() };
});

function customFixture() {
  let done: (() => void) | undefined;
  let component: Component | undefined;
  const custom = vi.fn((factory) => {
    component = factory(
      {
        terminal: { rows: 24 },
        requestRender: vi.fn(),
      } as unknown as TUI,
      {
        fg: (_tone: string, text: string) => text,
        bold: (text: string) => text,
      } as Theme,
      {},
      () => done?.(),
    );
    return new Promise<void>((resolve) => {
      done = resolve;
    });
  });
  return {
    custom,
    close: () => done?.(),
    get component() {
      return component;
    },
  };
}

function fixture() {
  const commands = new Map<
    string,
    (args: string, ctx: ExtensionCommandContext) => Promise<void>
  >();
  const handlers = new Map<string, () => void>();
  const pi = {
    on: (event: string, handler: () => void) => handlers.set(event, handler),
    registerCommand: (
      name: string,
      command: {
        handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
      },
    ) => commands.set(name, command.handler),
  } as unknown as ExtensionAPI;
  registerBtwCommand(pi);
  return { command: commands.get("btw")!, handlers };
}

let nextSession = 1;

function context(
  custom: ReturnType<typeof customFixture>,
  auth?: Promise<unknown>,
) {
  const notify = vi.fn();
  const sessionKey = `/tmp/btw-session-${nextSession++}.json`;
  return {
    notify,
    sessionKey,
    value: {
      mode: "tui",
      model: {
        provider: "openai",
        id: "test",
        contextWindow: 8_000,
        maxTokens: 2_000,
      },
      ui: { custom: custom.custom, notify },
      modelRegistry: {
        getApiKeyAndHeaders: vi.fn(
          () =>
            auth ?? Promise.resolve({ ok: true, apiKey: "key", headers: {} }),
        ),
      },
      sessionManager: {
        buildSessionContext: () => ({
          messages: [],
          thinkingLevel: "off",
          model: null,
        }),
        getSessionFile: () => sessionKey,
        getSessionId: () => sessionKey,
      },
    } as unknown as ExtensionCommandContext,
  };
}

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await Promise.resolve();
}

beforeEach(() => {
  vi.resetAllMocks();
});

afterEach(() => vi.resetAllMocks());

describe("/btw", () => {
  it("rejects invalid or non-TUI invocations before opening a surface", async () => {
    const { command } = fixture();
    const custom = customFixture();
    const { value, notify } = context(custom);

    await command("", value);
    await command("question", { ...value, mode: "json" });

    expect(custom.custom).not.toHaveBeenCalled();
    expect(notify).toHaveBeenNthCalledWith(
      1,
      "usage: /btw <question>",
      "warning",
    );
    expect(notify).toHaveBeenNthCalledWith(
      2,
      "/btw requires a TUI session",
      "warning",
    );
  });

  it("reports a missing model before opening the panel", async () => {
    const { command } = fixture();
    const custom = customFixture();
    const { value, notify } = context(custom);

    await command("question", { ...value, model: undefined });

    expect(custom.custom).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(
      "No active model. Set a model first.",
      "warning",
    );
  });

  it("shows authentication failures in the panel", async () => {
    const { command } = fixture();
    const custom = customFixture();
    const { value } = context(
      custom,
      Promise.resolve({ ok: false, error: "credentials unavailable" }),
    );

    const running = command("question", value);
    await flush();

    expect(
      custom.component
        ?.render(80)
        .some((line) => line.includes("credentials unavailable")),
    ).toBe(true);
    custom.close();
    await running;
    expect(completeTextMock).not.toHaveBeenCalled();
  });

  it("shows the panel before deferred authentication and completion", async () => {
    const { command } = fixture();
    const custom = customFixture();
    let resolveAuth: (value: unknown) => void = () => {};
    const auth = new Promise((resolve) => {
      resolveAuth = resolve;
    });
    const { value } = context(custom, auth);

    const running = command("question", value);
    expect(
      custom.component?.render(80).some((line) => line.includes("thinking")),
    ).toBe(true);
    expect(value.modelRegistry.getApiKeyAndHeaders).not.toHaveBeenCalled();

    await flush();
    expect(value.modelRegistry.getApiKeyAndHeaders).toHaveBeenCalledOnce();
    resolveAuth({ ok: true, apiKey: "key", headers: {} });
    completeTextMock.mockResolvedValue({
      ok: true,
      text: "answer",
      stopReason: "stop",
    } as never);
    await flush();
    custom.close();
    await running;

    expect(completeTextMock).toHaveBeenCalledOnce();
    expect(completeTextMock).toHaveBeenCalledWith(
      value.model,
      expect.anything(),
      expect.objectContaining({ maxTokens: 1_024 }),
    );
  });

  it("keeps successful exchanges only in the session-keyed side thread", async () => {
    const { command } = fixture();
    const custom = customFixture();
    const { value, sessionKey } = context(custom);
    completeTextMock.mockResolvedValue({
      ok: true,
      text: "answer",
      stopReason: "stop",
    } as never);

    const running = command("question", value);
    await flush();
    await flush();
    custom.close();
    await running;

    expect(getHistory(sessionKey)).toEqual([
      { question: "question", answer: "answer" },
    ]);
  });

  it("cancels and rejects stale completion after session replacement", async () => {
    const { command, handlers } = fixture();
    const custom = customFixture();
    const { value, sessionKey } = context(custom);
    let resolveCompletion: (value: any) => void = () => {};
    completeTextMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveCompletion = resolve;
        }),
    );

    const running = command("question", value);
    await flush();
    handlers.get("session_start")?.();
    resolveCompletion({ ok: true, text: "stale", stopReason: "stop" });
    await running;

    expect(getHistory(sessionKey)).toEqual([]);
    expect(
      custom.component?.render(80).some((line) => line.includes("stale")),
    ).toBe(false);
  });

  it("cancels and rejects stale completion after session shutdown", async () => {
    const { command, handlers } = fixture();
    const custom = customFixture();
    const { value, sessionKey } = context(custom);
    let resolveCompletion: (value: any) => void = () => {};
    completeTextMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveCompletion = resolve;
        }),
    );

    const running = command("question", value);
    await flush();
    handlers.get("session_shutdown")?.();
    resolveCompletion({ ok: true, text: "stale", stopReason: "stop" });
    await running;

    expect(getHistory(sessionKey)).toEqual([]);
    expect(
      custom.component?.render(80).some((line) => line.includes("stale")),
    ).toBe(false);
  });
});
