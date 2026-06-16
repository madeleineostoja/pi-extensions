import { describe, expect, it, vi } from "vitest";
import registerExtension from "./index.js";
import { SubagentRuntime } from "./runtime.js";

type ToolDef = {
  name: string;
  description: string;
  parameters: unknown;
  execute: (...args: any[]) => Promise<unknown>;
};

type Message = {
  customType?: string;
  content: string;
  display?: boolean;
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makePi(
  activeTools = ["read", "bash", "Agent", "get_subagent_result"],
) {
  const tools: ToolDef[] = [];
  const messages: Message[] = [];
  const handlers = new Map<string, Array<(payload: unknown) => void>>();
  const emitted: Array<{ event: string; payload: unknown }> = [];
  const events = {
    emit: (event: string, payload: unknown) => {
      emitted.push({ event, payload });
      for (const handler of handlers.get(event) ?? []) {
        handler(payload);
      }
    },
    on: (event: string, handler: (payload: unknown) => void) => {
      const eventHandlers = handlers.get(event) ?? [];
      eventHandlers.push(handler);
      handlers.set(event, eventHandlers);
      return () => {
        handlers.set(
          event,
          (handlers.get(event) ?? []).filter(
            (candidate) => candidate !== handler,
          ),
        );
      };
    },
  };
  return {
    tools,
    messages,
    emitted,
    pi: {
      events,
      on: vi.fn((event: string, handler: (payload: unknown) => void) => {
        events.on(event, handler);
      }),
      registerCommand: vi.fn(),
      registerTool: (tool: ToolDef) => tools.push(tool),
      sendMessage: (message: Message) => messages.push(message),
      getActiveTools: () => activeTools,
    },
  };
}

function makeCtx(overrides: Partial<any> = {}) {
  const contextModel = { provider: "ctx", id: "default" };
  return {
    cwd: "/workspace",
    model: contextModel,
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
  const calls: string[] = [];
  const extensionRunner = {
    hasHandlers: vi.fn(() => false),
    emit: vi.fn(async () => undefined),
  };
  return {
    calls,
    extensionRunner,
    session: {
      bindExtensions: vi.fn(async () => {
        calls.push("bindExtensions");
      }),
      prompt: vi.fn(async () => {
        calls.push("prompt");
      }),
      steer: vi.fn(async () => {
        calls.push("steer");
      }),
      abort: vi.fn(async () => {}),
      dispose: vi.fn(),
      getLastAssistantText: vi.fn(() => result),
      setActiveToolsByName: vi.fn((tools: string[]) => {
        calls.push(`setActiveTools:${tools.join(",")}`);
      }),
      extensionRunner: extensionRunner as any,
    },
  };
}

function collectConstStrings(value: unknown): string[] {
  if (value === null || typeof value !== "object") {
    return [];
  }
  const object = value as Record<string, unknown>;
  const current = typeof object.const === "string" ? [object.const] : [];
  return [
    ...current,
    ...Object.values(object).flatMap((entry) =>
      Array.isArray(entry)
        ? entry.flatMap(collectConstStrings)
        : collectConstStrings(entry),
    ),
  ];
}

describe("public subagent tools", () => {
  it("registers the public tools with the exact public agent choices", () => {
    const { pi, tools } = makePi();

    registerExtension(pi as never);

    expect(pi.on).toHaveBeenCalledWith("session_start", expect.any(Function));
    expect(tools.map((tool) => tool.name)).toEqual([
      "Agent",
      "get_subagent_result",
      "steer_subagent",
    ]);
    expect(tools[0].description).toContain("foreground");
    expect(tools[1].description).toContain("wait:true");
    expect(tools[1].description).toContain("do not poll");
    expect(tools[2].description).toContain("wait:true");
    expect(collectConstStrings(tools[0].parameters)).toEqual([
      "General",
      "Explore",
      "Review",
      "foreground",
      "background",
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
  });

  it("runs pi-implement managed background sessions and waits for completion", async () => {
    const { pi } = makePi(["read", "bash", "Agent", "edit"]);
    const promptDone = deferred<void>();
    const { session } = makeSession("implemented");
    session.prompt = vi.fn(() => promptDone.promise);
    const createSession = vi.fn(async () => ({ session }));
    const runtime = new SubagentRuntime(pi as never, { createSession });

    const started = await runtime.runManagedAgent({
      owner: { kind: "internal", name: "pi-implement" },
      type: "general-purpose",
      prompt: "implement",
      description: "implement task",
      cwd: "/task-worktree",
      model: "p/m",
      mode: "background",
      ctx: makeCtx() as never,
    });

    expect(started).toMatchObject({
      id: "subagent-1",
      status: "running",
      owner: { kind: "internal", name: "pi-implement" },
    });
    const joined = runtime.wait(started.id);
    promptDone.resolve();
    await expect(joined).resolves.toMatchObject({
      id: started.id,
      status: "completed",
      result: "implemented",
    });
    expect(createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: "/task-worktree",
        model: { provider: "p", id: "m" },
        customTools: [expect.objectContaining({ name: "explore" })],
      }),
    );
    expect(session.setActiveToolsByName).toHaveBeenCalledWith([
      "read",
      "bash",
      "edit",
      "explore",
    ]);
  });

  it("runs foreground agents to completion after binding inherited extensions", async () => {
    const { pi } = makePi(["read", "bash", "Agent", "steer_subagent"]);
    const { session, calls } = makeSession("final answer");
    const createSession = vi.fn(async (_options: any) => ({ session }));
    const runtime = new SubagentRuntime(pi as never, { createSession });

    const result = await runtime.runPublicAgent({
      type: "General",
      prompt: "do work",
      cwd: "/workspace",
      ctx: makeCtx() as never,
    });

    expect(result).toMatchObject({
      status: "completed",
      result: "final answer",
      extensionBinding: "bound",
    });
    expect(createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: "/workspace",
        model: { provider: "ctx", id: "default" },
      }),
    );
    expect(createSession.mock.calls[0][0]).not.toHaveProperty("thinkingLevel");
    expect(calls.indexOf("bindExtensions")).toBeLessThan(
      calls.indexOf("prompt"),
    );
    expect(session.bindExtensions).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "print" }),
    );
    expect(session.bindExtensions).toHaveBeenCalledWith(
      expect.not.objectContaining({ uiContext: expect.anything() }),
    );
    expect(session.setActiveToolsByName).toHaveBeenCalledWith([
      "read",
      "bash",
      "explore",
    ]);
    expect(session.prompt).toHaveBeenCalledWith("do work", {
      source: "extension",
    });
  });

  it("starts background agents immediately and emits no completion notification", async () => {
    const { pi, messages } = makePi();
    const promptDone = deferred<void>();
    const { session, extensionRunner } = makeSession("background done");
    session.prompt = vi.fn(() => promptDone.promise);
    const runtime = new SubagentRuntime(pi as never, {
      createSession: vi.fn(async () => ({ session })),
    });

    const started = await runtime.runPublicAgent({
      type: "Explore",
      prompt: "inspect",
      cwd: "/workspace",
      ctx: makeCtx() as never,
      mode: "background",
    });

    expect(started).toMatchObject({ status: "running" });
    expect(messages).toEqual([]);
    promptDone.resolve();
    await expect(runtime.wait(started.id)).resolves.toMatchObject({
      status: "completed",
      result: "background done",
    });
    expect(messages).toEqual([]);
    expect(extensionRunner.emit).not.toHaveBeenCalled();
  });

  it("emits child session shutdown before disposing completed sessions", async () => {
    const { pi } = makePi();
    const { session, extensionRunner } = makeSession("final answer");
    extensionRunner.hasHandlers.mockReturnValue(true);
    const runtime = new SubagentRuntime(pi as never, {
      createSession: vi.fn(async () => ({ session })),
    });

    await runtime.runPublicAgent({
      type: "General",
      prompt: "do work",
      cwd: "/workspace",
      ctx: makeCtx() as never,
    });

    expect(extensionRunner.emit).toHaveBeenCalledWith({
      type: "session_shutdown",
      reason: "quit",
    });
    expect(extensionRunner.emit.mock.invocationCallOrder[0]).toBeLessThan(
      session.dispose.mock.invocationCallOrder[0],
    );
  });

  it("checks status immediately or waits for terminal status", async () => {
    const { pi } = makePi();
    const promptDone = deferred<void>();
    const { session } = makeSession("joined");
    session.prompt = vi.fn(() => promptDone.promise);
    const runtime = new SubagentRuntime(pi as never, {
      createSession: vi.fn(async () => ({ session })),
    });
    const started = await runtime.runPublicAgent({
      type: "Review",
      prompt: "review",
      cwd: "/workspace",
      ctx: makeCtx() as never,
      mode: "background",
    });

    await expect(runtime.result(started.id, false)).resolves.toMatchObject({
      status: "running",
    });
    const joined = runtime.result(started.id, true);
    promptDone.resolve();
    await expect(joined).resolves.toMatchObject({
      status: "completed",
      result: "joined",
    });
  });

  it("queues steering before session initialization and rejects terminal records", async () => {
    const { pi } = makePi();
    const sessionReady = deferred<{
      session: ReturnType<typeof makeSession>["session"];
    }>();
    const promptDone = deferred<void>();
    const { session } = makeSession("steered");
    session.prompt = vi.fn(() => promptDone.promise);
    const runtime = new SubagentRuntime(pi as never, {
      createSession: vi.fn(() => sessionReady.promise),
    });

    const started = await runtime.runPublicAgent({
      type: "Explore",
      prompt: "inspect",
      cwd: "/workspace",
      ctx: makeCtx() as never,
      mode: "background",
    });
    await expect(runtime.steer(started.id, "look here")).resolves.toMatchObject(
      { status: "running" },
    );
    expect(session.steer).not.toHaveBeenCalled();

    sessionReady.resolve({ session });
    await vi.waitFor(() =>
      expect(session.steer).toHaveBeenCalledWith("look here"),
    );
    promptDone.resolve();
    const final = await runtime.wait(started.id);
    await expect(runtime.steer(final.id, "too late")).rejects.toThrow(
      /Cannot steer subagent .* completed/,
    );
    await expect(runtime.steer("missing", "hello")).rejects.toThrow(
      /Unknown subagent missing/,
    );
  });

  it("falls through to session thinking defaults without an explicit or configured override", async () => {
    const { pi } = makePi(["read"]);
    const { session } = makeSession();
    const createSession = vi.fn(async (_options: any) => ({ session }));
    const runtime = new SubagentRuntime(pi as never, {
      createSession,
      publicConfig: {
        agents: { General: {}, Explore: {}, Review: {} },
      },
    });

    const result = await runtime.runPublicAgent({
      type: "Review",
      prompt: "review",
      cwd: "/workspace",
      ctx: makeCtx() as never,
    });

    expect(result).not.toHaveProperty("thinking");
    expect(createSession.mock.calls[0][0]).not.toHaveProperty("thinkingLevel");
  });

  it("marks resolved assistant/provider errors as failed", async () => {
    const { pi } = makePi(["read"]);
    const { session } = makeSession(undefined);
    Object.defineProperty(session, "state", {
      value: { errorMessage: "provider unavailable" },
    });
    const runtime = new SubagentRuntime(pi as never, {
      createSession: vi.fn(async () => ({ session })),
    });

    await expect(
      runtime.runPublicAgent({
        type: "Explore",
        prompt: "inspect",
        cwd: "/workspace",
        ctx: makeCtx() as never,
      }),
    ).resolves.toMatchObject({
      status: "failed",
      error: "provider unavailable",
    });
  });

  it("prefers explicit model and thinking over public config", async () => {
    const { pi } = makePi(["read"]);
    const { session } = makeSession();
    const createSession = vi.fn(async (_options: any) => ({ session }));
    const ctx = makeCtx();
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

    await runtime.runPublicAgent({
      type: "Explore",
      prompt: "inspect",
      cwd: "/workspace",
      ctx: ctx as never,
      model: "explicit/model",
      thinking: "high",
    });

    expect(ctx.modelRegistry.find).toHaveBeenCalledWith("explicit", "model");
    expect(createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        model: { provider: "explicit", id: "model" },
        thinkingLevel: "high",
      }),
    );
  });
});
