import { describe, it, expect, vi, beforeEach } from "vitest";
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolCallEvent,
} from "@earendil-works/pi-coding-agent";
import { decideToolCall, resolveChoice } from "./handler";
import { assessBashCommand } from "./assessors";
import registerExtension from "./index";

vi.mock("./assessors", () => ({
  assessBashCommand: vi.fn(),
}));

const GENERIC_BLOCK_REASON =
  "Command blocked by user. Do not retry the same command without addressing the user's concern or asking for clarification.";

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

function makeBashEvent(command: string): ToolCallEvent {
  return {
    type: "tool_call",
    toolCallId: "test-1",
    toolName: "bash",
    input: { command } as never,
  } as ToolCallEvent;
}

describe("decideToolCall", () => {
  describe("guardEnabled=false", () => {
    it("passes when guard is off, tool is bash, has UI", () => {
      expect(
        decideToolCall({ guardEnabled: false, hasUI: true, toolName: "bash" }),
      ).toBe("pass");
    });
  });

  describe("guardEnabled=true, tool NOT bash", () => {
    it("passes when tool is edit", () => {
      expect(
        decideToolCall({ guardEnabled: true, hasUI: true, toolName: "edit" }),
      ).toBe("pass");
    });
  });

  describe("guardEnabled=true, tool IS bash", () => {
    it("prompts when has UI", () => {
      expect(
        decideToolCall({ guardEnabled: true, hasUI: true, toolName: "bash" }),
      ).toBe("prompt");
    });

    it("auto-disables when no UI", () => {
      expect(
        decideToolCall({ guardEnabled: true, hasUI: false, toolName: "bash" }),
      ).toBe("auto-disable");
    });
  });
});

describe("resolveChoice", () => {
  it('"Allow similar this session" returns not blocked with allowKey side effect', () => {
    expect(
      resolveChoice({
        choice: "Allow similar this session",
        message: undefined,
      }),
    ).toEqual({ block: false, sideEffect: "allowKey" });
  });

  it('"Allow all this session" returns not blocked with disableGuard side effect', () => {
    expect(
      resolveChoice({
        choice: "Allow all this session",
        message: undefined,
      }),
    ).toEqual({ block: false, sideEffect: "disableGuard" });
  });

  it('"Block" with a message returns blocked with formatted reason', () => {
    const result = resolveChoice({
      choice: "Block",
      message: "do not delete that file",
    });
    expect(result.block).toBe(true);
    expect(result.reason).toBe(
      "Command blocked by user. User feedback:\n\ndo not delete that file\n\nAddress this before retrying.",
    );
    expect(result.sideEffect).toBeUndefined();
  });

  it('"Block" with empty message returns blocked with generic reason', () => {
    const result = resolveChoice({ choice: "Block", message: "" });
    expect(result.block).toBe(true);
    expect(result.reason).toBe(GENERIC_BLOCK_REASON);
  });
});

type AnyHandler = (event: never, ctx: ExtensionContext) => Promise<unknown>;
type CommandHandler = (args: string, ctx: ExtensionContext) => Promise<void>;
type ShortcutHandler = (ctx: ExtensionContext) => Promise<void>;
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
    events: {} as never,
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
  };
}

import type { SessionStartEvent } from "@earendil-works/pi-coding-agent";

function makeSessionStartEvent(
  reason: SessionStartEvent["reason"],
): SessionStartEvent {
  return { type: "session_start", reason };
}

