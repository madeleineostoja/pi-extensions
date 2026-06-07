import { describe, it, expect } from "vitest";
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolCallEvent,
} from "@earendil-works/pi-coding-agent";
import { decideToolCall, resolveChoice } from "./handler";
import registerExtension from "./index";

const DECLINED_NO_FEEDBACK =
  "Edit not applied. User declined without feedback. Ask for clarification before retrying.";

type TestEventBus = ExtensionAPI["events"];
type ToolCallHandler = (
  event: ToolCallEvent,
  ctx: ExtensionContext,
) => Promise<unknown>;

function makeTestEventBus(): TestEventBus {
  const handlers = new Map<string, Array<(data: unknown) => void>>();
  return {
    emit(channel: string, data: unknown) {
      for (const handler of handlers.get(channel) ?? []) {
        handler(data);
      }
    },
    on(channel: string, handler: (data: unknown) => void) {
      const list = handlers.get(channel) ?? [];
      list.push(handler);
      handlers.set(channel, list);
      return () => {
        const next = (handlers.get(channel) ?? []).filter(
          (item) => item !== handler,
        );
        handlers.set(channel, next);
      };
    },
  };
}

function makeDummyTheme(): { fg: (color: string, text: string) => string } {
  return { fg: (_color: string, text: string) => text };
}

function makeThemeSpy(): {
  theme: { fg: (color: string, text: string) => string };
  calls: Array<{ color: string; text: string }>;
} {
  const calls: Array<{ color: string; text: string }> = [];
  return {
    theme: {
      fg: (color: string, text: string) => {
        calls.push({ color, text });
        return `<${color}>${text}</${color}>`;
      },
    },
    calls,
  };
}

function makeToolCallCtx(
  overrides: Partial<{
    selectResult: string | undefined | (() => Promise<string | undefined>);
    inputResult: string | undefined | (() => Promise<string | undefined>);
  }>,
): ExtensionContext {
  return {
    mode: "tui",
    signal: undefined,
    ui: {
      select:
        typeof overrides.selectResult === "function"
          ? overrides.selectResult
          : () => Promise.resolve(overrides.selectResult as string | undefined),
      input:
        typeof overrides.inputResult === "function"
          ? overrides.inputResult
          : () => Promise.resolve(overrides.inputResult as string | undefined),
      setStatus: () => {},
      notify: () => {},
      confirm: () => Promise.resolve(false),
      onTerminalInput: () => () => {},
      setWorkingMessage: () => {},
      setWorkingVisible: () => {},
      setWorkingIndicator: () => {},
      setHiddenThinkingLabel: () => {},
      setWidget: () => {},
      setFooter: () => {},
      setHeader: () => {},
      setTitle: () => {},
      custom: () => Promise.resolve(undefined as never),
      pasteToEditor: () => {},
      setEditorText: () => {},
      getEditorText: () => "",
      editor: () => Promise.resolve(undefined),
      addAutocompleteProvider: () => {},
      setEditorComponent: () => {},
      getEditorComponent: () => undefined,
      get theme() {
        return makeDummyTheme() as never;
      },
      getAllThemes: () => [],
      getTheme: () => undefined,
      setTheme: () => ({ success: true }),
      getToolsExpanded: () => false,
      setToolsExpanded: () => {},
    },
    cwd: "/",
    sessionManager: {} as never,
    modelRegistry: {} as never,
    model: undefined,
    isIdle: () => true,
    abort: () => {},
    hasPendingMessages: () => false,
    shutdown: () => {},
    getContextUsage: () => undefined,
    compact: () => {},
    getSystemPrompt: () => "",
  } as unknown as ExtensionContext;
}

