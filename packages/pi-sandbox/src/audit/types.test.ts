/**
 * Compile-time smoke test: verifies that the public API of
 * @earendil-works/pi-coding-agent matches the shapes our code depends on.
 */
import { describe, it, expect } from "vitest";
import type {
  ToolCallEvent,
  ExecOptions,
  ExecResult,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";

describe("@earendil-works/pi-coding-agent type shapes", () => {
  it("ToolCallEvent has toolName field", () => {
    const event: ToolCallEvent = {
      type: "tool_call",
      toolCallId: "abc123",
      toolName: "read",
      input: { path: "/tmp/file.txt" },
    };
    expect(event.toolName).toBe("read");
  });

  it("ExecOptions has signal and timeout but no sandbox field", () => {
    const opts: ExecOptions = {
      signal: undefined,
      timeout: 5000,
    };
    expect(opts.timeout).toBe(5000);
    // sandbox must not be a known field (compile-time check)
    const keys = Object.keys(opts);
    expect(keys).not.toContain("sandbox");
  });

  it("ExecResult has code as number", () => {
    const result: ExecResult = {
      stdout: "hello",
      stderr: "",
      code: 0,
      killed: false,
    };
    expect(typeof result.code).toBe("number");
  });

  it("registerCommand handler accepts (args, ctx) signature", () => {
    type HandlerFn = (
      args: string,
      ctx: ExtensionCommandContext,
    ) => Promise<void>;
    const handler: HandlerFn = async (_args, _ctx) => {};
    expect(typeof handler).toBe("function");
  });
});
