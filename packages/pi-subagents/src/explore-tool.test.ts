import { describe, expect, it, vi } from "vitest";
import { SubagentRuntime } from "./runtime.js";

function makePi(activeTools = ["read", "bash", "Agent", "edit"]) {
  return {
    getActiveTools: () => activeTools,
    sendMessage: vi.fn(),
  };
}

function makeCtx(overrides: Partial<any> = {}) {
  return {
    cwd: "/workspace",
    model: { provider: "ctx", id: "default" },
    modelRegistry: {
      find: vi.fn((provider: string, modelId: string) => ({
        provider,
        id: modelId,
      })),
    },
    ...overrides,
  };
}

function makeSession(result = "done") {
  const extensionRunner = {
    hasHandlers: vi.fn(() => false),
    emit: vi.fn(async () => undefined),
  };
  return {
    bindExtensions: vi.fn(async () => undefined),
    prompt: vi.fn(async () => undefined),
    steer: vi.fn(async () => undefined),
    abort: vi.fn(async () => undefined),
    dispose: vi.fn(),
    getLastAssistantText: vi.fn(() => result),
    setActiveToolsByName: vi.fn(),
    extensionRunner: extensionRunner as any,
  };
}

describe("runtime-injected explore tool", () => {
  it("injects explore only into eligible non-Explore agents", async () => {
    const pi = makePi(["read", "bash", "Agent", "edit"]);
    const sessions = [
      makeSession("general"),
      makeSession("internal"),
      makeSession("reviewer"),
      makeSession("pi-implement implementer"),
      makeSession("pi-implement reviewer"),
      makeSession("explore"),
    ];
    const createSession = vi.fn(async () => ({ session: sessions.shift()! }));
    const runtime = new SubagentRuntime(pi as never, { createSession });

    await runtime.runPublicAgent({
      type: "General",
      prompt: "work",
      cwd: "/workspace",
      ctx: makeCtx() as never,
    });
    await runtime.runManagedAgent({
      owner: { kind: "internal", name: "pi-implement:implementer" },
      type: "general-purpose",
      prompt: "implement",
      cwd: "/workspace",
      ctx: makeCtx() as never,
    });
    await runtime.runManagedAgent({
      owner: { kind: "internal", name: "pi-implement:reviewer" },
      type: "reviewer",
      prompt: "review",
      cwd: "/workspace",
      ctx: makeCtx() as never,
    });
    await runtime.runManagedAgent({
      owner: {
        kind: "pi-implement",
        runId: "r1",
        role: "implementer",
        taskId: "t1",
      },
      type: "pi-implement:implementer",
      prompt: "implement",
      cwd: "/task-worktree",
      ctx: makeCtx() as never,
    });
    await runtime.runManagedAgent({
      owner: {
        kind: "pi-implement",
        runId: "r1",
        role: "reviewer",
        taskId: "t1",
      },
      type: "pi-implement:reviewer",
      prompt: "review",
      cwd: "/task-worktree",
      ctx: makeCtx() as never,
    });
    await runtime.runPublicAgent({
      type: "Explore",
      prompt: "inspect",
      cwd: "/workspace",
      ctx: makeCtx() as never,
    });

    expect(sessions).toHaveLength(0);
    const calls = createSession.mock.calls as any[][];
    expect(calls[0]?.[0].customTools?.map((tool: any) => tool.name)).toEqual([
      "explore",
    ]);
    expect(calls[1]?.[0].customTools?.map((tool: any) => tool.name)).toEqual([
      "explore",
    ]);
    expect(calls[2]?.[0].customTools?.map((tool: any) => tool.name)).toEqual([
      "explore",
    ]);
    expect(calls[3]?.[0].customTools?.map((tool: any) => tool.name)).toEqual([
      "explore",
    ]);
    expect(calls[4]?.[0].customTools?.map((tool: any) => tool.name)).toEqual([
      "explore",
    ]);
    expect(calls[5]?.[0].customTools).toBeUndefined();
  });

  it("normalizes explicit explore activation to eligible non-Explore agents", async () => {
    const reviewer = makeSession("reviewer");
    const explore = makeSession("explore");
    const sessions = [reviewer, explore];
    const createSession = vi.fn(async () => ({ session: sessions.shift()! }));
    const runtime = new SubagentRuntime(makePi() as never, { createSession });
    const readOnlyTools = [
      "read",
      "bash",
      "grep",
      "find",
      "ls",
      "explore",
      "Agent",
      "steer_subagent",
    ];

    await runtime.runManagedAgent({
      owner: {
        kind: "pi-implement",
        runId: "r1",
        role: "reviewer",
        taskId: "t1",
      },
      type: "pi-implement:reviewer",
      prompt: "review",
      cwd: "/task-worktree",
      tools: readOnlyTools,
      ctx: makeCtx() as never,
    });
    await runtime.runPublicAgent({
      type: "Explore",
      prompt: "inspect",
      cwd: "/task-worktree",
      tools: readOnlyTools,
      ctx: makeCtx() as never,
    });

    const calls = createSession.mock.calls as any[][];
    const reviewerOptions = calls[0]?.[0];
    const exploreOptions = calls[1]?.[0];
    expect(reviewerOptions.customTools).toEqual([
      expect.objectContaining({ name: "explore" }),
    ]);
    expect(reviewerOptions.tools).toEqual([
      "read",
      "bash",
      "grep",
      "find",
      "ls",
      "explore",
    ]);
    expect(reviewer.setActiveToolsByName).toHaveBeenCalledWith([
      "read",
      "bash",
      "grep",
      "find",
      "ls",
      "explore",
    ]);
    expect(exploreOptions.customTools).toBeUndefined();
    expect(exploreOptions.tools).toEqual([
      "read",
      "bash",
      "grep",
      "find",
      "ls",
    ]);
    expect(explore.setActiveToolsByName).toHaveBeenCalledWith([
      "read",
      "bash",
      "grep",
      "find",
      "ls",
    ]);
  });

  it("creates nested Explore metadata with inherited cwd, owner, model, thinking, and read-only tools", async () => {
    const pi = makePi([
      "read",
      "bash",
      "Agent",
      "get_subagent_result",
      "steer_subagent",
      "edit",
      "write",
      "explore",
    ]);
    const child = makeSession("nested result");
    const createSession = vi.fn(async () => ({ session: child }));
    const runtime = new SubagentRuntime(pi as never, {
      createSession,
      publicConfig: {
        agents: {
          General: {},
          Explore: { model: "configured/explore", thinking: "low" },
          Review: {},
        },
      },
    });
    const parentOwner = {
      kind: "pi-implement" as const,
      runId: "r1",
      role: "implementer" as const,
      taskId: "t1",
    };
    const parent = runtime.queue({
      owner: parentOwner,
      type: "pi-implement:implementer",
      description: "implement",
      cwd: "/task-worktree",
    });
    const result = await runtime.runExploreTool(
      parent,
      { question: "Where is runtime defined?", breadth: "quick" },
      makeCtx() as never,
    );

    expect(result.content[0]).toMatchObject({ text: "nested result" });
    expect(createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: "/task-worktree",
        model: { provider: "configured", id: "explore" },
        thinkingLevel: "low",
        tools: ["read", "bash", "grep", "find", "ls"],
        excludeTools: [
          "explore",
          "Agent",
          "get_subagent_result",
          "steer_subagent",
          "edit",
          "write",
        ],
      }),
    );
    expect(child.setActiveToolsByName).toHaveBeenCalledWith([
      "read",
      "bash",
      "grep",
      "find",
      "ls",
    ]);
    expect(runtime.snapshots()).toEqual([parent]);
    expect(runtime.snapshots({ includeNested: true })).toContainEqual(
      expect.objectContaining({
        status: "completed",
        type: "Explore",
        cwd: "/task-worktree",
        model: "configured/explore",
        thinking: "low",
        owner: {
          kind: "nested",
          parentId: parent.id,
          tool: "explore",
          parentOwner,
        },
      }),
    );
  });

  it("truncates large nested Explore output clearly", async () => {
    const pi = makePi();
    const runtime = new SubagentRuntime(pi as never, {
      createSession: vi.fn(async () => ({
        session: makeSession("x".repeat(50_100)),
      })),
    });
    const parent = runtime.queue({
      owner: "public-tool",
      type: "General",
      description: "general",
      cwd: "/workspace",
    });

    const result = await runtime.runExploreTool(
      parent,
      { question: "map files" },
      makeCtx() as never,
    );

    const text =
      result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(text).toContain("[explore output truncated after 50000 characters");
    expect(result.details).toMatchObject({ truncated: true });
  });

  it("propagates parent cancellation to the nested Explore child", async () => {
    const pi = makePi();
    const child = makeSession("never");
    child.prompt = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        child.abort.mockImplementation(async () => {
          resolve();
          return undefined;
        });
      });
    });
    const runtime = new SubagentRuntime(pi as never, {
      createSession: vi.fn(async () => ({ session: child })),
    });
    const parent = runtime.queue({
      owner: "public-tool",
      type: "General",
      description: "general",
      cwd: "/workspace",
    });
    const controller = new AbortController();

    const resultPromise = runtime.runExploreTool(
      parent,
      { question: "inspect" },
      makeCtx() as never,
      controller.signal,
    );
    await vi.waitFor(() => expect(child.prompt).toHaveBeenCalled());
    controller.abort();

    await expect(resultPromise).resolves.toMatchObject({
      content: [expect.objectContaining({ text: expect.any(String) })],
    });
    expect(child.abort).toHaveBeenCalled();
    expect((await resultPromise).content[0]).toMatchObject({
      text: expect.stringContaining("explore stopped or timed out"),
    });
  });

  it("prevents recursion from Explore and nested parents", async () => {
    const pi = makePi();
    const createSession = vi.fn(async () => ({ session: makeSession() }));
    const runtime = new SubagentRuntime(pi as never, { createSession });
    const exploreParent = runtime.queue({
      owner: "public-tool",
      type: "Explore",
      description: "explore",
      cwd: "/workspace",
    });
    const nestedParent = runtime.queue({
      owner: { kind: "nested", parentId: exploreParent.id, tool: "explore" },
      type: "General",
      description: "nested",
      cwd: "/workspace",
    });

    await expect(
      runtime.runExploreTool(
        exploreParent,
        { question: "again" },
        makeCtx() as never,
      ),
    ).resolves.toMatchObject({
      details: { status: "failed", error: "recursion prevented" },
    });
    await expect(
      runtime.runExploreTool(
        nestedParent,
        { question: "again" },
        makeCtx() as never,
      ),
    ).resolves.toMatchObject({
      details: { status: "failed", error: "recursion prevented" },
    });
    expect(createSession).not.toHaveBeenCalled();
  });
});