function captureToolCallHandler() {
  let toolCallHandler: ToolCallHandler | undefined;

  const pi = {
    on(event: string, handler: (e: never, ctx: never) => Promise<unknown>) {
      if (event === "tool_call") {
        toolCallHandler = handler as unknown as typeof toolCallHandler;
      }
    },
    registerShortcut: () => {},
    registerCommand: () => {},
    registerTool: () => {},
    registerFlag: () => {},
    getFlag: () => undefined,
    registerMessageRenderer: () => {},
    sendMessage: () => {},
    sendUserMessage: () => {},
    appendEntry: () => {},
    setSessionName: () => {},
    getSessionName: () => undefined,
    setLabel: () => {},
    getActiveTools: () => [],
    getAllTools: () => [],
    setActiveTools: () => {},
    getCommands: () => [],
    setModel: () => Promise.resolve(false),
    getThinkingLevel: () => 0 as never,
    setThinkingLevel: () => {},
    exec: () =>
      Promise.resolve({ code: 0, stdout: "", stderr: "", killed: false }),
    registerProvider: () => {},
    unregisterProvider: () => {},
    events: makeTestEventBus(),
  } as unknown as ExtensionAPI;

  registerExtension(pi);

  if (!toolCallHandler) {
    throw new Error("tool_call handler was not registered");
  }
  return toolCallHandler;
}

function makeEditEvent(input: Record<string, unknown> = {}): ToolCallEvent {
  return {
    type: "tool_call",
    toolCallId: "test-1",
    toolName: "edit",
    input: input as never,
  } as ToolCallEvent;
}

const TRIGGER_TOOLS = new Set(["edit", "write"]);

describe("decideToolCall", () => {
  describe("readonlyMode=false", () => {
    it("passes when readonly is off, tool in set, TUI mode", () => {
      expect(
        decideToolCall({
          readonlyMode: false,
          mode: "tui",
          toolName: "edit",
          triggerTools: TRIGGER_TOOLS,
        }),
      ).toBe("pass");
    });
  });

  describe("readonlyMode=true, tool NOT in trigger set", () => {
    it("passes when tool is not in set, TUI mode", () => {
      expect(
        decideToolCall({
          readonlyMode: true,
          mode: "tui",
          toolName: "bash",
          triggerTools: TRIGGER_TOOLS,
        }),
      ).toBe("pass");
    });
  });

  describe("readonlyMode=true, tool IN trigger set", () => {
    it("prompts when tool is 'edit' and TUI mode", () => {
      expect(
        decideToolCall({
          readonlyMode: true,
          mode: "tui",
          toolName: "edit",
          triggerTools: TRIGGER_TOOLS,
        }),
      ).toBe("prompt");
    });

    it("prompts when tool is 'write' and TUI mode", () => {
      expect(
        decideToolCall({
          readonlyMode: true,
          mode: "tui",
          toolName: "write",
          triggerTools: TRIGGER_TOOLS,
        }),
      ).toBe("prompt");
    });

    it("auto-disables when tool is 'edit' and non-TUI mode", () => {
      expect(
        decideToolCall({
          readonlyMode: true,
          mode: "rpc",
          toolName: "edit",
          triggerTools: TRIGGER_TOOLS,
        }),
      ).toBe("auto-disable");
    });

    it("auto-disables when tool is 'write' and non-TUI mode", () => {
      expect(
        decideToolCall({
          readonlyMode: true,
          mode: "rpc",
          toolName: "write",
          triggerTools: TRIGGER_TOOLS,
        }),
      ).toBe("auto-disable");
    });
  });
});

describe("resolveChoice", () => {
  it('"Accept for this session" returns not blocked with setEditing side effect', () => {
    expect(
      resolveChoice({ choice: "Accept for this session", message: undefined }),
    ).toEqual({
      block: false,
      sideEffect: "setEditing",
    });
  });

  it('"Steer" with a message returns blocked with formatted reason', () => {
    const result = resolveChoice({
      choice: "Steer",
      message: "use a class not a function",
    });
    expect(result.block).toBe(true);
    expect(result.reason).toBe(
      "Edit not applied. User intercepted the proposed change and provided this feedback:\n\nuse a class not a function\n\nTake this into account. Incorporate this feedback before retrying.",
    );
    expect(result.sideEffect).toBeUndefined();
  });

  it('"Steer" with empty message returns blocked with declined-without-feedback reason', () => {
    const result = resolveChoice({ choice: "Steer", message: "" });
    expect(result.block).toBe(true);
    expect(result.reason).toBe(
      "Edit not applied. User declined without feedback. Ask for clarification before retrying.",
    );
  });
});

