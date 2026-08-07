import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  initTheme,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { completeText, type CompleteTextResult } from "#lib/complete";
import { registerBtwCommand } from "./command.js";

const completeTextMock = vi.mocked(completeText);

beforeAll(() => initTheme("dark", false));

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
  const sendMessage = vi.fn();
  const pi = {
    on: (event: string, handler: () => void) => handlers.set(event, handler),
    registerCommand: (
      name: string,
      command: {
        handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
      },
    ) => commands.set(name, command.handler),
    sendMessage,
  } as unknown as ExtensionAPI;
  registerBtwCommand(pi);
  return { command: commands.get("btw")!, handlers, sendMessage };
}

function context(
  custom: ReturnType<typeof customFixture>,
  completion?: Promise<unknown>,
) {
  const notify = vi.fn();
  return {
    notify,
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
        complete: vi.fn(
          () =>
            completion ??
            Promise.resolve({
              role: "assistant",
              content: [{ type: "text", text: "answer" }],
              stopReason: "stop",
            }),
        ),
      },
      sessionManager: {
        buildSessionContext: () => ({
          messages: [],
          thinkingLevel: "off",
          model: null,
        }),
      },
    } as unknown as ExtensionCommandContext,
  };
}

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await Promise.resolve();
}

beforeEach(() => vi.resetAllMocks());
afterEach(() => vi.resetAllMocks());

describe("/btw", () => {
  it("rejects invalid, non-TUI, and model-less invocations before opening a surface", async () => {
    const { command } = fixture();
    const custom = customFixture();
    const { value, notify } = context(custom);

    await command("", value);
    await command("question", { ...value, mode: "json" });
    await command("question", { ...value, model: undefined });

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
    expect(notify).toHaveBeenNthCalledWith(
      3,
      "No active model. Set a model first.",
      "warning",
    );
  });

  it("shows registry completion failures in the panel", async () => {
    const { command } = fixture();
    const custom = customFixture();
    const { value } = context(custom);
    completeTextMock.mockResolvedValue({
      ok: false,
      reason: "error",
      message: "credentials unavailable",
    });

    const running = command("question", value);
    await flush();

    expect(
      custom.component
        ?.render(80)
        .some((line) => line.includes("credentials unavailable")),
    ).toBe(true);
    custom.close();
    await running;
    expect(completeTextMock).toHaveBeenCalledOnce();
  });

  it("shows the panel before deferred registry completion", async () => {
    const { command } = fixture();
    const custom = customFixture();
    let resolveCompletion: (value: CompleteTextResult) => void = () => {};
    completeTextMock.mockReturnValue(
      new Promise((resolve) => {
        resolveCompletion = resolve;
      }),
    );
    const { value } = context(custom);

    const running = command("question", value);
    expect(
      custom.component?.render(80).some((line) => line.includes("Thinking")),
    ).toBe(true);
    expect(completeTextMock).not.toHaveBeenCalled();

    await flush();
    expect(completeTextMock).toHaveBeenCalledWith(
      value.model,
      expect.anything(),
      expect.objectContaining({ maxTokens: 1_024 }),
      value.modelRegistry,
    );
    resolveCompletion({
      ok: true,
      text: "answer",
      stopReason: "stop",
    });
    await flush();
    custom.close();
    await running;

    expect(completeTextMock).toHaveBeenCalledWith(
      value.model,
      expect.anything(),
      expect.objectContaining({ maxTokens: 1_024 }),
      value.modelRegistry,
    );
  });

  it("does not thread an earlier side exchange into a later request", async () => {
    const { command } = fixture();
    const custom = customFixture();
    const { value } = context(custom);
    completeTextMock.mockResolvedValue({
      ok: true,
      text: "first answer",
      stopReason: "stop",
    } as never);

    const first = command("first question", value);
    await flush();
    await flush();
    custom.close();
    await first;

    const second = command("second question", value);
    await flush();
    await flush();
    const prompt = completeTextMock.mock.calls[1]?.[1];
    custom.close();
    await second;

    expect(JSON.stringify(prompt)).not.toContain("first question");
    expect(JSON.stringify(prompt)).not.toContain("first answer");
  });

  it("promotes a completed exchange once as non-turn steering", async () => {
    const { command, sendMessage } = fixture();
    const custom = customFixture();
    const { value } = context(custom);
    completeTextMock.mockResolvedValue({
      ok: true,
      text: "**answer**",
      stopReason: "stop",
    } as never);

    const running = command("question", value);
    await flush();
    await flush();
    custom.component?.handleInput?.("s");
    custom.component?.handleInput?.("s");
    await running;

    expect(sendMessage).toHaveBeenCalledOnce();
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        customType: "btw",
        display: true,
        content: expect.stringContaining(
          "Question:\nquestion\n\nAnswer:\n**answer**",
        ),
      }),
      { deliverAs: "steer", triggerTurn: false },
    );
  });

  it("cancels and rejects stale completion after shutdown", async () => {
    const { command, handlers } = fixture();
    const custom = customFixture();
    const { value } = context(custom);
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

    expect(
      custom.component?.render(80).some((line) => line.includes("stale")),
    ).toBe(false);
  });
});
