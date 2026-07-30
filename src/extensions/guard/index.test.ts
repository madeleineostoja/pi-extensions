import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const { confirmBashCommand } = vi.hoisted(() => ({
  confirmBashCommand: vi.fn(),
}));

vi.mock("./enforcement/decide.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./enforcement/decide.js")>()),
  isSupportedMac: () => false,
}));
vi.mock("./semantic/confirmation.js", () => ({ confirmBashCommand }));

import registerGuard from "./index.ts";

const directories: string[] = [];

afterEach(() => {
  confirmBashCommand.mockReset();
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
  registerGuard(pi as never);
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

    expect(status).toHaveBeenLastCalledWith("pipkin.guard", "guard: local");
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