describe("tool_call handler (integration)", () => {
  it("Steer chosen + input returns undefined → blocking result with declined-without-feedback reason", async () => {
    const handler = captureToolCallHandler();
    const ctx = makeToolCallCtx({
      selectResult: "Steer",
      inputResult: undefined,
    });
    const result = await handler(makeEditEvent(), ctx);
    expect(result).toEqual({ block: true, reason: DECLINED_NO_FEEDBACK });
  });

  it("AbortError from select dialog → blocking result, does not throw", async () => {
    const handler = captureToolCallHandler();
    const abortError = Object.assign(new Error("Aborted"), {
      name: "AbortError",
    });
    const ctx = makeToolCallCtx({
      selectResult: () => Promise.reject(abortError),
    });
    const result = await handler(makeEditEvent(), ctx);
    expect(result).toEqual({ block: true, reason: DECLINED_NO_FEEDBACK });
  });

  it("AbortError from input dialog → blocking result, does not throw", async () => {
    const handler = captureToolCallHandler();
    const abortError = Object.assign(new Error("Aborted"), {
      name: "AbortError",
    });
    const ctx = makeToolCallCtx({
      selectResult: "Steer",
      inputResult: () => Promise.reject(abortError),
    });
    const result = await handler(makeEditEvent(), ctx);
    expect(result).toEqual({ block: true, reason: DECLINED_NO_FEEDBACK });
  });

  it("non-AbortError from select dialog → re-throws", async () => {
    const handler = captureToolCallHandler();
    const boom = new Error("unexpected");
    const ctx = makeToolCallCtx({
      selectResult: () => Promise.reject(boom),
    });
    await expect(handler(makeEditEvent(), ctx)).rejects.toThrow("unexpected");
  });
});

type AnyHandler = (event: never, ctx: ExtensionContext) => Promise<unknown>;
type CustomMessageInput = Parameters<ExtensionAPI["sendMessage"]>[0];

function captureHandlers() {
  let toolCallHandler: AnyHandler | undefined;
  let sessionStartHandler: AnyHandler | undefined;
  const messageCalls: CustomMessageInput[] = [];

  const pi = {
    on(event: string, handler: AnyHandler) {
      if (event === "tool_call") {
        toolCallHandler = handler;
      }
      if (event === "session_start") {
        sessionStartHandler = handler;
      }
    },
    registerShortcut: () => {},
    registerCommand: () => {},
    registerTool: () => {},
    registerFlag: () => {},
    getFlag: () => undefined,
    registerMessageRenderer: () => {},
    sendMessage: (message: CustomMessageInput) => {
      messageCalls.push(message);
    },
    sendUserMessage: () => {},
    appendEntry: () => {},
    setSessionName: () => {},
    getSessionName: () => undefined,
    setLabel: () => {},
    getActiveTools: () => [],
    getAllTools: () => [],
    setActiveTools: () => {},
    getCommands: () => [],
    setModel: () => Promise.resolve(false),
    getThinkingLevel: () => 0 as never,
    setThinkingLevel: () => {},
    exec: () =>
      Promise.resolve({ code: 0, stdout: "", stderr: "", killed: false }),
    registerProvider: () => {},
    unregisterProvider: () => {},
    events: makeTestEventBus(),
  } as unknown as ExtensionAPI;

  registerExtension(pi);

  if (!toolCallHandler) {
    throw new Error("tool_call handler was not registered");
  }
  if (!sessionStartHandler) {
    throw new Error("session_start handler was not registered");
  }
  return { toolCallHandler, sessionStartHandler, messageCalls };
}

