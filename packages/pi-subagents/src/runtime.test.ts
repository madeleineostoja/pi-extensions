import {
  SessionManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import {
  getSubagentRuntime,
  MANAGED_COMPLETION_TOOL_NAME,
  getSubagentRuntimes,
  SubagentRuntime,
  TERMINAL_MESSAGE_TAIL_LIMIT,
} from "./runtime.js";

type Message = {
  customType?: string;
  content: string;
  display?: boolean;
};

function fakePi() {
  const messages: Message[] = [];
  return {
    messages,
    pi: {
      sendMessage: (message: Message) => messages.push(message),
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function asAgentSession<T>(session: T): T & AgentSession {
  return session as T & AgentSession;
}

function makeSession(result = "done") {
  const extensionRunner = {
    hasHandlers: vi.fn(() => false),
    emit: vi.fn(async () => undefined),
  } as never;
  return asAgentSession({
    bindExtensions: vi.fn(async () => undefined),
    prompt: vi.fn(async (): Promise<void> => undefined),
    steer: vi.fn(async () => undefined),
    abort: vi.fn(async () => undefined),
    dispose: vi.fn(),
    getLastAssistantText: vi.fn(() => result),
    setActiveToolsByName: vi.fn(),
    state: {},
    messages: [] as AgentSession["messages"],
    sessionId: "session-id",
    sessionFile: undefined,
    subscribe: vi.fn(() => vi.fn()),
    getAllTools: vi.fn(() => []),
    extensionRunner,
  });
}

function makeCtx(overrides: Record<string, unknown> = {}) {
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

function completionTool(options: unknown): {
  executionMode?: string;
  parameters: unknown;
  execute: (...args: any[]) => Promise<unknown>;
} {
  const customTools = (options as { customTools?: unknown[] }).customTools;
  const tool = customTools?.find(
    (candidate) =>
      (candidate as { name?: string }).name === MANAGED_COMPLETION_TOOL_NAME,
  );
  if (!tool) {
    throw new Error("Managed completion tool was not registered.");
  }
  return tool as {
    executionMode?: string;
    parameters: unknown;
    execute: (...args: any[]) => Promise<unknown>;
  };
}

describe("SubagentRuntime", () => {
  it("returns a singleton runtime per pi instance and tracks known runtimes", () => {
    const { pi } = fakePi();
    const runtime = getSubagentRuntime(pi as never);

    expect(runtime).toBe(getSubagentRuntime(pi as never));
    expect(getSubagentRuntimes()).toContain(runtime);
  });

  it("reuses the existing runtime across module reloads", async () => {
    const { pi } = fakePi();
    const runtime = getSubagentRuntime(pi as never);
    const queued = runtime.queue({
      owner: "owner",
      type: "General",
      description: "survives reload",
      cwd: "/workspace",
    });

    runtime.handleSessionShutdown("reload");
    runtime.beginSession("reload");
    vi.resetModules();
    const reloaded = await import("./runtime.js");
    const afterReload = reloaded.getSubagentRuntime(pi as never);
    const queuedAfterReload = afterReload.queue({
      owner: "owner",
      type: "General",
      description: "survives next reload",
      cwd: "/workspace",
    });
    vi.resetModules();
    const reloadedAgain = await import("./runtime.js");
    const afterSecondReload = reloadedAgain.getSubagentRuntime(pi as never);

    expect(afterReload).toBe(runtime);
    expect(afterReload.snapshot(queued.id)).toEqual(queued);
    expect(afterSecondReload).toBe(runtime);
    expect(afterSecondReload.snapshot(queued.id)).toEqual(queued);
    expect(afterSecondReload.snapshot(queuedAfterReload.id)).toEqual(
      queuedAfterReload,
    );
  });

  it("scopes snapshots, inspections, and subscriptions to the active session", () => {
    const { pi } = fakePi();
    const runtime = new SubagentRuntime(pi as never);
    const previous = runtime.queue({
      owner: "owner",
      type: "General",
      description: "previous session",
      cwd: "/workspace",
    });

    runtime.beginSession();
    const current = runtime.queue({
      owner: "owner",
      type: "General",
      description: "current session",
      cwd: "/workspace",
    });
    const previousListener = vi.fn();
    const currentListener = vi.fn();

    expect(runtime.snapshots()).toEqual([current]);
    expect(runtime.snapshot(previous.id)).toBeUndefined();
    expect(runtime.snapshot(current.id)).toEqual(current);
    expect(runtime.inspect(previous.id)).toBeUndefined();
    expect(runtime.inspect(current.id)).toEqual({
      snapshot: current,
      messages: [],
    });
    runtime.subscribe(previous.id, previousListener)();
    const unsubscribeCurrent = runtime.subscribe(current.id, currentListener);
    runtime.start(current.id);

    expect(previousListener).not.toHaveBeenCalled();
    expect(currentListener).not.toHaveBeenCalled();
    unsubscribeCurrent();
    runtime.stop(current.id);
    expect(currentListener).not.toHaveBeenCalled();
  });

  it("models queued, running, and completed snapshots with metadata", async () => {
    const { pi } = fakePi();
    const runtime = new SubagentRuntime(pi as never);
    const queued = runtime.queue({
      owner: "pi-implement",
      type: "General",
      description: "Do work",
      cwd: "/workspace",
      model: "provider/model",
      thinking: "high",
      extensionBinding: "bound",
    });

    expect(queued).toMatchObject({
      id: "subagent-1",
      status: "queued",
      owner: "pi-implement",
      type: "General",
      description: "Do work",
      cwd: "/workspace",
      model: "provider/model",
      thinking: "high",
      extensionBinding: "bound",
    });
    expect(queued.timestamps.queuedAt).toEqual(expect.any(String));

    const running = runtime.start(queued.id);
    expect(running.status).toBe("running");
    expect(running.timestamps.startedAt).toEqual(expect.any(String));

    const waiting = runtime.wait(queued.id);
    const completed = runtime.complete(queued.id, { text: "done" });
    await expect(waiting).resolves.toEqual(completed);
    expect(completed).toMatchObject({
      status: "completed",
      result: { text: "done" },
    });
    expect(completed.timestamps.completedAt).toEqual(expect.any(String));
    expect(runtime.snapshot(queued.id)).toEqual(completed);
    expect(runtime.snapshots()).toEqual([completed]);
  });

  it("refreshes health for public snapshot accessors", async () => {
    const { pi } = fakePi();
    const promptDone = deferred<void>();
    const session = makeSession("fallback answer");
    session.prompt = vi.fn(() => promptDone.promise);
    const runtime = new SubagentRuntime(pi as never, {
      createSession: vi.fn(async () => ({ session })),
    });
    const started = await runtime.runManagedAgent({
      type: "General",
      prompt: "work",
      description: "work",
      cwd: "/workspace",
      ctx: makeCtx() as never,
      mode: "background",
    });
    await vi.waitFor(() => expect(session.prompt).toHaveBeenCalled());

    Object.assign(session, {
      sessionId: "session-1",
      sessionFile: "/tmp/session.jsonl",
      messages: [
        {
          role: "assistant",
          timestamp: 1_700_000_000_000,
          usage: { input: 2, output: 3, cacheRead: 5 },
          content: [
            { type: "text", text: "Working on it" },
            { type: "toolCall", name: "read" },
            { type: "text", value: "ignored malformed part" },
          ],
        },
        { role: "toolResult", toolName: "read", timestamp: 1_700_000_001_000 },
      ],
    });

    const health = runtime.snapshot(started.id)?.health;
    expect(health).toMatchObject({
      turns: 1,
      toolUses: 1,
      tokensTotal: 10,
      activeTool: "read",
      lastActivity: "2023-11-14T22:13:21.000Z",
      lastAssistantText: "Working on it",
      transcript: {
        sessionId: "session-1",
        sessionFile: "/tmp/session.jsonl",
      },
    });

    session.messages = [
      {
        role: "assistant",
        content: [{ type: "text", text: "Updated answer" }],
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 12,
          cost: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            total: 0,
          },
        },
      } as AgentSession["messages"][number],
    ];
    expect(runtime.snapshots()[0]?.health).toMatchObject({
      turns: 1,
      tokensTotal: 12,
      lastAssistantText: "Updated answer",
    });

    runtime.stop(started.id);
    promptDone.resolve();
  });

  it("inspects live session messages and notifies subscribers from session events until unsubscribed", async () => {
    const { pi } = fakePi();
    const promptDone = deferred<void>();
    const session = makeSession("fallback answer");
    session.prompt = vi.fn(() => promptDone.promise);
    const runtime = new SubagentRuntime(pi as never, {
      createSession: vi.fn(async () => ({ session })),
    });
    const started = await runtime.runManagedAgent({
      type: "General",
      prompt: "work",
      description: "work",
      cwd: "/workspace",
      ctx: makeCtx() as never,
      mode: "background",
    });
    await vi.waitFor(() => expect(session.prompt).toHaveBeenCalled());
    const listener = vi.fn();
    const unsubscribe = runtime.subscribe(started.id, listener);
    session.messages.push({
      role: "assistant",
      timestamp: 1_700_000_000_000,
      content: [{ type: "text", text: "live update" }],
    } as AgentSession["messages"][number]);
    const publishSessionEvent = (
      session.subscribe as unknown as {
        mock: { calls: Array<[(event: unknown) => void]> };
      }
    ).mock.calls[0]?.[0];

    publishSessionEvent?.({ toolCall: { name: "bash" } });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(runtime.inspect(started.id)).toMatchObject({
      snapshot: {
        health: { activeTool: "bash", lastAssistantText: "live update" },
      },
      messages: session.messages,
    });

    unsubscribe();
    publishSessionEvent?.({ toolCall: { name: "read" } });
    expect(listener).toHaveBeenCalledTimes(1);
    runtime.stop(started.id);
    promptDone.resolve();
  });

  it("uses an in-memory session manager and retains an immutable bounded terminal tail", async () => {
    const { pi } = fakePi();
    const promptDone = deferred<void>();
    const session = makeSession("done");
    session.prompt = vi.fn(() => promptDone.promise);
    let sessionManager: SessionManager | undefined;
    const createSession = vi.fn(
      async (options: { sessionManager?: SessionManager }) => {
        sessionManager = options.sessionManager;
        return { session };
      },
    );
    const runtime = new SubagentRuntime(pi as never, {
      createSession: createSession as never,
    });
    const started = await runtime.runManagedAgent({
      type: "General",
      prompt: "work",
      cwd: "/workspace",
      ctx: makeCtx() as never,
      mode: "background",
    });
    await vi.waitFor(() => expect(session.prompt).toHaveBeenCalled());
    session.messages.push(
      ...Array.from(
        { length: TERMINAL_MESSAGE_TAIL_LIMIT + 1 },
        (_, index) =>
          ({
            role: "assistant",
            content: [{ type: "text", text: `message ${index}` }],
          }) as AgentSession["messages"][number],
      ),
    );
    promptDone.resolve();

    await runtime.wait(started.id);

    expect(sessionManager).toBeInstanceOf(SessionManager);
    expect(sessionManager?.getSessionFile()).toBeUndefined();
    const inspection = runtime.inspect(started.id);
    expect(inspection?.snapshot.status).toBe("completed");
    expect(inspection?.messages).toHaveLength(TERMINAL_MESSAGE_TAIL_LIMIT);
    expect(inspection?.messages[0]).toMatchObject({
      content: [{ text: "message 1" }],
    });
    expect(session.dispose).toHaveBeenCalledTimes(1);
    session.messages[session.messages.length - 1] = {
      role: "assistant",
      content: [{ type: "text", text: "mutated" }],
    } as AgentSession["messages"][number];
    expect(runtime.inspect(started.id)?.messages.at(-1)).toMatchObject({
      content: [{ text: `message ${TERMINAL_MESSAGE_TAIL_LIMIT}` }],
    });
  });

  it("does not prompt or activate tools when stopped during extension binding", async () => {
    const { pi } = fakePi();
    const binding = deferred<void>();
    const session = makeSession("done");
    session.bindExtensions = vi.fn(() => binding.promise.then(() => undefined));
    const runtime = new SubagentRuntime(pi as never, {
      createSession: vi.fn(async () => ({ session })),
    });
    const started = await runtime.runManagedAgent({
      type: "General",
      prompt: "work",
      cwd: "/workspace",
      ctx: makeCtx() as never,
      mode: "background",
    });
    await vi.waitFor(() => expect(session.bindExtensions).toHaveBeenCalled());

    runtime.stop(started.id);
    binding.resolve();
    await runtime.wait(started.id);

    expect(session.setActiveToolsByName).not.toHaveBeenCalled();
    expect(session.prompt).not.toHaveBeenCalled();
    expect(session.dispose).toHaveBeenCalledTimes(1);
    expect(runtime.inspect(started.id)).toMatchObject({
      snapshot: { status: "stopped", extensionBinding: "unbound" },
    });
  });

  it("does not prompt or activate tools when retired during extension binding", async () => {
    const { pi } = fakePi();
    const binding = deferred<void>();
    const session = makeSession("done");
    session.bindExtensions = vi.fn(() => binding.promise.then(() => undefined));
    const runtime = new SubagentRuntime(pi as never, {
      createSession: vi.fn(async () => ({ session })),
    });
    const started = await runtime.runManagedAgent({
      type: "General",
      prompt: "work",
      cwd: "/workspace",
      ctx: makeCtx() as never,
      mode: "background",
    });
    await vi.waitFor(() => expect(session.bindExtensions).toHaveBeenCalled());
    const waiter = runtime.wait(started.id);

    runtime.handleSessionShutdown("quit");
    binding.resolve();
    await runtime.waitForShutdown();

    await expect(waiter).resolves.toMatchObject({ status: "stopped" });
    expect(session.setActiveToolsByName).not.toHaveBeenCalled();
    expect(session.prompt).not.toHaveBeenCalled();
    expect(session.dispose).toHaveBeenCalledTimes(1);
    expect(runtime.inspect(started.id)).toBeUndefined();
  });

  it("resolves waiters when a terminal inspector listener throws", async () => {
    const { pi } = fakePi();
    const promptDone = deferred<void>();
    const session = makeSession("done");
    session.prompt = vi.fn(() => promptDone.promise);
    const runtime = new SubagentRuntime(pi as never, {
      createSession: vi.fn(async () => ({ session })),
    });
    const started = await runtime.runManagedAgent({
      type: "General",
      prompt: "work",
      cwd: "/workspace",
      ctx: makeCtx() as never,
      mode: "background",
    });
    await vi.waitFor(() => expect(session.prompt).toHaveBeenCalled());
    const waiter = runtime.wait(started.id);
    runtime.subscribe(started.id, () => {
      throw new Error("broken inspector");
    });

    runtime.stop(started.id);

    await expect(waiter).resolves.toMatchObject({ status: "stopped" });
    expect(session.dispose).toHaveBeenCalledTimes(1);
  });

  it("models failed and stopped terminal states", () => {
    const { pi } = fakePi();
    const runtime = new SubagentRuntime(pi as never);
    const failed = runtime.queue({
      owner: "owner",
      type: "Internal",
      description: "fail",
      cwd: "/workspace",
    });
    const stopped = runtime.queue({
      owner: "owner",
      type: "Internal",
      description: "stop",
      cwd: "/workspace",
    });

    expect(runtime.fail(failed.id, new Error("boom"))).toMatchObject({
      status: "failed",
      error: "boom",
      extensionBinding: "unbound",
    });
    expect(runtime.stop(stopped.id, "cancelled")).toMatchObject({
      status: "stopped",
      error: "cancelled",
    });
  });

  it("rejects access to previous-session records", async () => {
    const { pi } = fakePi();
    const runtime = new SubagentRuntime(pi as never);
    const previous = runtime.queue({
      owner: "owner",
      type: "General",
      description: "previous",
      cwd: "/workspace",
    });

    runtime.beginSession("new");

    expect(runtime.snapshot(previous.id)).toBeUndefined();
    expect(runtime.snapshots()).toEqual([]);
    expect(() => runtime.stop(previous.id)).toThrow(
      `Unknown subagent ${previous.id}`,
    );
    expect(() => runtime.wait(previous.id)).toThrow(
      `Unknown subagent ${previous.id}`,
    );
    await expect(runtime.result(previous.id, false)).rejects.toThrow(
      `Unknown subagent ${previous.id}`,
    );
    await expect(runtime.steer(previous.id, "hello")).rejects.toThrow(
      `Unknown subagent ${previous.id}`,
    );
  });

  it("retirement removes current records, aborts live sessions, notifies subscribers, and resolves waiters", async () => {
    const { pi } = fakePi();
    const promptDone = deferred<void>();
    const session = makeSession("late result");
    const unsubscribeSession = vi.fn();
    session.prompt = vi.fn(() => promptDone.promise);
    session.subscribe = vi.fn(() => unsubscribeSession);
    const runtime = new SubagentRuntime(pi as never, {
      createSession: vi.fn(async () => ({ session })),
    });
    const started = await runtime.runManagedAgent({
      type: "General",
      prompt: "work",
      description: "work",
      cwd: "/workspace",
      ctx: makeCtx() as never,
      mode: "background",
    });
    await vi.waitFor(() => expect(session.prompt).toHaveBeenCalled());
    const waiter = runtime.wait(started.id);
    const listener = vi.fn(() => {
      expect(runtime.inspect(started.id)).toBeUndefined();
    });
    const unsubscribe = runtime.subscribe(started.id, listener);

    const retired = runtime.handleSessionShutdown("resume");
    unsubscribe();

    expect(retired).toHaveLength(1);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(unsubscribeSession).toHaveBeenCalledTimes(1);
    expect(session.abort).toHaveBeenCalledTimes(1);
    expect(runtime.snapshot(started.id)).toBeUndefined();
    expect(runtime.snapshots()).toEqual([]);
    await expect(waiter).resolves.toMatchObject({
      id: started.id,
      status: "stopped",
      error: "Session replaced (resume).",
    });
    expect(() => runtime.wait(started.id)).toThrow(
      `Unknown subagent ${started.id}`,
    );

    runtime.beginSession("resume");
    expect(runtime.snapshots()).toEqual([]);
    await expect(runtime.result(started.id, false)).rejects.toThrow(
      `Unknown subagent ${started.id}`,
    );
  });

  it("retires records for new and fork shutdowns but not reload", () => {
    const { pi } = fakePi();
    const runtime = new SubagentRuntime(pi as never);
    const keep = runtime.queue({
      owner: "owner",
      type: "General",
      description: "keep on reload",
      cwd: "/workspace",
    });

    expect(runtime.handleSessionShutdown("reload")).toEqual([]);
    runtime.beginSession("reload");
    expect(runtime.snapshot(keep.id)).toEqual(keep);

    expect(runtime.handleSessionShutdown("new")).toHaveLength(1);
    expect(runtime.snapshot(keep.id)).toBeUndefined();
    runtime.beginSession("new");
    const forked = runtime.queue({
      owner: "owner",
      type: "General",
      description: "fork replacement",
      cwd: "/workspace",
    });
    expect(runtime.handleSessionShutdown("fork")).toHaveLength(1);
    runtime.beginSession("fork");
    expect(runtime.snapshot(forked.id)).toBeUndefined();
  });

  it("ignores late prompt rejection after retirement without resurrecting or refailing", async () => {
    const { pi } = fakePi();
    const promptDone = deferred<void>();
    const session = makeSession("late result");
    session.prompt = vi.fn(() => promptDone.promise);
    const runtime = new SubagentRuntime(pi as never, {
      createSession: vi.fn(async () => ({ session })),
    });
    const run = runtime.runManagedAgent({
      type: "General",
      prompt: "work",
      description: "work",
      cwd: "/workspace",
      ctx: makeCtx() as never,
      mode: "foreground",
    });
    await vi.waitFor(() => expect(session.prompt).toHaveBeenCalled());
    const started = runtime.snapshots()[0];
    const waiter = runtime.wait(started.id);

    runtime.handleSessionShutdown("resume");
    const stopped = await waiter;
    promptDone.reject(new Error("late child failure"));

    await expect(run).resolves.toEqual(stopped);
    expect(session.dispose).toHaveBeenCalledTimes(1);
    expect(runtime.snapshot(started.id)).toBeUndefined();
    await expect(runtime.result(started.id, false)).rejects.toThrow(
      `Unknown subagent ${started.id}`,
    );
  });

  it("runs validated managed completion through the child prompt and cleans up before waiters resolve", async () => {
    const { pi } = fakePi();
    const schema = Type.Object({ summary: Type.Literal("accepted") });
    const session = makeSession("ignored prose");
    let options: unknown;
    const toolContext = { abort: vi.fn() };
    session.prompt = vi.fn(async () => {
      const tool = completionTool(options);
      expect(() =>
        validateToolArguments(tool as never, {
          type: "toolCall",
          id: "invalid-completion",
          name: MANAGED_COMPLETION_TOOL_NAME,
          arguments: { summary: "rejected" },
        }),
      ).toThrow(/Validation failed/);
      const params = validateToolArguments(tool as never, {
        type: "toolCall",
        id: "valid-completion",
        name: MANAGED_COMPLETION_TOOL_NAME,
        arguments: { summary: "accepted" },
      });
      await tool.execute(
        "complete-1",
        params,
        undefined,
        undefined,
        toolContext,
      );
    });
    const runtime = new SubagentRuntime(pi as never, {
      createSession: vi.fn(async (created) => {
        options = created;
        return { session };
      }),
    });

    const started = await runtime.runManagedAgent({
      type: "general-purpose",
      prompt: "work",
      cwd: "/workspace",
      ctx: makeCtx() as never,
      mode: "background",
      completion: { schema, description: "Return the final summary." },
    });
    const completed = await runtime.wait<{ summary: string }>(started.id);
    const typedResult: string | undefined = completed.result?.summary;

    expect(typedResult).toBe("accepted");
    expect(completed).toMatchObject({
      status: "completed",
      result: { summary: "accepted" },
    });
    expect(completionTool(options).executionMode).toBe("sequential");
    expect(toolContext.abort).toHaveBeenCalledOnce();
    expect(session.abort).toHaveBeenCalledOnce();
    expect(session.dispose).toHaveBeenCalledOnce();
    expect(session.subscribe.mock.results[0]?.value).toHaveBeenCalledOnce();
  });

  it("fails managed completion runs that settle without the completion tool", async () => {
    const { pi } = fakePi();
    const runtime = new SubagentRuntime(pi as never, {
      createSession: vi.fn(async () => ({ session: makeSession("prose") })),
    });

    await expect(
      runtime.runManagedAgent({
        type: "general-purpose",
        prompt: "work",
        cwd: "/workspace",
        ctx: makeCtx() as never,
        completion: {
          schema: Type.Object({ result: Type.String() }),
          description: "Return a result.",
        },
      }),
    ).resolves.toMatchObject({
      status: "failed",
      error: "Managed agent settled without invoking required completion tool.",
    });
  });

  it("preserves accepted completion across late cancellation and provider failures", async () => {
    const { pi } = fakePi();
    const schema = Type.Object({ result: Type.String() });
    const session = makeSession();
    let options: unknown;
    const controller = new AbortController();
    session.prompt = vi.fn(async () => {
      await completionTool(options).execute(
        "complete-1",
        { result: "accepted" },
        undefined,
        undefined,
        { abort: vi.fn() },
      );
      controller.abort();
      throw new Error("late provider failure");
    });
    const runtime = new SubagentRuntime(pi as never, {
      createSession: vi.fn(async (created) => {
        options = created;
        return { session };
      }),
    });

    const final = await runtime.runManagedAgent({
      type: "general-purpose",
      prompt: "work",
      cwd: "/workspace",
      ctx: makeCtx() as never,
      signal: controller.signal,
      completion: { schema, description: "Return a result." },
    });

    expect(final).toMatchObject({
      status: "completed",
      result: { result: "accepted" },
    });
  });

  it("stops before accepted completion and fails on pre-acceptance provider errors", async () => {
    const { pi } = fakePi();
    const controller = new AbortController();
    const pending = deferred<void>();
    const stoppedSession = makeSession();
    stoppedSession.prompt = vi.fn(() => pending.promise);
    const stoppedRuntime = new SubagentRuntime(pi as never, {
      createSession: vi.fn(async () => ({ session: stoppedSession })),
    });
    const stopped = await stoppedRuntime.runManagedAgent({
      type: "general-purpose",
      prompt: "work",
      cwd: "/workspace",
      ctx: makeCtx() as never,
      mode: "background",
      signal: controller.signal,
      completion: {
        schema: Type.Object({ result: Type.String() }),
        description: "Return a result.",
      },
    });
    await vi.waitFor(() => expect(stoppedSession.prompt).toHaveBeenCalled());
    controller.abort();
    await expect(stoppedRuntime.wait(stopped.id)).resolves.toMatchObject({
      status: "stopped",
      error: "Stopped by user.",
    });
    pending.resolve();

    const failedSession = makeSession();
    failedSession.prompt = vi.fn(async () => {
      throw new Error("provider unavailable");
    });
    const providerRuntime = new SubagentRuntime(pi as never, {
      createSession: vi.fn(async () => ({ session: failedSession })),
    });
    await expect(
      providerRuntime.runManagedAgent({
        type: "general-purpose",
        prompt: "work",
        cwd: "/workspace",
        ctx: makeCtx() as never,
        completion: {
          schema: Type.Object({ result: Type.String() }),
          description: "Return a result.",
        },
      }),
    ).resolves.toMatchObject({
      status: "failed",
      error: "provider unavailable",
    });

    const sessionFailure = makeSession();
    Object.defineProperty(sessionFailure, "state", {
      value: { errorMessage: "session unavailable" },
    });
    const sessionRuntime = new SubagentRuntime(pi as never, {
      createSession: vi.fn(async () => ({ session: sessionFailure })),
    });
    await expect(
      sessionRuntime.runManagedAgent({
        type: "general-purpose",
        prompt: "work",
        cwd: "/workspace",
        ctx: makeCtx() as never,
        completion: {
          schema: Type.Object({ result: Type.String() }),
          description: "Return a result.",
        },
      }),
    ).resolves.toMatchObject({
      status: "failed",
      error: "session unavailable",
    });
  });

  it("keeps earlier siblings effective and prevents later siblings after completion", async () => {
    const { pi } = fakePi();
    const session = makeSession();
    let options: unknown;
    const effects: string[] = [];
    session.prompt = vi.fn(async () => {
      effects.push("earlier sibling");
      const context = {
        abort: vi.fn(() => effects.push("completion abort")),
      };
      await completionTool(options).execute(
        "complete-1",
        { result: "complete" },
        undefined,
        undefined,
        context,
      );
      if (!context.abort.mock.calls.length) {
        effects.push("later sibling");
      }
    });
    const runtime = new SubagentRuntime(pi as never, {
      createSession: vi.fn(async (created) => {
        options = created;
        return { session };
      }),
    });

    const final = await runtime.runManagedAgent({
      type: "general-purpose",
      prompt: "work",
      cwd: "/workspace",
      ctx: makeCtx() as never,
      completion: {
        schema: Type.Object({ result: Type.String() }),
        description: "Return a result.",
      },
    });

    expect(final).toMatchObject({ result: { result: "complete" } });
    expect(effects).toEqual(["earlier sibling", "completion abort"]);
  });

  it("protects the reserved completion tool, rejects duplicates, and coexists with Explore", async () => {
    const { pi } = fakePi();
    const session = makeSession();
    let options: unknown;
    session.prompt = vi.fn(async () => {
      const tool = completionTool(options);
      await tool.execute(
        "complete-1",
        { result: "first" },
        undefined,
        undefined,
        { abort: vi.fn() },
      );
      await expect(
        tool.execute("complete-2", { result: "second" }, undefined, undefined, {
          abort: vi.fn(),
        }),
      ).rejects.toThrow("already been accepted");
    });
    const runtime = new SubagentRuntime(pi as never, {
      createSession: vi.fn(async (created) => {
        options = created;
        return { session };
      }),
    });

    const final = await runtime.runManagedAgent({
      type: "general-purpose",
      prompt: "work",
      cwd: "/workspace",
      ctx: makeCtx() as never,
      tools: ["read"],
      excludeTools: [MANAGED_COMPLETION_TOOL_NAME, "bash"],
      completion: {
        schema: Type.Object({ result: Type.String() }),
        description: "Return a result.",
      },
    });

    expect(final).toMatchObject({ result: { result: "first" } });
    expect((options as { tools: string[] }).tools).toEqual([
      "read",
      MANAGED_COMPLETION_TOOL_NAME,
    ]);
    expect((options as { excludeTools: string[] }).excludeTools).toEqual([
      "bash",
    ]);
    expect(
      (options as { customTools: Array<{ name: string }> }).customTools.map(
        (tool) => tool.name,
      ),
    ).toEqual(["explore", MANAGED_COMPLETION_TOOL_NAME]);
    expect(session.setActiveToolsByName).toHaveBeenCalledWith([
      "read",
      "explore",
      MANAGED_COMPLETION_TOOL_NAME,
    ]);
  });

  it("uses public config defaults for model and thinking metadata", () => {
    const { pi } = fakePi();
    const runtime = new SubagentRuntime(pi as never, {
      publicConfig: {
        agents: {
          General: {},
          Explore: { model: "provider/explore", thinking: "low" },
          Review: {},
        },
      },
    });

    expect(
      runtime.queue({
        owner: "public-tool",
        type: "Explore",
        description: "map the codebase",
        cwd: "/workspace",
      }),
    ).toMatchObject({
      model: "provider/explore",
      thinking: "low",
    });
  });
});