describe("non-interactive mode", () => {
  it("tool_call with hasUI=false returns undefined, disables guard, logs status once", async () => {
    const { toolCallHandler, messageCalls } = captureHandlers();
    const ctx = makeNonInteractiveCtx();

    const result = await toolCallHandler(
      makeBashEvent("rm file.txt") as never,
      ctx,
    );

    expect(result).toBeUndefined();
    expect(ctx.notifyCalls).toHaveLength(0);
    expect(messageCalls).toHaveLength(1);
    expect(messageCalls[0]?.customType).toBe("pi-guard.status");
    expect(messageCalls[0]?.display).toBe(true);
    expect(messageCalls[0]?.content).toMatch(/guard auto-disabled/);
    expect(messageCalls[0]?.content).toMatch(/no interactive UI/);
  });

  it("session_start with hasUI=false auto-disables and logs once", async () => {
    const { sessionStartHandler, toolCallHandler, messageCalls } =
      captureHandlers();
    const ctx = makeNonInteractiveCtx();

    await sessionStartHandler(makeSessionStartEvent("startup") as never, ctx);

    expect(ctx.notifyCalls).toHaveLength(0);
    expect(messageCalls).toHaveLength(1);
    expect(messageCalls[0]?.content).toMatch(/guard auto-disabled/);

    const result = await toolCallHandler(
      makeBashEvent("rm file.txt") as never,
      ctx,
    );
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
    hasUI: true,
    signal: undefined,
    ui: {
      select: () => Promise.resolve("Allow once"),
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
  };
}

const FOOTER_KEY = "pi-guard.mode";

describe("session_start reason handling", () => {
  it('reason "startup" enables guard and sets footer', async () => {
    const { sessionStartHandler } = captureHandlers();
    const ctx = makeInteractiveCtx();

    await sessionStartHandler(makeSessionStartEvent("startup") as never, ctx);

    const lastStatus = ctx.statusCalls.at(-1);
    expect(lastStatus?.key).toBe(FOOTER_KEY);
    expect(lastStatus?.value).toContain("guard");
    expect(ctx.themeCalls).toContainEqual({ color: "success", text: "󰌾" });
    expect(ctx.themeCalls).toContainEqual({ color: "muted", text: "guard" });
  });
});

function captureCommandAndShortcutHandlers() {
  let commandHandler: CommandHandler | undefined;
  let shortcutHandler: ShortcutHandler | undefined;

  const pi = {
    on: () => {},
    registerShortcut(name: string, opts: { handler: ShortcutHandler }) {
      if (name === "alt+g") {
        shortcutHandler = opts.handler;
      }
    },
    registerCommand(name: string, opts: { handler: CommandHandler }) {
      if (name === "guard") {
        commandHandler = opts.handler;
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
    events: {} as never,
  } as unknown as ExtensionAPI;

  registerExtension(pi);

  if (!commandHandler) {
    throw new Error("guard command handler was not registered");
  }
  if (!shortcutHandler) {
    throw new Error("alt+g shortcut handler was not registered");
  }
  return { commandHandler, shortcutHandler };
}

function makeNotifyCapturingCtx(): ExtensionContext & {
  notifyCalls: Array<{ message: string; level: string }>;
} {
  const notifyCalls: Array<{ message: string; level: string }> = [];
  return {
    hasUI: true,
    signal: undefined,
    ui: {
      select: () => Promise.resolve("Allow once"),
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

  it("/guard on after /guard off emits action notification", async () => {
    const { commandHandler } = captureCommandAndShortcutHandlers();
    const ctx = makeNotifyCapturingCtx();

    await commandHandler("off", ctx);
    await commandHandler("on", ctx);

    expect(ctx.notifyCalls.at(-1)?.message).toBe("guard mode: on");
  });

  it("invalid arg notifies with usage", async () => {
    const { commandHandler } = captureCommandAndShortcutHandlers();
    const ctx = makeNotifyCapturingCtx();

    await commandHandler("invalid", ctx);

    expect(ctx.notifyCalls).toHaveLength(1);
    expect(ctx.notifyCalls[0].message).toBe("unknown: /guard [on|off]");
    expect(ctx.notifyCalls[0].level).toBe("warning");
  });
});

describe("alt+g shortcut", () => {
  it("shortcut toggles guard and updates footer", async () => {
    const { shortcutHandler } = captureCommandAndShortcutHandlers();
    const ctx = makeInteractiveCtx();

    await shortcutHandler(ctx);

    const lastStatus = ctx.statusCalls.at(-1);
    expect(lastStatus?.key).toBe(FOOTER_KEY);
    expect(lastStatus?.value).toContain("guard off");
  });
});

const MOCK_ACTION = {
  title: "Guard: confirm risky command?",
  description: "rm file.txt",
  reason: "File removal detected",
  allowKey: "bash:rm-risky",
  preview: "rm file.txt",
  severity: "medium" as const,
};

function mockRisky() {
  (assessBashCommand as ReturnType<typeof vi.fn>).mockReturnValue(MOCK_ACTION);
}

function mockSafe() {
  (assessBashCommand as ReturnType<typeof vi.fn>).mockReturnValue(undefined);
}

function makeModalCtx(
  selectResult: string | undefined,
  inputResult?: string | undefined,
): ExtensionContext & {
  selectCalls: Array<{ title: string; choices: string[]; options?: unknown }>;
  inputCalls: Array<{ title: string; placeholder?: string }>;
  statusCalls: Array<{ key: string; value: string | undefined }>;
} {
  const selectCalls: Array<{
    title: string;
    choices: string[];
    options?: unknown;
  }> = [];
  const inputCalls: Array<{ title: string; placeholder?: string }> = [];
  const statusCalls: Array<{ key: string; value: string | undefined }> = [];
  const { theme } = makeThemeSpy();
  return {
    hasUI: true,
    signal: undefined,
    ui: {
      select: (title: string, choices: string[], options?: unknown) => {
        selectCalls.push({ title, choices, options });
        return Promise.resolve(selectResult);
      },
      input: (title: string, placeholder?: string) => {
        inputCalls.push({ title, placeholder });
        return Promise.resolve(inputResult);
      },
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
    selectCalls,
    inputCalls,
    statusCalls,
  } as never;
}

describe("tool_call modal choice handling", () => {
  beforeEach(() => {
    mockRisky();
  });

  it("Allow once allows current call but second equivalent call still prompts", async () => {
    const { toolCallHandler } = captureHandlers();
    const ctx = makeModalCtx("Allow once");

    const result1 = await toolCallHandler(
      makeBashEvent("rm file.txt") as never,
      ctx,
    );
    expect(result1).toBeUndefined();
    expect(ctx.selectCalls).toHaveLength(1);

    const result2 = await toolCallHandler(
      makeBashEvent("rm file.txt") as never,
      ctx,
    );
    expect(result2).toBeUndefined();
    expect(ctx.selectCalls).toHaveLength(2);
  });

  it("Allow similar this session suppresses future prompts with same allowKey", async () => {
    const { toolCallHandler } = captureHandlers();
    const ctx = makeModalCtx("Allow similar this session");

    const result1 = await toolCallHandler(
      makeBashEvent("rm file.txt") as never,
      ctx,
    );
    expect(result1).toBeUndefined();
    expect(ctx.selectCalls).toHaveLength(1);

    const result2 = await toolCallHandler(
      makeBashEvent("rm file.txt") as never,
      ctx,
    );
    expect(result2).toBeUndefined();
    expect(ctx.selectCalls).toHaveLength(1);
  });

  it("Allow all this session disables guard and later risky calls pass", async () => {
    const { toolCallHandler } = captureHandlers();
    const ctx = makeModalCtx("Allow all this session");

    const result1 = await toolCallHandler(
      makeBashEvent("rm file.txt") as never,
      ctx,
    );
    expect(result1).toBeUndefined();
    expect(ctx.selectCalls).toHaveLength(1);
    expect(ctx.statusCalls.at(-1)?.value).toContain("guard off");

    const result2 = await toolCallHandler(
      makeBashEvent("rm file.txt") as never,
      ctx,
    );
    expect(result2).toBeUndefined();
    expect(ctx.selectCalls).toHaveLength(1);
  });

  it("Block with a message returns blocked with formatted reason", async () => {
    const { toolCallHandler } = captureHandlers();
    const ctx = makeModalCtx("Block", "do not delete that");

    const result = await toolCallHandler(
      makeBashEvent("rm file.txt") as never,
      ctx,
    );
    expect(result).toEqual({
      block: true,
      reason:
        "Command blocked by user. User feedback:\n\ndo not delete that\n\nAddress this before retrying.",
    });
    expect(ctx.inputCalls).toHaveLength(1);
    expect(ctx.inputCalls[0].title).toBe("Reason to give the agent");
  });

  it("AbortError from select returns blocked with generic reason", async () => {
    const { toolCallHandler } = captureHandlers();
    const abortError = Object.assign(new Error("Aborted"), {
      name: "AbortError",
    });
    const ctx = makeModalCtx("Allow once");
    ctx.ui.select = () => Promise.reject(abortError);

    const result = await toolCallHandler(
      makeBashEvent("rm file.txt") as never,
      ctx,
    );
    expect(result).toEqual({
      block: true,
      reason: GENERIC_BLOCK_REASON,
    });
  });

  it("AbortError from input returns blocked with generic reason", async () => {
    const { toolCallHandler } = captureHandlers();
    const abortError = Object.assign(new Error("Aborted"), {
      name: "AbortError",
    });
    const ctx = makeModalCtx("Block");
    ctx.ui.input = () => Promise.reject(abortError);

    const result = await toolCallHandler(
      makeBashEvent("rm file.txt") as never,
      ctx,
    );
    expect(result).toEqual({
      block: true,
      reason: GENERIC_BLOCK_REASON,
    });
  });

  it("non-AbortError from select re-throws", async () => {
    const { toolCallHandler } = captureHandlers();
    const ctx = makeModalCtx("Allow once");
    ctx.ui.select = () => Promise.reject(new Error("boom"));

    await expect(
      toolCallHandler(makeBashEvent("rm file.txt") as never, ctx),
    ).rejects.toThrow("boom");
  });

  it("safe commands do not prompt", async () => {
    mockSafe();
    const { toolCallHandler } = captureHandlers();
    const ctx = makeModalCtx("Allow once");

    const result = await toolCallHandler(
      makeBashEvent("echo hello") as never,
      ctx,
    );
    expect(result).toBeUndefined();
    expect(ctx.selectCalls).toHaveLength(0);
  });
});