function makeNonInteractiveCtx(): ExtensionContext & { notifyCalls: string[] } {
  const notifyCalls: string[] = [];
  return {
    mode: "rpc",
    signal: undefined,
    ui: {
      select: () => Promise.resolve(undefined),
      input: () => Promise.resolve(undefined),
      setStatus: () => {},
      notify: (message: string) => {
        notifyCalls.push(message);
      },
      confirm: () => Promise.resolve(false),
      onTerminalInput: () => () => {},
      setWorkingMessage: () => {},
      setWorkingVisible: () => {},
      setWorkingIndicator: () => {},
      setHiddenThinkingLabel: () => {},
      setWidget: () => {},
      setFooter: () => {},
      setHeader: () => {},
      setTitle: () => {},
      custom: () => Promise.resolve(undefined as never),
      pasteToEditor: () => {},
      setEditorText: () => {},
      getEditorText: () => "",
      editor: () => Promise.resolve(undefined),
      addAutocompleteProvider: () => {},
      setEditorComponent: () => {},
      getEditorComponent: () => undefined,
      get theme() {
        return makeDummyTheme() as never;
      },
      getAllThemes: () => [],
      getTheme: () => undefined,
      setTheme: () => ({ success: true }),
      getToolsExpanded: () => false,
      setToolsExpanded: () => {},
    },
    cwd: "/",
    sessionManager: {} as never,
    modelRegistry: {} as never,
    model: undefined,
    isIdle: () => true,
    abort: () => {},
    hasPendingMessages: () => false,
    shutdown: () => {},
    getContextUsage: () => undefined,
    compact: () => {},
    getSystemPrompt: () => "",
    notifyCalls,
  } as unknown as ExtensionContext & { notifyCalls: string[] };
}

import type { SessionStartEvent } from "@earendil-works/pi-coding-agent";

function makeSessionStartEvent(): SessionStartEvent {
  return { type: "session_start", reason: "startup" };
}

describe("non-interactive mode (tool_call handler)", () => {
  it("tool_call with mode=rpc → returns undefined, disables readonly, logs status once", async () => {
    const { toolCallHandler, messageCalls } = captureHandlers();
    const ctx = makeNonInteractiveCtx();

    const result = await toolCallHandler(makeEditEvent() as never, ctx);

    expect(result).toBeUndefined();
    expect(ctx.notifyCalls).toHaveLength(0);
    expect(messageCalls).toHaveLength(1);
    expect(messageCalls[0]?.customType).toBe("pi-readonly.status");
    expect(messageCalls[0]?.display).toBe(true);
    expect(messageCalls[0]?.content).toMatch(/readonly mode auto-disabled/);
    expect(messageCalls[0]?.content).toMatch(/no interactive UI/);
  });

  it("second tool_call with mode=rpc does not re-log", async () => {
    const { toolCallHandler, messageCalls } = captureHandlers();
    const ctx = makeNonInteractiveCtx();

    await toolCallHandler(makeEditEvent() as never, ctx);
    const messageCountAfterFirst = messageCalls.length;

    await toolCallHandler(makeEditEvent() as never, ctx);

    expect(messageCalls).toHaveLength(messageCountAfterFirst);
  });

  it("tool_call with mode=tui still prompts (interactive behavior unchanged)", async () => {
    const { toolCallHandler } = captureHandlers();
    const ctx = makeToolCallCtx({ selectResult: "Accept" });

    const result = await toolCallHandler(makeEditEvent() as never, ctx);

    expect(result).toBeUndefined();
  });

  it("session_start with mode=rpc auto-disables and logs once", async () => {
    const { sessionStartHandler, toolCallHandler, messageCalls } =
      captureHandlers();
    const ctx = makeNonInteractiveCtx();

    await sessionStartHandler(makeSessionStartEvent() as never, ctx);

    expect(ctx.notifyCalls).toHaveLength(0);
    expect(messageCalls).toHaveLength(1);
    expect(messageCalls[0]?.content).toMatch(/readonly mode auto-disabled/);

    const result = await toolCallHandler(makeEditEvent() as never, ctx);
    expect(result).toBeUndefined();
    expect(messageCalls).toHaveLength(1);
  });
});

