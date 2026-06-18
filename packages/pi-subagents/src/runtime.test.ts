import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import {
  getSubagentRuntime,
  getSubagentRuntimes,
  SubagentRuntime,
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

function makeCtx() {
  return {
    cwd: "/workspace",
    model: { provider: "ctx", id: "default" },
    modelRegistry: {
      find: vi.fn((provider: string, modelId: string) => ({
        provider,
        id: modelId,
      })),
    },
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
