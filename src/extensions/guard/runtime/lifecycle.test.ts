import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const { confirmBashCommand, getNonoHealth, isSupportedMac } = vi.hoisted(
  () => ({
    confirmBashCommand: vi.fn(),
    getNonoHealth: vi.fn(),
    isSupportedMac: vi.fn(() => false),
  }),
);

vi.mock("../enforcement/decide.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../enforcement/decide.js")>()),
  isSupportedMac,
}));
vi.mock("./nono.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./nono.js")>()),
  getNonoHealth,
}));
vi.mock("../semantic/confirmation.js", () => ({ confirmBashCommand }));

import { registerGuardCommand } from "../command.js";
import { createDirectFilesystemToolHandler } from "../enforcement/handler.js";
import { createGuardRuntimeState } from "../state.js";
import { createGuardBashRuntime } from "./bash.js";
import { createGuardSessionController } from "./controller.js";

const directories: string[] = [];

afterEach(() => {
  confirmBashCommand.mockReset();
  getNonoHealth.mockReset();
  isSupportedMac.mockReset();
  isSupportedMac.mockReturnValue(false);
  while (directories.length) {
    rmSync(directories.pop()!, { recursive: true, force: true });
  }
});

type Handler = (...args: any[]) => any;

function fixture(beforeGuardToolCallHandler?: Handler) {
  const cwd = mkdtempSync(join(tmpdir(), "pipkin-guard-extension-"));
  directories.push(cwd);
  const handlers = new Map<string, Handler[]>();
  const tools: any[] = [];
  const commands = new Map<string, any>();
  const status = vi.fn();
  const ui = {
    notify: vi.fn(),
    setStatus: status,
    theme: { fg: (_color: string, text: string) => text },
    select: vi.fn(async (_title: string, choices: string[]) =>
      choices.includes("Allow similar this session")
        ? "Allow similar this session"
        : "Close",
    ),
    input: vi.fn(async () => ""),
    confirm: vi.fn(async () => true),
  };
  const pi = {
    on: (event: string, handler: Handler) =>
      handlers.set(event, [...(handlers.get(event) ?? []), handler]),
    registerTool: (tool: unknown) => tools.push(tool),
    registerCommand: (name: string, command: unknown) =>
      commands.set(name, command),
  };
  const context = (mode: "tui" | "rpc" | "print", hasUI: boolean) =>
    ({
      cwd,
      mode,
      hasUI,
      signal: undefined,
      ui,
      sessionManager: {
        getSessionFile: () => join(cwd, "current.jsonl"),
        getSessionId: () => "guard-test-session",
      },
    }) as any;

  if (beforeGuardToolCallHandler) {
    pi.on("tool_call", beforeGuardToolCallHandler);
  }
  const state = createGuardRuntimeState();
  const supportedMac = isSupportedMac();
  const bash = createGuardBashRuntime({ state, supportedMac });
  const session = createGuardSessionController({ state, bash, supportedMac });
  registerGuardCommand({ pi: pi as never, state, supportedMac });
  pi.on("session_start", (event, ctx) => {
    const { bashTool } = session.sessionStart(event, ctx as never);
    if (bashTool) {
      pi.registerTool(bashTool);
    }
  });
  pi.on("session_shutdown", (_event, ctx) =>
    session.sessionShutdown(ctx as never),
  );
  pi.on(
    "tool_call",
    createDirectFilesystemToolHandler({ state, supportedMac }),
  );
  pi.on("user_bash", (_event, ctx) => session.userBash(ctx as never));
  const emit = async (event: string, payload: unknown, ctx: unknown) => {
    let result: unknown;
    for (const handler of handlers.get(event) ?? []) {
      const next = await handler(payload, ctx);
      if (next !== undefined) {
        result = next;
      }
    }
    return result;
  };
  return { commands, context, cwd, emit, handlers, status, tools, ui };
}

describe("Guard extension registration", () => {
  it("does not block session startup while probing Nono health", async () => {
    isSupportedMac.mockReturnValue(true);
    let resolveHealth!: (health: { kind: "healthy"; path: string }) => void;
    getNonoHealth.mockReturnValue(
      new Promise((resolve) => {
        resolveHealth = resolve;
      }),
    );
    const { context, emit, handlers, status, tools } = fixture();
    const tui = context("tui", true);
    const handler = handlers.get("session_start")![0];

    expect(handler({ type: "session_start" }, tui)).toBeUndefined();
    expect(tools).toHaveLength(1);

    resolveHealth({ kind: "healthy", path: "/managed/nono" });
    await vi.waitFor(() =>
      expect(status).toHaveBeenCalledWith("pipkin.guard", "󰒃 guard"),
    );
    await emit("session_shutdown", { type: "session_shutdown" }, tui);
  });

  it("owns the only Bash executor and assesses final post-tool-call input exactly once", async () => {
    const mutator = vi.fn((event: { toolName: string; input: object }) => {
      if (event.toolName === "bash") {
        Object.assign(event.input, { command: "printf guarded" });
      }
    });
    const { context, emit, tools } = fixture(mutator);
    const ctx = context("print", false);
    await emit("session_start", { type: "session_start" }, ctx);

    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("bash");
    const call = {
      type: "tool_call",
      toolCallId: "bash-1",
      toolName: "bash",
      input: { command: "printf before-mutation" },
    };
    await emit("tool_call", call, ctx);
    expect(mutator).toHaveBeenCalledTimes(1);
    await expect(
      tools[0].execute(call.toolCallId, call.input, undefined, undefined, ctx),
    ).resolves.toMatchObject({
      content: [{ type: "text", text: "guarded" }],
    });
    expect(confirmBashCommand).toHaveBeenCalledTimes(1);
    expect(confirmBashCommand).toHaveBeenLastCalledWith(
      expect.objectContaining({ command: "printf guarded", ctx }),
    );

    await emit("session_shutdown", { type: "session_shutdown" }, ctx);
  });

  it("uses TUI-only approvals and shows Guard status only on the TUI surface", async () => {
    const { commands, context, cwd, emit, status, ui } = fixture();
    const protectedFile = join(cwd, ".env");
    writeFileSync(protectedFile, "secret");
    const tui = context("tui", true);
    await emit("session_start", { type: "session_start" }, tui);

    expect(status).toHaveBeenLastCalledWith("pipkin.guard", "󰒃 guard: local");
    await expect(
      emit(
        "tool_call",
        { toolName: "read", input: { path: protectedFile } },
        context("rpc", true),
      ),
    ).resolves.toMatchObject({ block: true });
    await expect(
      emit(
        "tool_call",
        { toolName: "read", input: { path: protectedFile } },
        tui,
      ),
    ).resolves.toBeUndefined();
    await expect(
      emit(
        "tool_call",
        { toolName: "read", input: { path: protectedFile } },
        context("rpc", true),
      ),
    ).resolves.toBeUndefined();

    await commands.get("guard").handler("", tui);
    expect(ui.select).toHaveBeenCalled();
    await emit("session_shutdown", { type: "session_shutdown" }, tui);
  });
});
