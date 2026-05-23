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

function makeToolCallCtx(
  overrides: Partial<{
    selectResult: string | undefined | (() => Promise<string | undefined>);
    inputResult: string | undefined | (() => Promise<string | undefined>);
  }>,
): ExtensionContext {
  return {
    hasUI: true,
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
        return {} as never;
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
  };
}

function captureToolCallHandler() {
  let toolCallHandler:
    | ((event: ToolCallEvent, ctx: ExtensionContext) => Promise<unknown>)
    | undefined;

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
    events: {} as never,
  } as unknown as ExtensionAPI;

  registerExtension(pi);

  if (!toolCallHandler) throw new Error("tool_call handler was not registered");
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
  describe("guardMode=false", () => {
    it("passes when guard is off, tool in set, has UI", () => {
      expect(
        decideToolCall({
          guardMode: false,
          hasUI: true,
          toolName: "edit",
          triggerTools: TRIGGER_TOOLS,
          nonInteractiveAlreadyNotified: false,
        }),
      ).toBe("pass");
    });

    it("passes when guard is off, tool in set, no UI", () => {
      expect(
        decideToolCall({
          guardMode: false,
          hasUI: false,
          toolName: "edit",
          triggerTools: TRIGGER_TOOLS,
          nonInteractiveAlreadyNotified: false,
        }),
      ).toBe("pass");
    });

    it("passes when guard is off, tool not in set, has UI", () => {
      expect(
        decideToolCall({
          guardMode: false,
          hasUI: true,
          toolName: "bash",
          triggerTools: TRIGGER_TOOLS,
          nonInteractiveAlreadyNotified: false,
        }),
      ).toBe("pass");
    });

    it("passes when guard is off, tool not in set, no UI", () => {
      expect(
        decideToolCall({
          guardMode: false,
          hasUI: false,
          toolName: "bash",
          triggerTools: TRIGGER_TOOLS,
          nonInteractiveAlreadyNotified: false,
        }),
      ).toBe("pass");
    });
  });

  describe("guardMode=true, tool NOT in trigger set", () => {
    it("passes when tool is not in set, has UI", () => {
      expect(
        decideToolCall({
          guardMode: true,
          hasUI: true,
          toolName: "bash",
          triggerTools: TRIGGER_TOOLS,
          nonInteractiveAlreadyNotified: false,
        }),
      ).toBe("pass");
    });

    it("passes when tool is not in set, no UI", () => {
      expect(
        decideToolCall({
          guardMode: true,
          hasUI: false,
          toolName: "bash",
          triggerTools: TRIGGER_TOOLS,
          nonInteractiveAlreadyNotified: false,
        }),
      ).toBe("pass");
    });
  });

  describe("guardMode=true, tool IN trigger set", () => {
    it("prompts when tool is 'edit' and has UI", () => {
      expect(
        decideToolCall({
          guardMode: true,
          hasUI: true,
          toolName: "edit",
          triggerTools: TRIGGER_TOOLS,
          nonInteractiveAlreadyNotified: false,
        }),
      ).toBe("prompt");
    });

    it("prompts when tool is 'write' and has UI", () => {
      expect(
        decideToolCall({
          guardMode: true,
          hasUI: true,
          toolName: "write",
          triggerTools: TRIGGER_TOOLS,
          nonInteractiveAlreadyNotified: false,
        }),
      ).toBe("prompt");
    });

    it("auto-disables when tool is 'edit' and no UI", () => {
      expect(
        decideToolCall({
          guardMode: true,
          hasUI: false,
          toolName: "edit",
          triggerTools: TRIGGER_TOOLS,
          nonInteractiveAlreadyNotified: false,
        }),
      ).toBe("auto-disable");
    });

    it("auto-disables when tool is 'write' and no UI", () => {
      expect(
        decideToolCall({
          guardMode: true,
          hasUI: false,
          toolName: "write",
          triggerTools: TRIGGER_TOOLS,
          nonInteractiveAlreadyNotified: false,
        }),
      ).toBe("auto-disable");
    });
  });

  it("passes for a tool that is not in an empty trigger set", () => {
    expect(
      decideToolCall({
        guardMode: true,
        hasUI: true,
        toolName: "edit",
        triggerTools: new Set(),
        nonInteractiveAlreadyNotified: false,
      }),
    ).toBe("pass");
  });
});