function makeInteractiveCtx(): ExtensionContext & {
  statusCalls: Array<{ key: string; value: string | undefined }>;
  themeCalls: Array<{ color: string; text: string }>;
} {
  const statusCalls: Array<{ key: string; value: string | undefined }> = [];
  const { theme, calls: themeCalls } = makeThemeSpy();
  return {
    mode: "tui",
    signal: undefined,
    ui: {
      select: () => Promise.resolve("Accept"),
      input: () => Promise.resolve(undefined),
      setStatus: (key: string, value: string | undefined) => {
        statusCalls.push({ key, value });
      },
      notify: () => {},
      confirm: () => Promise.resolve(false),
      onTerminalInput: () => () => {},
      setWorkingMessage: () => {},
      setWorkingVisible: () => {},
      setWorkingIndicator: () => {},
      setHiddenThinkingLabel: () => {},
      setWidget: () => {},
      setFooter: () => {},
      setHeader: () => {},
      setTitle: () => {},
      custom: () => Promise.resolve(undefined as never),
      pasteToEditor: () => {},
      setEditorText: () => {},
      getEditorText: () => "",
      editor: () => Promise.resolve(undefined),
      addAutocompleteProvider: () => {},
      setEditorComponent: () => {},
      getEditorComponent: () => undefined,
      get theme() {
        return theme as never;
      },
      getAllThemes: () => [],
      getTheme: () => undefined,
      setTheme: () => ({ success: true }),
      getToolsExpanded: () => false,
      setToolsExpanded: () => {},
    },
    cwd: "/",
    sessionManager: {} as never,
    modelRegistry: {} as never,
    model: undefined,
    isIdle: () => true,
    abort: () => {},
    hasPendingMessages: () => false,
    shutdown: () => {},
    getContextUsage: () => undefined,
    compact: () => {},
    getSystemPrompt: () => "",
    statusCalls,
    themeCalls,
  } as unknown as ExtensionContext & {
    statusCalls: Array<{ key: string; value: string | undefined }>;
    themeCalls: Array<{ color: string; text: string }>;
  };
}

const FOOTER_KEY = "pi-readonly.mode";

describe("session_start reason handling", () => {
  it('reason "startup" enables readonly and sets footer', async () => {
    const { sessionStartHandler } = captureHandlers();
    const ctx = makeInteractiveCtx();

    await sessionStartHandler(
      { type: "session_start", reason: "startup" } as never,
      ctx,
    );

    const lastStatus = ctx.statusCalls.at(-1);
    expect(lastStatus?.key).toBe(FOOTER_KEY);
    expect(lastStatus?.value).toContain("󰏯");
    expect(lastStatus?.value).toContain("readonly");
    expect(ctx.themeCalls).toContainEqual({ color: "success", text: "󰏯" });
    expect(ctx.themeCalls).toContainEqual({ color: "muted", text: "readonly" });
  });

  it('reason "resume" does not call applyMode(true): readonly remains off if previously disabled', async () => {
    const { sessionStartHandler, toolCallHandler } = captureHandlers();
    const acceptCtx = makeToolCallCtx({
      selectResult: "Accept for this session",
    });

    await toolCallHandler(makeEditEvent() as never, acceptCtx);

    const resumeCtx = makeInteractiveCtx();
    await sessionStartHandler(
      { type: "session_start", reason: "resume" } as never,
      resumeCtx,
    );

    const lastStatus = resumeCtx.statusCalls.at(-1);
    expect(lastStatus?.key).toBe(FOOTER_KEY);
    expect(lastStatus?.value).toContain("editing");
    expect(lastStatus?.value).toContain("󰏫");
  });
});

