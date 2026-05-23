import { describe, it, expect, vi, afterEach } from "vitest";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";

vi.mock("../runtime/binary.js", () => ({
  getNonoPath: vi.fn().mockReturnValue(null),
  getBinaryStatus: vi
    .fn()
    .mockReturnValue({ kind: "install-failed", reason: "marker-missing" }),
  createBinaryRuntime: vi.fn().mockReturnValue({
    getBinaryStatus: vi
      .fn()
      .mockReturnValue({ kind: "install-failed", reason: "marker-missing" }),
    getNonoPath: vi.fn().mockReturnValue(null),
    warnMissingOnce: vi.fn(),
  }),
}));

vi.mock("../enforcement/subprocess.js", () => ({
  initSubprocessSandbox: vi.fn().mockReturnValue({
    binaryStatus: { kind: "install-failed", reason: "marker-missing" },
    nonoPath: null,
    userBashHandler: vi.fn(() => undefined),
  }),
}));

import type {
  ExtensionAPI,
  ExtensionContext,
  ToolCallEvent,
} from "@earendil-works/pi-coding-agent";
import { sandboxExtension } from "../index.js";

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

type HandlerMap = Map<
  string,
  (event: unknown, ctx: ExtensionContext) => unknown
>;

function makePi(
  overrides: Partial<Record<string, unknown>> = {},
): ExtensionAPI {
  const handlers: HandlerMap = new Map();
  const setStatusFn = vi.fn();
  return {
    on: vi.fn(
      (
        event: string,
        handler: (event: unknown, ctx: ExtensionContext) => unknown,
      ) => {
        const existing = handlers.get(event);
        if (existing) {
          handlers.set(event, (e, c) => {
            existing(e, c);
            return handler(e, c);
          });
        } else {
          handlers.set(event, handler);
        }
      },
    ),
    exec: vi
      .fn()
      .mockResolvedValue({ stdout: "", stderr: "", code: 0, killed: false }),
    registerCommand: vi.fn(),
    events: { emit: vi.fn() },
    // expose handlers and setStatus for test access
    _handlers: handlers,
    _setStatus: setStatusFn,
    ...overrides,
  } as unknown as ExtensionAPI;
}

function makeCtx(
  overrides: Partial<Record<string, unknown>> = {},
): ExtensionContext {
  const setStatusFn = vi.fn();
  const notifyFn = vi.fn();
  return {
    cwd: "/tmp/test-cwd",
    hasUI: false,
    ui: {
      notify: notifyFn,
      setStatus: setStatusFn,
      select: vi.fn(),
      confirm: vi.fn(),
      input: vi.fn(),
      onTerminalInput: vi.fn().mockReturnValue(() => {}),
      setWorkingMessage: vi.fn(),
      setWorkingVisible: vi.fn(),
      setWorkingIndicator: vi.fn(),
      setHiddenThinkingLabel: vi.fn(),
      setWidget: vi.fn(),
      setFooter: vi.fn(),
      setHeader: vi.fn(),
      setTitle: vi.fn(),
      custom: vi.fn(),
      pasteToEditor: vi.fn(),
      setEditorText: vi.fn(),
      getEditorText: vi.fn().mockReturnValue(""),
      editor: vi.fn(),
      addAutocompleteProvider: vi.fn(),
      setEditorComponent: vi.fn(),
      getEditorComponent: vi.fn(),
      getAllThemes: vi.fn().mockReturnValue([]),
      getTheme: vi.fn(),
      setTheme: vi.fn().mockReturnValue({ success: true }),
      getToolsExpanded: vi.fn().mockReturnValue(false),
      setToolsExpanded: vi.fn(),
      theme: {} as ExtensionContext["ui"]["theme"],
    },
    sessionManager: {} as ExtensionContext["sessionManager"],
    modelRegistry: {} as ExtensionContext["modelRegistry"],
    model: undefined,
    isIdle: vi.fn().mockReturnValue(true),
    signal: undefined,
    abort: vi.fn(),
    hasPendingMessages: vi.fn().mockReturnValue(false),
    shutdown: vi.fn(),
    getContextUsage: vi.fn().mockReturnValue(undefined),
    compact: vi.fn(),
    getSystemPrompt: vi.fn().mockReturnValue(""),
    ...overrides,
  } as unknown as ExtensionContext;
}