describe("resolveChoice", () => {
  it('"Accept" returns not blocked, no side effect', () => {
    expect(resolveChoice({ choice: "Accept", message: undefined })).toEqual({
      block: false,
    });
  });

  it('"Accept and stop guarding" returns not blocked with disable side effect', () => {
    expect(
      resolveChoice({ choice: "Accept and stop guarding", message: undefined }),
    ).toEqual({
      block: false,
      sideEffect: "disable",
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

  it("undefined (Esc/cancel) returns blocked with declined-without-feedback reason", () => {
    const result = resolveChoice({ choice: undefined, message: undefined });
    expect(result.block).toBe(true);
    expect(result.reason).toBe(
      "Edit not applied. User declined without feedback. Ask for clarification before retrying.",
    );
  });

  it("unexpected string returns blocked with declined-without-feedback reason", () => {
    const result = resolveChoice({
      choice: "some-unknown-value",
      message: undefined,
    });
    expect(result.block).toBe(true);
    expect(result.reason).toBe(
      "Edit not applied. User declined without feedback. Ask for clarification before retrying.",
    );
  });
});

function makeCapturingCtx(
  selectResult: string | undefined,
): ExtensionContext & {
  selectCalls: Array<{ title: string }>;
  inputCalls: Array<{ title: string }>;
} {
  const selectCalls: Array<{ title: string }> = [];
  const inputCalls: Array<{ title: string }> = [];
  return {
    hasUI: true,
    signal: undefined,
    ui: {
      select: (title: string) => {
        selectCalls.push({ title });
        return Promise.resolve(selectResult);
      },
      input: (title: string) => {
        inputCalls.push({ title });
        return Promise.resolve(undefined);
      },
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
        return {} as never;
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
    selectCalls,
    inputCalls,
  };
}

describe("modal title construction (integration)", () => {
  it("modal title includes path when event.input.path is set", async () => {
    const handler = captureToolCallHandler();
    const ctx = makeCapturingCtx("Accept");
    await handler(makeEditEvent({ path: "src/foo.ts" }), ctx);
    expect(ctx.selectCalls[0].title).toBe("Guard: edit src/foo.ts — apply?");
  });

  it("modal title falls back to tool name only when event.input has no path", async () => {
    const handler = captureToolCallHandler();
    const ctx = makeCapturingCtx("Accept");
    await handler(makeEditEvent({}), ctx);
    expect(ctx.selectCalls[0].title).toBe("Guard: edit — apply?");
  });

  it("modal title does not contain 'undefined' when path is absent", async () => {
    const handler = captureToolCallHandler();
    const ctx = makeCapturingCtx("Accept");
    await handler(makeEditEvent({}), ctx);
    expect(ctx.selectCalls[0].title).not.toContain("undefined");
    expect(ctx.selectCalls[0].title).not.toContain("null");
  });

  it("Steer input title includes path when event.input.path is set", async () => {
    const handler = captureToolCallHandler();
    const ctx = makeCapturingCtx("Steer");
    await handler(makeEditEvent({ path: "src/foo.ts" }), ctx);
    expect(ctx.inputCalls[0].title).toBe("Steer the agent — src/foo.ts");
  });

  it("Steer input title falls back to generic title when path is absent", async () => {
    const handler = captureToolCallHandler();
    const ctx = makeCapturingCtx("Steer");
    await handler(makeEditEvent({}), ctx);
    expect(ctx.inputCalls[0].title).toBe("Steer the agent");
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

function captureHandlers() {
  let toolCallHandler: AnyHandler | undefined;
  let sessionStartHandler: AnyHandler | undefined;

  const pi = {
    on(event: string, handler: AnyHandler) {
      if (event === "tool_call") toolCallHandler = handler;
      if (event === "session_start") sessionStartHandler = handler;
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
    events: {} as never,
  } as unknown as ExtensionAPI;

  registerExtension(pi);

  if (!toolCallHandler) throw new Error("tool_call handler was not registered");
  if (!sessionStartHandler)
    throw new Error("session_start handler was not registered");
  return { toolCallHandler, sessionStartHandler };
}

function makeNonInteractiveCtx(): ExtensionContext & { notifyCalls: string[] } {
  const notifyCalls: string[] = [];
  return {
    hasUI: false,
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
        return {} as never;
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
  };
}

import type { SessionStartEvent } from "@earendil-works/pi-coding-agent";

function makeSessionStartEvent(): SessionStartEvent {
  return { type: "session_start", reason: "startup" };
}

describe("non-interactive mode (tool_call handler)", () => {
  it("tool_call with hasUI=false → returns undefined, disables guard, notifies once", async () => {
    const { toolCallHandler } = captureHandlers();
    const ctx = makeNonInteractiveCtx();

    const result = await toolCallHandler(makeEditEvent() as never, ctx);

    expect(result).toBeUndefined();
    expect(ctx.notifyCalls).toHaveLength(1);
    expect(ctx.notifyCalls[0]).toMatch(/guard mode auto-disabled/);
    expect(ctx.notifyCalls[0]).toMatch(/no interactive UI/);
  });

  it("second tool_call with hasUI=false does not re-notify", async () => {
    const { toolCallHandler } = captureHandlers();
    const ctx = makeNonInteractiveCtx();

    await toolCallHandler(makeEditEvent() as never, ctx);
    const notifyCountAfterFirst = ctx.notifyCalls.length;

    await toolCallHandler(makeEditEvent() as never, ctx);

    expect(ctx.notifyCalls).toHaveLength(notifyCountAfterFirst);
  });

  it("tool_call with hasUI=true still prompts (interactive behavior unchanged)", async () => {
    const { toolCallHandler } = captureHandlers();
    const ctx = makeToolCallCtx({ selectResult: "Accept" });

    const result = await toolCallHandler(makeEditEvent() as never, ctx);

    expect(result).toBeUndefined();
  });

  it("session_start with hasUI=false auto-disables and notifies once", async () => {
    const { sessionStartHandler, toolCallHandler } = captureHandlers();
    const ctx = makeNonInteractiveCtx();

    await sessionStartHandler(makeSessionStartEvent() as never, ctx);

    expect(ctx.notifyCalls).toHaveLength(1);
    expect(ctx.notifyCalls[0]).toMatch(/guard mode auto-disabled/);

    const result = await toolCallHandler(makeEditEvent() as never, ctx);
    expect(result).toBeUndefined();
    expect(ctx.notifyCalls).toHaveLength(1);
  });
});

function makeInteractiveCtx(): ExtensionContext & {
  statusCalls: Array<{ key: string; value: string | undefined }>;
} {
  const statusCalls: Array<{ key: string; value: string | undefined }> = [];
  return {
    hasUI: true,
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
        return {} as never;
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
  };
}

const FOOTER_KEY = "pi-guard.active";
const FOOTER_TEXT = "guarding";

describe("session_start reason handling", () => {
  it('reason "startup" enables guard and sets footer', async () => {
    const { sessionStartHandler } = captureHandlers();
    const ctx = makeInteractiveCtx();

    await sessionStartHandler(
      { type: "session_start", reason: "startup" } as never,
      ctx,
    );

    const lastStatus = ctx.statusCalls.at(-1);
    expect(lastStatus?.key).toBe(FOOTER_KEY);
    expect(lastStatus?.value).toBe(FOOTER_TEXT);
  });

  it('reason "new" enables guard and sets footer', async () => {
    const { sessionStartHandler } = captureHandlers();
    const ctx = makeInteractiveCtx();

    await sessionStartHandler(
      { type: "session_start", reason: "new" } as never,
      ctx,
    );

    const lastStatus = ctx.statusCalls.at(-1);
    expect(lastStatus?.key).toBe(FOOTER_KEY);
    expect(lastStatus?.value).toBe(FOOTER_TEXT);
  });

  it('reason "fork" enables guard and sets footer', async () => {
    const { sessionStartHandler } = captureHandlers();
    const ctx = makeInteractiveCtx();

    await sessionStartHandler(
      { type: "session_start", reason: "fork" } as never,
      ctx,
    );

    const lastStatus = ctx.statusCalls.at(-1);
    expect(lastStatus?.key).toBe(FOOTER_KEY);
    expect(lastStatus?.value).toBe(FOOTER_TEXT);
  });

  it('reason "reload" does not call applyMode(true): guard remains off if previously disabled', async () => {
    const { sessionStartHandler, toolCallHandler } = captureHandlers();
    const acceptCtx = makeToolCallCtx({
      selectResult: "Accept and stop guarding",
    });

    await toolCallHandler(makeEditEvent() as never, acceptCtx);

    const reloadCtx = makeInteractiveCtx();
    await sessionStartHandler(
      { type: "session_start", reason: "reload" } as never,
      reloadCtx,
    );

    const lastStatus = reloadCtx.statusCalls.at(-1);
    expect(lastStatus?.key).toBe(FOOTER_KEY);
    expect(lastStatus?.value).toBeUndefined();
  });

  it('reason "resume" does not call applyMode(true): guard remains off if previously disabled', async () => {
    const { sessionStartHandler, toolCallHandler } = captureHandlers();
    const acceptCtx = makeToolCallCtx({
      selectResult: "Accept and stop guarding",
    });

    await toolCallHandler(makeEditEvent() as never, acceptCtx);

    const resumeCtx = makeInteractiveCtx();
    await sessionStartHandler(
      { type: "session_start", reason: "resume" } as never,
      resumeCtx,
    );

    const lastStatus = resumeCtx.statusCalls.at(-1);
    expect(lastStatus?.key).toBe(FOOTER_KEY);
    expect(lastStatus?.value).toBeUndefined();
  });
});

type CommandHandler = (args: string, ctx: ExtensionContext) => Promise<void>;
type ShortcutHandler = (ctx: ExtensionContext) => Promise<void>;

function captureCommandAndShortcutHandlers() {
  let commandHandler: CommandHandler | undefined;
  let shortcutHandler: ShortcutHandler | undefined;

  const pi = {
    on: () => {},
    registerShortcut(name: string, opts: { handler: ShortcutHandler }) {
      if (name === "ctrl+shift+g") shortcutHandler = opts.handler;
    },
    registerCommand(name: string, opts: { handler: CommandHandler }) {
      if (name === "guard") commandHandler = opts.handler;
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
    events: {} as never,
  } as unknown as ExtensionAPI;

  registerExtension(pi);

  if (!commandHandler)
    throw new Error("guard command handler was not registered");
  if (!shortcutHandler)
    throw new Error("ctrl+shift+g shortcut handler was not registered");
  return { commandHandler, shortcutHandler };
}

function makeNotifyCapturingCtx(_guardOn: boolean = true): ExtensionContext & {
  notifyCalls: Array<{ message: string; level: string }>;
} {
  const notifyCalls: Array<{ message: string; level: string }> = [];
  return {
    hasUI: true,
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
        return {} as never;
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
  };
}

describe("/guard command notifications", () => {
  it("/guard (toggle) emits a notification with the new state", async () => {
    const { commandHandler } = captureCommandAndShortcutHandlers();
    const ctx = makeNotifyCapturingCtx();

    await commandHandler("", ctx);

    expect(ctx.notifyCalls).toHaveLength(1);
    expect(ctx.notifyCalls[0].message).toBe("guard mode: off");
  });

  it("/guard on when guard is already on emits no-op notification", async () => {
    const { commandHandler } = captureCommandAndShortcutHandlers();
    const ctx = makeNotifyCapturingCtx();

    await commandHandler("on", ctx);

    expect(ctx.notifyCalls).toHaveLength(1);
    expect(ctx.notifyCalls[0].message).toBe("guard mode: already on");
  });

  it("/guard off when guard is already off emits no-op notification", async () => {
    const { commandHandler } = captureCommandAndShortcutHandlers();
    const ctx = makeNotifyCapturingCtx();

    await commandHandler("off", ctx);
    const notifyCountAfterOff = ctx.notifyCalls.length;
    expect(ctx.notifyCalls.at(-1)?.message).toBe("guard mode: off");

    await commandHandler("off", ctx);

    expect(ctx.notifyCalls).toHaveLength(notifyCountAfterOff + 1);
    expect(ctx.notifyCalls.at(-1)?.message).toBe("guard mode: already off");
  });

  it("/guard on after /guard off emits action notification", async () => {
    const { commandHandler } = captureCommandAndShortcutHandlers();
    const ctx = makeNotifyCapturingCtx();

    await commandHandler("off", ctx);
    await commandHandler("on", ctx);

    expect(ctx.notifyCalls.at(-1)?.message).toBe("guard mode: on");
  });
});

describe("ctrl+shift+g shortcut notifications", () => {
  it("shortcut toggles guard and does not emit a notification", async () => {
    const { shortcutHandler } = captureCommandAndShortcutHandlers();
    const ctx = makeNotifyCapturingCtx();

    await shortcutHandler(ctx);

    expect(ctx.notifyCalls).toHaveLength(0);
  });

  it("shortcut can be invoked multiple times without emitting notifications", async () => {
    const { shortcutHandler } = captureCommandAndShortcutHandlers();
    const ctx = makeNotifyCapturingCtx();

    await shortcutHandler(ctx);
    await shortcutHandler(ctx);
    await shortcutHandler(ctx);

    expect(ctx.notifyCalls).toHaveLength(0);
  });
});
