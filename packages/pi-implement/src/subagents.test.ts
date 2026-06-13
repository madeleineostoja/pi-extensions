import { describe, expect, it, vi } from "vitest";
import { DirectSubagentClient, subagentResultText } from "./subagents.js";

function makeFakeRuntime(): import("pi-subagents/runtime").SubagentRuntime {
  return {
    registerDefinition: vi.fn(() => ({ ok: true })),
    hasDefinition: vi.fn(() => true),
    getDefinition: vi.fn(() => undefined),
    listDefinitions: vi.fn(() => []),
    spawn: vi.fn(async (args) => `agent-${args.type}`),
    waitFor: vi.fn(async (_id) => ({
      status: "completed" as const,
      result: "ok",
    })),
    stop: vi.fn(async () => {}),
    steer: vi.fn(async () => {}),
    snapshots: vi.fn(() => []),
    getRecord: vi.fn(() => undefined),
  } as unknown as import("pi-subagents/runtime").SubagentRuntime;
}

describe("DirectSubagentClient", () => {
  it("probe resolves ok immediately", async () => {
    const runtime = makeFakeRuntime();
    const client = new DirectSubagentClient(runtime);
    await expect(client.probe()).resolves.toEqual({ ok: true, version: 1 });
  });

  it("spawns through runtime with background options", async () => {
    const runtime = makeFakeRuntime();
    const client = new DirectSubagentClient(runtime);
    const id = await client.spawn({
      type: "pi-implement/implementer",
      prompt: "p",
      description: "d",
      model: "p/m",
    });
    expect(runtime.spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "pi-implement/implementer",
        prompt: "p",
        description: "d",
        model: "p/m",
        background: true,
        owner: { kind: "pi-implement", role: "worker" },
      }),
    );
    expect(id).toBe("agent-pi-implement/implementer");
  });

  it("omits model so runtime resolution can be used", async () => {
    const runtime = makeFakeRuntime();
    const client = new DirectSubagentClient(runtime);
    await client.spawn({
      type: "pi-implement/implementer",
      prompt: "p",
      description: "d",
    });
    expect(runtime.spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        model: undefined,
      }),
    );
  });

  it("includes cwd in spawn options when set", async () => {
    const runtime = makeFakeRuntime();
    const client = new DirectSubagentClient(runtime);
    await client.spawn({
      type: "pi-implement/implementer",
      prompt: "p",
      description: "d",
      cwd: "/some/path",
    });
    expect(runtime.spawn).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: "/some/path" }),
    );
  });

  it("waits for completion and returns result", async () => {
    const runtime = makeFakeRuntime();
    const client = new DirectSubagentClient(runtime);
    const result = await client.waitFor("agent-1");
    expect(result).toEqual({ status: "completed", result: "ok" });
  });

  it("returns stopped when runtime reports stopped", async () => {
    const runtime = makeFakeRuntime();
    vi.mocked(runtime.waitFor).mockResolvedValue({
      status: "stopped",
      error: "Stopped by user.",
    });
    const client = new DirectSubagentClient(runtime);
    const result = await client.waitFor("agent-1");
    expect(result).toEqual({ status: "stopped", error: "Stopped by user." });
  });

  it("returns failed when runtime reports failed", async () => {
    const runtime = makeFakeRuntime();
    vi.mocked(runtime.waitFor).mockResolvedValue({
      status: "failed",
      error: "boom",
    });
    const client = new DirectSubagentClient(runtime);
    const result = await client.waitFor("agent-1");
    expect(result).toEqual({ status: "failed", error: "boom" });
  });

  it("normalizes nested subagent output", () => {
    expect(subagentResultText({ output: { text: "done" } })).toBe("done");
    expect(subagentResultText([{ text: "a" }, { text: "b" }])).toBe("a\nb");
  });
});