function makeToolCallEvent(
  toolName: string,
  input: Record<string, unknown>,
): ToolCallEvent {
  return {
    type: "tool_call",
    toolCallId: "test-id",
    toolName,
    input,
  } as ToolCallEvent;
}

// ---------------------------------------------------------------------------
// Helpers to access internal mock state
// ---------------------------------------------------------------------------

function getPiHandlers(pi: ExtensionAPI): HandlerMap {
  return (pi as unknown as { _handlers: HandlerMap })._handlers;
}

function makeSessionStartEvent(): { type: "session_start"; reason: "startup" } {
  return { type: "session_start", reason: "startup" };
}

function fireSessionStart(pi: ExtensionAPI, ctx: ExtensionContext): void {
  const handlers = getPiHandlers(pi);
  const handler = handlers.get("session_start");
  if (!handler) throw new Error("no session_start handler registered");
  handler(makeSessionStartEvent(), ctx);
}

async function fireToolCall(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  event: ToolCallEvent,
): Promise<unknown> {
  const handlers = getPiHandlers(pi);
  const handler = handlers.get("tool_call");
  if (!handler) throw new Error("no tool_call handler registered");
  return handler(event, ctx);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("sandboxExtension — wiring", () => {
  it("registers pi.on('tool_call', ...) after session_start fires", () => {
    const pi = makePi();
    const ctx = makeCtx();
    sandboxExtension(pi);
    fireSessionStart(pi, ctx);

    const onCalls = (pi.on as ReturnType<typeof vi.fn>).mock
      .calls as unknown[][];
    const toolCallRegistrations = onCalls.filter(
      (args) => args[0] === "tool_call",
    );
    expect(toolCallRegistrations.length).toBeGreaterThanOrEqual(1);
  });

  it("registers pi.on('user_bash', ...) after session_start fires", () => {
    const pi = makePi();
    const ctx = makeCtx();
    sandboxExtension(pi);
    fireSessionStart(pi, ctx);

    const onCalls = (pi.on as ReturnType<typeof vi.fn>).mock
      .calls as unknown[][];
    const userBashRegistrations = onCalls.filter(
      (args) => args[0] === "user_bash",
    );
    expect(userBashRegistrations.length).toBeGreaterThanOrEqual(1);
  });

  it("registers pi.registerCommand('sandbox', ...) after session_start fires", () => {
    const pi = makePi();
    const ctx = makeCtx();
    sandboxExtension(pi);
    fireSessionStart(pi, ctx);

    expect(pi.registerCommand).toHaveBeenCalledWith(
      "sandbox",
      expect.objectContaining({
        description: expect.any(String),
        handler: expect.any(Function),
      }),
    );
  });

  it("calls ctx.ui.setStatus at least once with a non-undefined initial render", () => {
    const pi = makePi();
    const ctx = makeCtx();
    sandboxExtension(pi);
    fireSessionStart(pi, ctx);

    const setStatusCalls = (ctx.ui.setStatus as ReturnType<typeof vi.fn>).mock
      .calls as unknown[][];
    expect(setStatusCalls.length).toBeGreaterThanOrEqual(1);
    const sandboxStatusCalls = setStatusCalls.filter(
      (args) => args[0] === "sandbox",
    );
    expect(sandboxStatusCalls.length).toBeGreaterThanOrEqual(1);
    expect(sandboxStatusCalls[0][1]).toBeDefined();
  });
});

describe("sandboxExtension — session mutation via command handler", () => {
  it("after /sandbox off, tool_call is allowed and status is re-rendered", async () => {
    const pi = makePi();
    const ctx = makeCtx();
    sandboxExtension(pi);
    fireSessionStart(pi, ctx);

    const setStatusSpy = ctx.ui.setStatus as ReturnType<typeof vi.fn>;
    const initialCallCount = setStatusSpy.mock.calls.length;

    // Get the registered command handler
    const registerCalls = (pi.registerCommand as ReturnType<typeof vi.fn>).mock
      .calls as unknown[][];
    const sandboxCmd = registerCalls.find((args) => args[0] === "sandbox");
    expect(sandboxCmd).toBeDefined();
    const cmdOptions = (sandboxCmd as unknown[])[1] as {
      handler: (args: string, ctx: ExtensionContext) => Promise<void>;
    };
    const cmdHandler = cmdOptions.handler;

    // Dispatch /sandbox off
    await cmdHandler("off", ctx);

    // Status should have been re-rendered
    expect(setStatusSpy.mock.calls.length).toBeGreaterThan(initialCallCount);
    const lastStatusCall =
      setStatusSpy.mock.calls[setStatusSpy.mock.calls.length - 1];
    expect(lastStatusCall[1]).toContain("off");

    // Tool call should be allowed (sandbox is off)
    const event = makeToolCallEvent("read", { path: "/etc/secret" });
    const result = await fireToolCall(pi, ctx, event);
    expect(result).toBeUndefined();
  });
});

describe("sandboxExtension — double invocation", () => {
  it("second session_start on the same pi instance is a no-op and emits a warning", () => {
    const pi = makePi();
    const ctx = makeCtx();

    sandboxExtension(pi);
    fireSessionStart(pi, ctx);
    const registerCallsAfterFirst = (
      pi.registerCommand as ReturnType<typeof vi.fn>
    ).mock.calls.length as number;

    // Fire session_start again (simulates reload/double-load scenario)
    fireSessionStart(pi, ctx);
    const registerCallsAfterSecond = (
      pi.registerCommand as ReturnType<typeof vi.fn>
    ).mock.calls.length as number;

    // No additional registrations on second session_start
    expect(registerCallsAfterSecond).toBe(registerCallsAfterFirst);

    // Warning was emitted
    const notifyCalls = (ctx.ui.notify as ReturnType<typeof vi.fn>).mock
      .calls as unknown[][];
    const warnings = notifyCalls.filter((args) => args[1] === "warning");
    const doubleCallWarning = warnings.find(
      (args) =>
        typeof args[0] === "string" && (args[0] as string).includes("twice"),
    );
    expect(doubleCallWarning).toBeDefined();
  });
});

describe("sandboxExtension — strict-mode refusal", () => {
  let tmpDir: string | null = null;

  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = null;
    }
  });

  it("when requireKernelSandbox=true and binary unavailable, emits error notify and does not register enforcement handlers", () => {
    tmpDir = fs.mkdirSync(
      path.join(os.tmpdir(), `pi-sandbox-strict-test-${Date.now()}`),
      { recursive: true },
    ) as string;
    const piDir = path.join(tmpDir, ".pi");
    fs.mkdirSync(piDir, { recursive: true });
    fs.writeFileSync(
      path.join(piDir, "sandbox.json"),
      JSON.stringify({ enforcement: { requireKernelSandbox: true } }),
      "utf8",
    );

    const pi = makePi();
    const ctx = makeCtx({ cwd: tmpDir });

    sandboxExtension(pi);
    fireSessionStart(pi, ctx);

    const notifyCalls = (ctx.ui.notify as ReturnType<typeof vi.fn>).mock
      .calls as unknown[][];
    const errorCalls = notifyCalls.filter((args) => args[1] === "error");
    const requireKernelError = errorCalls.find(
      (args) =>
        typeof args[0] === "string" &&
        (args[0] as string).includes("requireKernelSandbox"),
    );
    expect(requireKernelError).toBeDefined();

    const onCalls = (pi.on as ReturnType<typeof vi.fn>).mock
      .calls as unknown[][];
    const toolCallRegistrations = onCalls.filter(
      (args) => args[0] === "tool_call",
    );
    const userBashRegistrations = onCalls.filter(
      (args) => args[0] === "user_bash",
    );
    expect(toolCallRegistrations.length).toBe(0);
    expect(userBashRegistrations.length).toBe(0);
  });
});