type CommandHandler = (args: string, ctx: ExtensionContext) => Promise<void>;
type ShortcutHandler = (ctx: ExtensionContext) => Promise<void>;

function makeRegistrationPi(params: {
  eventBus?: TestEventBus;
  commandHandlers?: CommandHandler[];
  shortcutHandlers?: ShortcutHandler[];
  toolCallHandlers?: ToolCallHandler[];
}) {
  const eventBus = params.eventBus ?? makeTestEventBus();
  return {
    on(event: string, handler: ToolCallHandler) {
      if (event === "tool_call") {
        params.toolCallHandlers?.push(handler);
      }
    },
    registerShortcut(name: string, opts: { handler: ShortcutHandler }) {
      if (name === "alt+r") {
        params.shortcutHandlers?.push(opts.handler);
      }
    },
    registerCommand(name: string, opts: { handler: CommandHandler }) {
      if (name === "readonly") {
        params.commandHandlers?.push(opts.handler);
      }
    },
    registerTool: () => {},
    registerFlag: () => {},
    getFlag: () => undefined,
    registerMessageRenderer: () => {},
    sendMessage: () => {},
    sendUserMessage: () => {},
    appendEntry: () => {},
    setSessionName: () => {},
    getSessionName: () => undefined,
    setLabel: () => {},
    getActiveTools: () => [],
    getAllTools: () => [],
    setActiveTools: () => {},
    getCommands: () => [],
    setModel: () => Promise.resolve(false),
    getThinkingLevel: () => 0 as never,
    setThinkingLevel: () => {},
    exec: () =>
      Promise.resolve({ code: 0, stdout: "", stderr: "", killed: false }),
    registerProvider: () => {},
    unregisterProvider: () => {},
    events: eventBus,
  } as unknown as ExtensionAPI;
}

function captureCommandAndShortcutHandlers() {
  const commandHandlers: CommandHandler[] = [];
  const shortcutHandlers: ShortcutHandler[] = [];

  registerExtension(makeRegistrationPi({ commandHandlers, shortcutHandlers }));

  const commandHandler = commandHandlers[0];
  const shortcutHandler = shortcutHandlers[0];
  if (!commandHandler) {
    throw new Error("readonly command handler was not registered");
  }
  if (!shortcutHandler) {
    throw new Error("alt+r shortcut handler was not registered");
  }
  return { commandHandler, shortcutHandler };
}

function captureDuplicateReadonlyHandlers() {
  const eventBus = makeTestEventBus();
  const shortcutHandlers: ShortcutHandler[] = [];
  const toolCallHandlers: ToolCallHandler[] = [];

  registerExtension(
    makeRegistrationPi({ eventBus, shortcutHandlers, toolCallHandlers }),
  );
  registerExtension(
    makeRegistrationPi({ eventBus, shortcutHandlers, toolCallHandlers }),
  );

  const shortcutHandler = shortcutHandlers.at(-1);
  if (!shortcutHandler) {
    throw new Error("alt+r shortcut handler was not registered");
  }
  expect(toolCallHandlers).toHaveLength(2);
  return { shortcutHandler, toolCallHandlers };
}

