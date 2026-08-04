import {
  DEFAULT_MAX_BYTES,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

const lowPreset = { low: { model: "ctx/default", thinking: "low" as const } };
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

function asAgentSession<T>(session: T): T & AgentSession {
  return session as T & AgentSession;
}

function makeSession(result = "done") {
  const extensionRunner = {
    hasHandlers: vi.fn(() => false),
    emit: vi.fn(async () => undefined),
  };
  return asAgentSession({
    bindExtensions: vi.fn(async () => undefined),
    prompt: vi.fn(async () => undefined),
    steer: vi.fn(async () => undefined),
    abort: vi.fn(async () => undefined),
    dispose: vi.fn(),
    getLastAssistantText: vi.fn(() => result),
    setActiveToolsByName: vi.fn(),
    state: {},
    messages: [] as any[],
    sessionId: "session-id",
    sessionFile: undefined,
    subscribe: vi.fn(() => vi.fn()),
    getAllTools: vi.fn(() => []),
    extensionRunner: extensionRunner as any,
  });
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

async function flushPromises() {
  for (let i = 0; i < 5; i += 1) {
    await Promise.resolve();
  }
}

describe("runtime-injected explore tool", () => {
  it("uses a provider-portable schema and repository-preserving description", () => {
    const runtime = new SubagentRuntime(makePi() as never);
    const parent = runtime.queue({
      owner: "public-tool",
      type: "Worker",
      description: "general",
      cwd: "/workspace",
    });

    const tool = runtime.createExploreTool(parent);
    const parameters = JSON.parse(JSON.stringify(tool.parameters));
    expect(parameters.properties.breadth).toMatchObject({
      type: "string",
      enum: ["quick", "medium", "very thorough"],
      description: expect.stringContaining("exploration depth"),
    });
    expect(tool.description).toContain("repository-preserving");
    expect(tool.description).toContain("cannot spawn agents");
    expect(tool.description).not.toContain("cannot modify state");
  });

  it("injects explore only into eligible non-Explore agents", async () => {
    const pi = makePi(["read", "bash", "Agent", "edit"]);
    const sessions = [
      makeSession("general"),
      makeSession("internal"),
      makeSession("reviewer"),
      makeSession("pipkin-implement implementer"),
      makeSession("pipkin-implement reviewer"),
      makeSession("explore"),
    ];
    const createSession = vi.fn(async () => ({ session: sessions.shift()! }));
    const runtime = new SubagentRuntime(pi as never, {
      modelPresets: lowPreset,
      createSession,
    });

    await runtime.runPublicAgent({
      type: "Review",
      prompt: "work",
      cwd: "/workspace",
      ctx: makeCtx() as never,
    });
    await runtime.runManagedAgent({
      owner: { kind: "internal", name: "pipkin:implement:implementer" },
      type: "general-purpose",
      prompt: "implement",
      cwd: "/workspace",
      ctx: makeCtx() as never,
    });
    await runtime.runManagedAgent({
      owner: { kind: "internal", name: "pipkin:implement:reviewer" },
      type: "reviewer",
      prompt: "review",
      cwd: "/workspace",
      ctx: makeCtx() as never,
    });
    await runtime.runManagedAgent({
      owner: {
        kind: "pipkin:implement",
        runId: "r1",
        role: "implementer",
        taskId: "t1",
      },
      type: "pipkin:implement:implementer",
      prompt: "implement",
      cwd: "/task-worktree",
      ctx: makeCtx() as never,
    });
    await runtime.runManagedAgent({
      owner: {
        kind: "pipkin:implement",
        runId: "r1",
        role: "reviewer",
        taskId: "t1",
      },
      type: "pipkin:implement:reviewer",
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
    const runtime = new SubagentRuntime(makePi() as never, {
      modelPresets: lowPreset,
      createSession,
    });
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
        kind: "pipkin:implement",
        runId: "r1",
        role: "reviewer",
        taskId: "t1",
      },
      type: "pipkin:implement:reviewer",
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
      "lsp",
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
      modelPresets: {
        low: { model: "configured/explore", thinking: "low" },
      },
    });
    const parentOwner = {
      kind: "pipkin:implement" as const,
      runId: "r1",
      role: "implementer" as const,
      taskId: "t1",
    };
    const parent = runtime.queue({
      owner: parentOwner,
      type: "pipkin:implement:implementer",
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
        tools: ["read", "bash", "grep", "find", "ls", "lsp", "record_papercut"],
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
      "lsp",
      "record_papercut",
    ]);
    expect(child.prompt).toHaveBeenCalledWith(
      expect.stringMatching(
        /lsp when available[\s\S]*broad, literal, or non-semantic[\s\S]*fall back to search and reads/,
      ),
      { source: "extension", expandPromptTemplates: false },
    );
    expect(child.prompt).toHaveBeenCalledWith(
      expect.not.stringContaining("Use only read, bash, grep, find, ls"),
      { source: "extension", expandPromptTemplates: false },
    );
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
      modelPresets: lowPreset,
      createSession: vi.fn(async () => ({
        session: makeSession("😀\n".repeat(20_000)),
      })),
    });
    const parent = runtime.queue({
      owner: "public-tool",
      type: "Worker",
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
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(DEFAULT_MAX_BYTES);
    expect(text).toContain("[Explore output truncated.");
    expect(result.details).toMatchObject({ truncated: true });
  });

  it("bounds failed nested Explore output and reports truncation", async () => {
    const child = makeSession();
    Object.defineProperty(child, "state", {
      value: { errorMessage: "😀".repeat(20_000) },
    });
    const runtime = new SubagentRuntime(makePi() as never, {
      modelPresets: lowPreset,
      createSession: vi.fn(async () => ({ session: child })),
    });
    const parent = runtime.queue({
      owner: "public-tool",
      type: "Worker",
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
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(DEFAULT_MAX_BYTES);
    expect(text).toContain("explore failed:");
    expect(text).toContain("[Explore output truncated.");
    expect(result.details).toMatchObject({ status: "failed", truncated: true });
    expect(
      Buffer.byteLength((result.details as { error?: string }).error ?? ""),
    ).toBeLessThanOrEqual(DEFAULT_MAX_BYTES);
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
      modelPresets: lowPreset,
      createSession: vi.fn(async () => ({ session: child })),
    });
    const parent = runtime.queue({
      owner: "public-tool",
      type: "Worker",
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

  it("aborts nested Explore after sustained inactivity", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    try {
      const promptStarted = deferred();
      const child = makeSession("never");
      child.prompt = vi.fn(async () => {
        child.messages.push({
          role: "assistant",
          timestamp: Date.now(),
          content: [{ type: "text", text: "starting" }],
        });
        promptStarted.resolve();
        await new Promise<void>((resolve) => {
          child.abort.mockImplementation(async () => {
            resolve();
            return undefined;
          });
        });
      });
      const runtime = new SubagentRuntime(makePi() as never, {
        modelPresets: lowPreset,
        createSession: vi.fn(async () => ({ session: child })),
      });
      const parent = runtime.queue({
        owner: "public-tool",
        type: "Worker",
        description: "general",
        cwd: "/workspace",
      });

      const resultPromise = runtime.runExploreTool(
        parent,
        { question: "inspect" },
        makeCtx() as never,
      );
      await promptStarted.promise;

      await vi.advanceTimersByTimeAsync(130_000);

      await expect(resultPromise).resolves.toMatchObject({
        content: [
          expect.objectContaining({
            text: expect.stringContaining("explore stopped or timed out"),
          }),
        ],
      });
      expect(child.abort).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("aborts nested Explore with no first activity after the baseline window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    try {
      const promptStarted = deferred();
      const child = makeSession("never");
      child.prompt = vi.fn(async () => {
        promptStarted.resolve();
        await new Promise<void>((resolve) => {
          child.abort.mockImplementation(async () => {
            resolve();
            return undefined;
          });
        });
      });
      const runtime = new SubagentRuntime(makePi() as never, {
        modelPresets: lowPreset,
        createSession: vi.fn(async () => ({ session: child })),
      });
      const parent = runtime.queue({
        owner: "public-tool",
        type: "Worker",
        description: "general",
        cwd: "/workspace",
      });

      const resultPromise = runtime.runExploreTool(
        parent,
        { question: "inspect" },
        makeCtx() as never,
      );
      await promptStarted.promise;

      await vi.advanceTimersByTimeAsync(130_000);

      await expect(resultPromise).resolves.toMatchObject({
        content: [
          expect.objectContaining({
            text: expect.stringContaining("explore stopped or timed out"),
          }),
        ],
      });
      expect(child.abort).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps active nested Explore running beyond the inactivity threshold", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    try {
      const promptDone = deferred();
      const promptStarted = deferred();
      const child = makeSession("active result");
      child.prompt = vi.fn(async () => {
        promptStarted.resolve();
        await promptDone.promise;
      });
      const runtime = new SubagentRuntime(makePi() as never, {
        modelPresets: lowPreset,
        createSession: vi.fn(async () => ({ session: child })),
      });
      const parent = runtime.queue({
        owner: "public-tool",
        type: "Worker",
        description: "general",
        cwd: "/workspace",
      });
      let settled = false;

      const resultPromise = runtime
        .runExploreTool(parent, { question: "inspect" }, makeCtx() as never)
        .finally(() => {
          settled = true;
        });
      await promptStarted.promise;

      await vi.advanceTimersByTimeAsync(90_000);
      child.messages.push({
        role: "assistant",
        timestamp: Date.now(),
        content: [{ type: "text", text: "progress 1" }],
      });
      await vi.advanceTimersByTimeAsync(90_000);
      child.messages.push({
        role: "assistant",
        timestamp: Date.now(),
        content: [{ type: "text", text: "progress 2" }],
      });
      await vi.advanceTimersByTimeAsync(90_000);
      await flushPromises();

      expect(child.abort).not.toHaveBeenCalled();
      expect(settled).toBe(false);

      promptDone.resolve();
      await expect(resultPromise).resolves.toMatchObject({
        content: [expect.objectContaining({ text: "active result" })],
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps subscription activity newer than stale message timestamps", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    try {
      const promptDone = deferred();
      const promptStarted = deferred();
      const child = makeSession("active result");
      child.prompt = vi.fn(async () => {
        child.messages.push({
          role: "assistant",
          timestamp: Date.now(),
          content: [{ type: "text", text: "starting" }],
        });
        promptStarted.resolve();
        await promptDone.promise;
      });
      const runtime = new SubagentRuntime(makePi() as never, {
        modelPresets: lowPreset,
        createSession: vi.fn(async () => ({ session: child })),
      });
      const parent = runtime.queue({
        owner: "public-tool",
        type: "Worker",
        description: "general",
        cwd: "/workspace",
      });
      let settled = false;

      const resultPromise = runtime
        .runExploreTool(parent, { question: "inspect" }, makeCtx() as never)
        .finally(() => {
          settled = true;
        });
      await promptStarted.promise;
      const publishSessionEvent = (
        child.subscribe as unknown as {
          mock: { calls: Array<[(event: unknown) => void]> };
        }
      ).mock.calls[0]?.[0];
      if (publishSessionEvent === undefined) {
        throw new Error("session subscription was not registered");
      }

      await vi.advanceTimersByTimeAsync(90_000);
      publishSessionEvent({ toolName: "read" });
      await vi.advanceTimersByTimeAsync(50_000);
      await flushPromises();

      expect(child.abort).not.toHaveBeenCalled();
      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(40_000);
      publishSessionEvent({ toolName: "bash" });
      await vi.advanceTimersByTimeAsync(90_000);
      await flushPromises();

      expect(child.abort).not.toHaveBeenCalled();
      expect(settled).toBe(false);

      promptDone.resolve();
      await expect(resultPromise).resolves.toMatchObject({
        content: [expect.objectContaining({ text: "active result" })],
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("prevents recursion from Explore and nested parents", async () => {
    const pi = makePi();
    const createSession = vi.fn(async () => ({ session: makeSession() }));
    const runtime = new SubagentRuntime(pi as never, {
      modelPresets: lowPreset,
      createSession,
    });
    const exploreParent = runtime.queue({
      owner: "public-tool",
      type: "Explore",
      description: "explore",
      cwd: "/workspace",
    });
    const nestedParent = runtime.queue({
      owner: { kind: "nested", parentId: exploreParent.id, tool: "explore" },
      type: "Worker",
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