describe("sandboxExtension — two-instance isolation", () => {
  it("toggling /sandbox off on one instance does not affect the other instance's session state", async () => {
    const pi1 = makePi();
    const pi2 = makePi();
    const ctx1 = makeCtx();
    const ctx2 = makeCtx();

    sandboxExtension(pi1);
    sandboxExtension(pi2);

    fireSessionStart(pi1, ctx1);
    fireSessionStart(pi2, ctx2);

    // Get sandbox command handler for pi1
    const registerCalls1 = (pi1.registerCommand as ReturnType<typeof vi.fn>)
      .mock.calls as unknown[][];
    const sandboxCmd1 = registerCalls1.find((args) => args[0] === "sandbox");
    expect(sandboxCmd1).toBeDefined();
    const cmdHandler1 = (
      (sandboxCmd1 as unknown[])[1] as {
        handler: (args: string, ctx: ExtensionContext) => Promise<void>;
      }
    ).handler;

    // Get sandbox command handler for pi2
    const registerCalls2 = (pi2.registerCommand as ReturnType<typeof vi.fn>)
      .mock.calls as unknown[][];
    const sandboxCmd2 = registerCalls2.find((args) => args[0] === "sandbox");
    expect(sandboxCmd2).toBeDefined();
    const cmdHandler2 = (
      (sandboxCmd2 as unknown[])[1] as {
        handler: (args: string, ctx: ExtensionContext) => Promise<void>;
      }
    ).handler;

    // Turn sandbox off for pi1 only
    await cmdHandler1("off", ctx1);

    // pi1: tool_call should be allowed (sandbox off)
    const event = makeToolCallEvent("read", { path: "/etc/secret" });
    const result1 = await fireToolCall(pi1, ctx1, event);
    expect(result1).toBeUndefined();

    // pi2: tool_call should still be blocked (sandbox still on)
    await fireToolCall(pi2, ctx2, event);
    // pi2 sandbox is still on, so result may block or allow depending on policy,
    // but crucially the session state of pi2 must have sandboxOff=false.
    // Verify by checking that /sandbox status for pi2 reports ON.
    const setStatusCalls2 = (ctx2.ui.setStatus as ReturnType<typeof vi.fn>).mock
      .calls as unknown[][];
    const sandboxStatusCalls2 = setStatusCalls2.filter(
      (args) => args[0] === "sandbox",
    );
    const lastStatus2 = sandboxStatusCalls2[
      sandboxStatusCalls2.length - 1
    ]?.[1] as string | undefined;
    // pi2's status must not indicate "off"
    if (lastStatus2 !== undefined) {
      expect(lastStatus2).not.toContain("off");
    }

    // Turn off for pi2 explicitly to verify it has its own independent state
    await cmdHandler2("off", ctx2);
    const setStatusCalls2After = (ctx2.ui.setStatus as ReturnType<typeof vi.fn>)
      .mock.calls as unknown[][];
    const sandboxStatusCalls2After = setStatusCalls2After.filter(
      (args) => args[0] === "sandbox",
    );
    const lastStatus2After = sandboxStatusCalls2After[
      sandboxStatusCalls2After.length - 1
    ]?.[1] as string | undefined;
    expect(lastStatus2After).toContain("off");
  });
});