function makeNotifyCapturingCtx(
  _readonlyOn: boolean = true,
): ExtensionContext & {
  notifyCalls: Array<{ message: string; level: string }>;
} {
  const notifyCalls: Array<{ message: string; level: string }> = [];
  return {
    mode: "tui",
    signal: undefined,
    ui: {
      select: () => Promise.resolve("Accept"),
      input: () => Promise.resolve(undefined),
      setStatus: () => {},
      notify: (message: string, level?: "info" | "warning" | "error") => {
        notifyCalls.push({ message, level: level ?? "info" });
      },
      confirm: () => Promise.resolve(false),
      onTerminalInput: () => () => {},
      setWorkingMessage: () => {},
      setWorkingVisible: () => {},
      setWorkingIndicator: () => {},
      setHiddenThinkingLabel: () => {},
      setWidget: () => {},
      setFooter: () => {},
      setHeader: () => {},
      setTitle: () => {},
      custom: () => Promise.resolve(undefined as never),
      pasteToEditor: () => {},
      setEditorText: () => {},
      getEditorText: () => "",
      editor: () => Promise.resolve(undefined),
      addAutocompleteProvider: () => {},
      setEditorComponent: () => {},
      getEditorComponent: () => undefined,
      get theme() {
        return makeDummyTheme() as never;
      },
      getAllThemes: () => [],
      getTheme: () => undefined,
      setTheme: () => ({ success: true }),
      getToolsExpanded: () => false,
      setToolsExpanded: () => {},
    },
    cwd: "/",
    sessionManager: {} as never,
    modelRegistry: {} as never,
    model: undefined,
    isIdle: () => true,
    abort: () => {},
    hasPendingMessages: () => false,
    shutdown: () => {},
    getContextUsage: () => undefined,
    compact: () => {},
    getSystemPrompt: () => "",
    notifyCalls,
  } as unknown as ExtensionContext & {
    notifyCalls: Array<{ message: string; level: string }>;
  };
}

describe("/readonly command notifications", () => {
  it("/readonly (toggle) emits a notification with the new state", async () => {
    const { commandHandler } = captureCommandAndShortcutHandlers();
    const ctx = makeNotifyCapturingCtx();

    await commandHandler("", ctx);

    expect(ctx.notifyCalls).toHaveLength(1);
    expect(ctx.notifyCalls[0].message).toBe("readonly mode: off");
  });

  it("/readonly on when readonly is already on emits no-op notification", async () => {
    const { commandHandler } = captureCommandAndShortcutHandlers();
    const ctx = makeNotifyCapturingCtx();

    await commandHandler("on", ctx);

    expect(ctx.notifyCalls).toHaveLength(1);
    expect(ctx.notifyCalls[0].message).toBe("readonly mode: already on");
  });

  it("/readonly off when readonly is already off emits no-op notification", async () => {
    const { commandHandler } = captureCommandAndShortcutHandlers();
    const ctx = makeNotifyCapturingCtx();

    await commandHandler("off", ctx);
    const notifyCountAfterOff = ctx.notifyCalls.length;
    expect(ctx.notifyCalls.at(-1)?.message).toBe("readonly mode: off");

    await commandHandler("off", ctx);

    expect(ctx.notifyCalls).toHaveLength(notifyCountAfterOff + 1);
    expect(ctx.notifyCalls.at(-1)?.message).toBe("readonly mode: already off");
  });

  it("/readonly on after /readonly off emits action notification", async () => {
    const { commandHandler } = captureCommandAndShortcutHandlers();
    const ctx = makeNotifyCapturingCtx();

    await commandHandler("off", ctx);
    await commandHandler("on", ctx);

    expect(ctx.notifyCalls.at(-1)?.message).toBe("readonly mode: on");
  });
});

describe("alt+r shortcut notifications", () => {
  it("shortcut toggles readonly and does not emit a notification", async () => {
    const { shortcutHandler } = captureCommandAndShortcutHandlers();
    const ctx = makeNotifyCapturingCtx();

    await shortcutHandler(ctx);

    expect(ctx.notifyCalls).toHaveLength(0);
  });

  it("shortcut keeps duplicate readonly registrations in sync", async () => {
    const { shortcutHandler, toolCallHandlers } =
      captureDuplicateReadonlyHandlers();
    const ctx = makeNotifyCapturingCtx();

    await shortcutHandler(ctx);

    for (const toolCallHandler of toolCallHandlers) {
      await expect(
        toolCallHandler(makeEditEvent() as never, makeToolCallCtx({})),
      ).resolves.toBeUndefined();
    }
  });
});
