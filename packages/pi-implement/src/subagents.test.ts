import { describe, expect, it, vi } from "vitest";
import { RuntimeSubagentClient, subagentResultText } from "./subagents.js";

function makeRuntime() {
  const snapshots = new Map<string, any>();
  const runtime = {
    definitions: { register: vi.fn((definition: unknown) => definition) },
    runManagedAgent: vi.fn(async (input: any) => {
      const id = `agent-${snapshots.size + 1}`;
      const snapshot = {
        id,
        status: "running",
        description: input.description,
        cwd: input.cwd,
        model: input.model,
        thinking: input.thinking,
        health: { toolUses: 2, tokensTotal: 42 },
      };
      snapshots.set(id, snapshot);
      return snapshot;
    }),
    stop: vi.fn((id: string) => {
      snapshots.set(id, {
        ...(snapshots.get(id) ?? { id }),
        status: "stopped",
        error: "Stopped by user.",
      });
    }),
    wait: vi.fn(async (id: string) => snapshots.get(id)),
    snapshots: vi.fn(() => [...snapshots.values()]),
  };
  return runtime;
}

vi.mock("pi-subagents/runtime", () => ({
  getSubagentRuntime: (pi: any) => pi.__runtime ?? makeRuntime(),
}));

describe("RuntimeSubagentClient", () => {
  it("spawns pi-implement workers through the runtime with owner, cwd, and thinking metadata", async () => {
    const runtime = makeRuntime();
    const pi = { __runtime: runtime };
    const ctx = { cwd: "/repo", modelRegistry: { find: vi.fn() } };
    const client = new RuntimeSubagentClient(
      pi as never,
      ctx as never,
      "run-1",
    );

    const id = await client.spawn({
      type: "pi-implement:implementer",
      prompt: "p",
      description: "implement task",
      model: "p/m",
      thinking: "high",
      role: "implementer",
      taskId: "t001-task",
      cwd: "/repo/.pi/implement/worktrees/run-1/t001-task",
    });

    expect(id).toBe("agent-1");
    expect(runtime.runManagedAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: {
          kind: "pi-implement",
          runId: "run-1",
          role: "implementer",
          taskId: "t001-task",
        },
        cwd: "/repo/.pi/implement/worktrees/run-1/t001-task",
        model: "p/m",
        thinking: "high",
        mode: "background",
      }),
    );
  });

  it("keeps reviewer workers on read-oriented tools while allowing injected explore", async () => {
    const runtime = makeRuntime();
    const pi = { __runtime: runtime };
    const ctx = { cwd: "/repo", modelRegistry: { find: vi.fn() } };
    const client = new RuntimeSubagentClient(
      pi as never,
      ctx as never,
      "run-1",
    );

    await client.spawn({
      type: "pi-implement:reviewer",
      prompt: "review",
      description: "review task",
      role: "reviewer",
      cwd: "/repo/worktree",
    });

    expect(runtime.runManagedAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        tools: ["read", "bash", "grep", "find", "ls", "explore"],
        excludeTools: expect.arrayContaining(["edit", "write", "Agent"]),
      }),
    );
    const call = runtime.runManagedAgent.mock.calls.at(-1)?.[0];
    expect(call.excludeTools).not.toContain("explore");
  });

  it("lets pi-implement-owned implementer and reviewer types receive injected explore", async () => {
    const runtime = makeRuntime();
    const pi = { __runtime: runtime };
    const ctx = { cwd: "/repo", modelRegistry: { find: vi.fn() } };
    new RuntimeSubagentClient(pi as never, ctx as never, "run-1");

    expect(runtime.definitions.register).toHaveBeenCalledWith(
      expect.objectContaining({ type: "pi-implement:implementer" }),
    );
    expect(runtime.definitions.register).toHaveBeenCalledWith(
      expect.objectContaining({ type: "pi-implement:reviewer" }),
    );
    expect(runtime.definitions.register).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "Explore" }),
    );
  });

  it("waits for runtime snapshots and normalizes result text", async () => {
    const runtime = makeRuntime();
    const pi = { __runtime: runtime };
    const ctx = { cwd: "/repo", modelRegistry: { find: vi.fn() } };
    const client = new RuntimeSubagentClient(
      pi as never,
      ctx as never,
      "run-1",
    );
    await client.spawn({ type: "x", prompt: "p", description: "d" });
    runtime.wait.mockResolvedValue({
      id: "agent-1",
      status: "completed",
      result: { content: [{ type: "text", text: "ok" }] },
    });

    await expect(client.waitFor("agent-1")).resolves.toEqual({
      status: "completed",
      result: "ok",
    });
  });

  it("returns typed runtime snapshots for status widgets", async () => {
    const runtime = makeRuntime();
    const pi = { __runtime: runtime };
    const ctx = { cwd: "/repo", modelRegistry: { find: vi.fn() } };
    const client = new RuntimeSubagentClient(
      pi as never,
      ctx as never,
      "run-1",
    );
    await client.spawn({ type: "x", prompt: "p", description: "d" });

    expect(client.snapshots(["agent-1"])).toEqual([
      expect.objectContaining({
        id: "agent-1",
        status: "running",
        description: "d",
        cwd: "/repo",
        toolUses: 2,
        tokensTotal: 42,
      }),
    ]);
  });

  it("normalizes nested output", () => {
    expect(subagentResultText({ output: { text: "done" } })).toBe("done");
    expect(subagentResultText([{ text: "a" }, { text: "b" }])).toBe("a\nb");
  });
});