describe("sandboxExtension — policy load failure", () => {
  let tmpDir: string | null = null;

  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = null;
    }
  });

  it("reports parse failure via ctx.ui.notify at error/warning level and still registers the tool_call handler", () => {
    tmpDir = fs.mkdirSync(
      path.join(os.tmpdir(), `pi-sandbox-test-${Date.now()}`),
      { recursive: true },
    ) as string;
    const piDir = path.join(tmpDir, ".pi");
    fs.mkdirSync(piDir, { recursive: true });
    fs.writeFileSync(
      path.join(piDir, "sandbox.json"),
      "{ this is: not valid json {{{{",
      "utf8",
    );

    const pi = makePi();
    const ctx = makeCtx({ cwd: tmpDir });

    sandboxExtension(pi);
    fireSessionStart(pi, ctx);

    const notifyCalls = (ctx.ui.notify as ReturnType<typeof vi.fn>).mock
      .calls as unknown[][];
    const errorOrWarnCalls = notifyCalls.filter(
      (args) => args[1] === "error" || args[1] === "warning",
    );
    expect(errorOrWarnCalls.length).toBeGreaterThanOrEqual(1);
    const parseFailureCall = errorOrWarnCalls.find(
      (args) =>
        typeof args[0] === "string" &&
        (args[0] as string).toLowerCase().includes("invalid json"),
    );
    expect(parseFailureCall).toBeDefined();

    const onCalls = (pi.on as ReturnType<typeof vi.fn>).mock
      .calls as unknown[][];
    const toolCallRegistrations = onCalls.filter(
      (args) => args[0] === "tool_call",
    );
    expect(toolCallRegistrations.length).toBeGreaterThanOrEqual(1);
  });
});
