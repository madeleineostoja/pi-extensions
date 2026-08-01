import {
  SessionManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import {
  createManagedSessionHarness,
  managedSessionContext,
  MANAGED_TEST_CWD,
  MANAGED_TEST_MODEL,
  MANAGED_TEST_PROVIDER,
  type FauxResponse,
} from "#test/managed-session";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { INSPECTION_RECORD_LIMIT } from "./inspection.js";
import {
  getSubagentRuntime,
  MANAGED_COMPLETION_TOOL_NAME,
  SubagentRuntime,
  serializeInspectionForSummary,
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
    getContextUsage: vi.fn<AgentSession["getContextUsage"]>(() => undefined),
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

const TEST_PROVIDER = MANAGED_TEST_PROVIDER;
const TEST_MODEL = MANAGED_TEST_MODEL;
const TEST_CWD = MANAGED_TEST_CWD;

async function createRealSessionHarness(responses: FauxResponse) {
  return createManagedSessionHarness(responses);
}

function realContext(model: unknown, modelRegistry: unknown) {
  return makeCtx(managedSessionContext({ model, modelRegistry })) as never;
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
  it("returns a singleton runtime per pi instance", () => {
    const { pi } = fakePi();
    const runtime = getSubagentRuntime(pi as never);

    expect(runtime).toBe(getSubagentRuntime(pi as never));
  });

  it("rebinds fresh APIs sharing one event bus while isolating distinct buses", () => {
    const events = {};
    const first = { ...fakePi().pi, events };
    const second = { ...fakePi().pi, events };
    const child = { ...fakePi().pi, events: {} };
    const runtime = getSubagentRuntime(first as never);
    const record = runtime.queue({
      owner: "owner",
      type: "General",
      description: "reload",
      cwd: "/workspace",
    });

    expect(getSubagentRuntime(second as never)).toBe(runtime);
    expect(runtime.pi).toBe(second);
    expect(
      getSubagentRuntime(second as never).snapshot(record.id),
    ).toMatchObject({
      id: record.id,
      status: "queued",
    });
    expect(getSubagentRuntime(child as never)).not.toBe(runtime);
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
    expect(runtime.inspect(current.id)).toMatchObject({
      snapshot: current,
      messages: [],
      activity: [],
      omittedMessages: 0,
      omittedActivity: 0,
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
      owner: "pipkin:implement",
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
      owner: "pipkin:implement",
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

  it("preserves distinct cwd values for trusted managed calls", async () => {
    const { pi } = fakePi();
    const sessions = [makeSession("first"), makeSession("second")];
    const createdCwds: string[] = [];
    const createSession = vi.fn(async (options?: { cwd?: string }) => {
      createdCwds.push(options?.cwd ?? "");
      return { session: sessions.shift()! };
    });
    const runtime = new SubagentRuntime(pi as never, { createSession });

    const first = await runtime.runManagedAgent({
      type: "internal",
      prompt: "first",
      cwd: "/trusted/first",
      ctx: makeCtx() as never,
    });
    const second = await runtime.runManagedAgent({
      type: "internal",
      prompt: "second",
      cwd: "/trusted/second",
      ctx: makeCtx() as never,
    });

    expect([first.cwd, second.cwd]).toEqual([
      "/trusted/first",
      "/trusted/second",
    ]);
    expect(runtime.snapshots().map((snapshot) => snapshot.cwd)).toEqual([
      "/trusted/first",
      "/trusted/second",
    ]);
    expect(createdCwds).toEqual(["/trusted/first", "/trusted/second"]);
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

    session.getSessionStats = vi.fn(() => ({
      assistantMessages: 1,
      toolCalls: 1,
      tokens: { total: 10 },
      cost: 0.25,
      contextUsage: { tokens: 8, contextWindow: 100, percent: 8 },
    })) as never;
    Object.assign(session, {
      sessionId: "session-1",
      sessionFile: "/tmp/session.jsonl",
      messages: [
        {
          role: "assistant",
          timestamp: 1_700_000_000_000,
          usage: {
            input: 2,
            output: 3,
            cacheRead: 5,
            cost: { total: 0.25 },
          },
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
      estimatedCost: 0.25,
      contextUsage: { tokens: 8, contextWindow: 100, percent: 8 },
      peakContextTokens: 8,
      lastActivity: "2023-11-14T22:13:21.000Z",
      lastAssistantText: "Working on it",
      transcript: {
        sessionId: "session-1",
        sessionFile: "/tmp/session.jsonl",
      },
    });

    session.getSessionStats = vi.fn(() => ({
      assistantMessages: 1,
      toolCalls: 0,
      tokens: { total: 12 },
      cost: 0.5,
      contextUsage: { tokens: 20, contextWindow: 100, percent: 20 },
    })) as never;
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
            total: 0.5,
          },
        },
      } as AgentSession["messages"][number],
    ];
    expect(runtime.snapshots()[0]?.health).toMatchObject({
      turns: 1,
      tokensTotal: 12,
      estimatedCost: 0.5,
      contextUsage: { tokens: 20, contextWindow: 100, percent: 20 },
      peakContextTokens: 20,
      lastAssistantText: "Updated answer",
    });

    session.getSessionStats = vi.fn(() => ({
      assistantMessages: 1,
      toolCalls: 0,
      tokens: { total: 12 },
      cost: 0.5,
      contextUsage: { tokens: null, contextWindow: 100, percent: null },
    })) as never;
    expect(runtime.snapshot(started.id)?.health).toMatchObject({
      contextUsage: { tokens: null, contextWindow: 100, percent: null },
      peakContextTokens: 20,
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
        health: { lastAssistantText: "live update" },
      },
      messages: [{ role: "assistant", timestamp: "2023-11-14T22:13:20.000Z" }],
    });

    unsubscribe();
    publishSessionEvent?.({ toolCall: { name: "read" } });
    expect(listener).toHaveBeenCalledTimes(1);
    runtime.stop(started.id);
    promptDone.resolve();
  });

  it("serializes steering and continues after one rejected delivery", async () => {
    const { pi } = fakePi();
    const promptDone = deferred<void>();
    const first = deferred<void>();
    const second = deferred<void>();
    const calls: string[] = [];
    const session = makeSession();
    session.prompt = vi.fn(() => promptDone.promise);
    session.steer = vi.fn((message: string) => {
      calls.push(message);
      return message === "first" ? first.promise : second.promise;
    }) as never;
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
    expect(runtime.snapshot(started.id)?.canSteer).toBe(true);
    const one = runtime.steer(started.id, "first");
    const two = runtime.steer(started.id, "second");
    expect(calls).toEqual(["first"]);
    first.reject(new Error("rejected"));
    await expect(one).rejects.toThrow("rejected");
    await vi.waitFor(() => expect(calls).toEqual(["first", "second"]));
    second.resolve();
    await expect(two).resolves.toMatchObject({ status: "running" });
    expect(runtime.snapshot(started.id)?.health?.pendingSteering).toBe(0);
    runtime.stop(started.id);
    promptDone.resolve();
  });

  it("orders interleaved runtime and tool activity chronologically", async () => {
    const { pi } = fakePi();
    const promptDone = deferred<void>();
    const session = makeSession();
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
    await runtime.steer(started.id, "first guidance");
    const toolTimestamp = Date.now() + 10_000;
    session.messages.push(
      fauxAssistantMessage(
        fauxToolCall(
          "read",
          { path: "/workspace/file.ts" },
          { id: "later-tool" },
        ),
        { timestamp: toolTimestamp },
      ),
      {
        role: "toolResult",
        timestamp: toolTimestamp + 1,
        toolCallId: "later-tool",
        toolName: "read",
        content: [{ type: "text", text: "done" }],
        isError: false,
      } as AgentSession["messages"][number],
    );

    expect(
      runtime.inspect(started.id)?.activity.map((entry) => entry.kind),
    ).toEqual(["steering", "steering", "tool"]);
    runtime.stop(started.id);
    promptDone.resolve();
  });

  it("uses an in-memory session manager and retains an immutable bounded terminal inspection", async () => {
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
        { length: INSPECTION_RECORD_LIMIT + 1 },
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
    expect(inspection?.messages).toHaveLength(INSPECTION_RECORD_LIMIT);
    expect(inspection?.messages[0]).toMatchObject({ text: "message 1" });
    expect(session.dispose).toHaveBeenCalledTimes(1);
    session.messages[session.messages.length - 1] = {
      role: "assistant",
      content: [{ type: "text", text: "mutated" }],
    } as AgentSession["messages"][number];
    expect(runtime.inspect(started.id)?.messages.at(-1)).toMatchObject({
      text: `message ${INSPECTION_RECORD_LIMIT}`,
    });
  });

  it("captures terminal messages and canonical health after abort settles", async () => {
    const { pi } = fakePi();
    const promptDone = deferred<void>();
    const session = makeSession();
    session.prompt = vi.fn(() => promptDone.promise);
    session.messages.push(
      fauxAssistantMessage(
        fauxToolCall("bash", { command: "npm test" }, { id: "active-tool" }),
        { timestamp: Date.now() },
      ),
    );
    session.abort = vi.fn(async () => {
      session.messages.push({
        role: "toolResult",
        timestamp: Date.now(),
        toolCallId: "active-tool",
        toolName: "bash",
        content: [{ type: "text", text: "aborted" }],
        isError: true,
      } as AgentSession["messages"][number]);
      session.getSessionStats = vi.fn(() => ({
        assistantMessages: 1,
        toolCalls: 1,
        tokens: { total: 42 },
        cost: 0.2,
        contextUsage: { tokens: 20, contextWindow: 100, percent: 20 },
      })) as never;
    });
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

    runtime.stop(started.id);
    await runtime.wait(started.id);

    expect(runtime.inspect(started.id)).toMatchObject({
      snapshot: { health: { tokensTotal: 42 } },
      activity: [
        {
          kind: "tool",
          toolCallId: "active-tool",
          status: "interrupted",
          error: "aborted",
        },
      ],
    });
    promptDone.resolve();
  });

  it("keeps the summary fallback bounded and delimited when metadata is oversized", () => {
    const serialized = serializeInspectionForSummary({
      snapshot: {
        id: "agent",
        status: "completed",
        owner: "owner".repeat(30_000),
        type: "General",
        description: "summary target",
        cwd: "/workspace",
        extensionBinding: "bound",
        rosterVisibility: "show",
        timestamps: { queuedAt: "now", updatedAt: "now" },
      },
      messages: [],
      activity: [],
      omittedMessages: 0,
      omittedActivity: 0,
      compactedHistory: false,
    });

    expect(Buffer.byteLength(serialized)).toBeLessThanOrEqual(64 * 1024);
    expect(serialized).toMatch(/^.+\n<inspection>\n[\s\S]*\n<\/inspection>$/);
    const payload = serialized.slice(
      serialized.indexOf("\n<inspection>\n") + "\n<inspection>\n".length,
      -"\n</inspection>".length,
    );
    expect(JSON.parse(payload)).toMatchObject({
      summaryMetadataTruncated: true,
    });
  });

  it("passes resolved auth to summary completion", async () => {
    const { pi } = fakePi();
    const runtime = new SubagentRuntime(pi as never);
    const agent = runtime.queue({
      owner: "owner",
      type: "General",
      description: "summary target",
      cwd: "/workspace",
    });
    const completeSimple = vi.fn(async () => fauxAssistantMessage("summary"));

    await runtime.summarise(
      agent.id,
      { provider: "openai-codex", id: "gpt-5.3-codex" } as never,
      {
        apiKey: "oauth-token",
        headers: { "x-test": "header" },
        env: { TEST_AUTH: "value" },
      },
      { completeSimple },
    );

    expect(completeSimple).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "openai-codex" }),
      expect.any(Object),
      expect.objectContaining({
        apiKey: "oauth-token",
        headers: { "x-test": "header" },
        env: { TEST_AUTH: "value" },
      }),
    );
  });

  it("waits for stop during async session creation before disposing the eventual child", async () => {
    const { pi } = fakePi();
    const sessionReady = deferred<{ session: AgentSession }>();
    const session = makeSession("done");
    const createSession = vi.fn(() => sessionReady.promise);
    const runtime = new SubagentRuntime(pi as never, { createSession });
    const started = await runtime.runManagedAgent({
      type: "General",
      prompt: "work",
      cwd: "/workspace",
      ctx: makeCtx() as never,
      mode: "background",
    });

    await vi.waitFor(() => expect(createSession).toHaveBeenCalled());
    runtime.stop(started.id);
    const stopped = runtime.wait(started.id);
    await expect(
      Promise.race([stopped, Promise.resolve("pending")]),
    ).resolves.toBe("pending");
    sessionReady.resolve({ session });

    await expect(stopped).resolves.toMatchObject({ status: "stopped" });
    expect(session.abort).toHaveBeenCalledOnce();
    expect(session.dispose).toHaveBeenCalledOnce();
    expect(session.bindExtensions).not.toHaveBeenCalled();
    expect(session.prompt).not.toHaveBeenCalled();
  });

  it("waits for quit during async session creation before disposing the eventual child", async () => {
    const { pi } = fakePi();
    const sessionReady = deferred<{ session: AgentSession }>();
    const session = makeSession("done");
    const createSession = vi.fn(() => sessionReady.promise);
    const runtime = new SubagentRuntime(pi as never, { createSession });
    const started = await runtime.runManagedAgent({
      type: "General",
      prompt: "work",
      cwd: "/workspace",
      ctx: makeCtx() as never,
      mode: "background",
    });
    await vi.waitFor(() => expect(createSession).toHaveBeenCalled());

    runtime.handleSessionShutdown("quit");
    const shutdown = runtime.waitForShutdown();
    await expect(
      Promise.race([shutdown, Promise.resolve("pending")]),
    ).resolves.toBe("pending");
    sessionReady.resolve({ session });

    await expect(shutdown).resolves.toBeUndefined();
    expect(session.abort).toHaveBeenCalledOnce();
    expect(session.dispose).toHaveBeenCalledOnce();
    expect(session.bindExtensions).not.toHaveBeenCalled();
    expect(session.prompt).not.toHaveBeenCalled();
    expect(runtime.snapshot(started.id)).toBeUndefined();
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

  it("does not reuse a disposed runtime after disposing its child sessions", async () => {
    const { pi } = fakePi();
    const promptDone = deferred<void>();
    const session = makeSession("done");
    session.prompt = vi.fn(() => promptDone.promise);
    const managedRuntime = new SubagentRuntime(pi as never, {
      createSession: vi.fn(async () => ({ session })),
    });
    expect(getSubagentRuntime(pi as never)).toBe(managedRuntime);
    const started = await managedRuntime.runManagedAgent({
      type: "General",
      prompt: "work",
      cwd: "/workspace",
      ctx: makeCtx() as never,
      mode: "background",
    });
    await vi.waitFor(() => expect(session.prompt).toHaveBeenCalled());

    await managedRuntime.dispose();

    expect(session.abort).toHaveBeenCalledOnce();
    expect(session.dispose).toHaveBeenCalledOnce();
    expect(getSubagentRuntime(pi as never)).not.toBe(managedRuntime);
    expect(managedRuntime.snapshot(started.id)).toBeUndefined();
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
    expect(listener).toHaveBeenCalledTimes(2);
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

  it("waits for replacement cleanup before the replacement session proceeds", async () => {
    const { pi } = fakePi();
    const promptDone = deferred<void>();
    const session = makeSession("late result");
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

    runtime.handleSessionShutdown("resume");
    const replacement = runtime.beginSession("resume");
    expect(runtime.snapshot(started.id)).toBeUndefined();
    expect(session.dispose).not.toHaveBeenCalled();

    await runtime.waitForShutdown();

    expect(replacement).toBeUndefined();
    expect(session.abort).toHaveBeenCalledOnce();
    expect(session.dispose).toHaveBeenCalledOnce();
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

  it("keeps accepted managed completion when later cancellation reaches the runtime", async () => {
    const { pi } = fakePi();
    const controller = new AbortController();
    const session = makeSession();
    let options: unknown;
    session.prompt = vi.fn(async () => {
      const tool = completionTool(options);
      await tool.execute(
        "complete",
        { result: "accepted" },
        undefined,
        undefined,
        { abort: () => controller.abort() },
      );
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
      completion: {
        schema: Type.Object({ result: Type.String() }),
        description: "Return a result.",
      },
    });

    expect(controller.signal.aborted).toBe(true);
    expect(final).toMatchObject({
      status: "completed",
      result: { result: "accepted" },
    });
  });

  it("retries a schema-rejected completion through Pi's sequential agent loop", async () => {
    const { pi } = fakePi();
    const { createSession, faux, model, modelRegistry, sessions } =
      await createRealSessionHarness([
        fauxAssistantMessage(
          fauxToolCall(
            MANAGED_COMPLETION_TOOL_NAME,
            { summary: "rejected" },
            { id: "invalid-completion" },
          ),
        ),
        fauxAssistantMessage(
          fauxToolCall(
            MANAGED_COMPLETION_TOOL_NAME,
            { summary: "accepted" },
            { id: "valid-completion" },
          ),
        ),
      ]);
    const runtime = new SubagentRuntime(pi as never, { createSession });

    const final = await runtime.runManagedAgent({
      type: "general-purpose",
      prompt: "work",
      cwd: TEST_CWD,
      ctx: realContext(model, modelRegistry),
      completion: {
        schema: Type.Object({ summary: Type.Literal("accepted") }),
        description: "Return the final summary.",
      },
    });

    expect(final).toMatchObject({
      status: "completed",
      result: { summary: "accepted" },
    });
    expect(faux.state.callCount).toBe(2);
    expect(sessions[0]?.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "toolResult",
          toolCallId: "invalid-completion",
          isError: true,
        }),
        expect.objectContaining({
          role: "toolResult",
          toolCallId: "valid-completion",
          isError: false,
        }),
      ]),
    );
    expect(runtime.inspect(final.id)?.activity).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "tool",
          toolCallId: "valid-completion",
          status: "completed",
        }),
      ]),
    );
  });

  it("runs sibling calls through Pi's sequential loop and terminates after completion", async () => {
    const { pi } = fakePi();
    const earlier = vi.fn(async () => ({
      content: [{ type: "text" as const, text: "earlier sibling" }],
      details: {},
    }));
    const later = vi.fn(async () => ({
      content: [{ type: "text" as const, text: "later sibling" }],
      details: {},
    }));
    const { createSession, faux, model, modelRegistry } =
      await createRealSessionHarness([
        fauxAssistantMessage([
          fauxToolCall("earlier_sibling", {}, { id: "earlier" }),
          fauxToolCall(
            MANAGED_COMPLETION_TOOL_NAME,
            { result: "complete" },
            { id: "complete" },
          ),
          fauxToolCall("later_sibling", {}, { id: "later" }),
        ]),
      ]);
    const runtime = new SubagentRuntime(pi as never, {
      createSession: async (options) =>
        createSession({
          ...options,
          customTools: [
            ...(options?.customTools ?? []),
            {
              name: "earlier_sibling",
              label: "earlier sibling",
              description: "Records an earlier sequential sibling.",
              parameters: Type.Object({}),
              executionMode: "sequential",
              execute: earlier,
            },
            {
              name: "later_sibling",
              label: "later sibling",
              description: "Records a later sequential sibling.",
              parameters: Type.Object({}),
              executionMode: "sequential",
              execute: later,
            },
          ],
        }),
    });

    const final = await runtime.runManagedAgent({
      type: "general-purpose",
      prompt: "work",
      cwd: TEST_CWD,
      ctx: realContext(model, modelRegistry),
      completion: {
        schema: Type.Object({ result: Type.String() }),
        description: "Return a result.",
      },
    });

    expect(final).toMatchObject({ result: { result: "complete" } });
    expect(earlier).toHaveBeenCalledOnce();
    expect(later).not.toHaveBeenCalled();
    expect(faux.state.callCount).toBe(2);
  });

  it("keeps nested Explore usable through Pi's live tool loop beside completion", async () => {
    const { pi } = fakePi();
    const { createSession, faux, model, modelRegistry } =
      await createRealSessionHarness([
        fauxAssistantMessage(
          fauxToolCall(
            "explore",
            { question: "Where is the runtime?", breadth: "quick" },
            { id: "explore" },
          ),
        ),
        fauxAssistantMessage("The runtime is in runtime.ts."),
        fauxAssistantMessage(
          fauxToolCall(
            MANAGED_COMPLETION_TOOL_NAME,
            { result: "exploration complete" },
            { id: "complete" },
          ),
        ),
      ]);
    const runtime = new SubagentRuntime(pi as never, {
      createSession,
      modelPresets: {
        low: { model: `${TEST_PROVIDER}/${TEST_MODEL}`, thinking: "low" },
      },
    });

    const final = await runtime.runManagedAgent({
      type: "General",
      prompt: "Explore, then complete.",
      cwd: TEST_CWD,
      ctx: realContext(model, modelRegistry),
      completion: {
        schema: Type.Object({ result: Type.String() }),
        description: "Return a result.",
      },
    });

    expect(final).toMatchObject({
      status: "completed",
      result: { result: "exploration complete" },
    });
    expect(faux.state.callCount).toBe(3);
  });

  it("stops an externally cancelled live child before completion through Pi's loop", async () => {
    const { pi } = fakePi();
    const controller = new AbortController();
    const cancelled = vi.fn(async () => {
      controller.abort();
      return {
        content: [{ type: "text" as const, text: "cancelled" }],
        details: {},
      };
    });
    const { createSession, faux, model, modelRegistry } =
      await createRealSessionHarness([
        fauxAssistantMessage([
          fauxToolCall("cancel_child", {}, { id: "cancel" }),
          fauxToolCall(
            MANAGED_COMPLETION_TOOL_NAME,
            { result: "must not be accepted" },
            { id: "complete" },
          ),
        ]),
      ]);
    const runtime = new SubagentRuntime(pi as never, {
      createSession: async (options) =>
        createSession({
          ...options,
          customTools: [
            ...(options?.customTools ?? []),
            {
              name: "cancel_child",
              label: "cancel child",
              description: "Cancels the child through its caller signal.",
              parameters: Type.Object({}),
              executionMode: "sequential",
              execute: cancelled,
            },
          ],
        }),
    });

    const final = await runtime.runManagedAgent({
      type: "general-purpose",
      prompt: "work",
      cwd: TEST_CWD,
      ctx: realContext(model, modelRegistry),
      signal: controller.signal,
      completion: {
        schema: Type.Object({ result: Type.String() }),
        description: "Return a result.",
      },
    });

    expect(final).toMatchObject({
      status: "stopped",
      error: "Stopped by user.",
    });
    expect(final.result).toBeUndefined();
    expect(cancelled).toHaveBeenCalledOnce();
    expect(faux.state.callCount).toBe(2);
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

  it("preserves accepted completion across live cancellation during cleanup", async () => {
    const { pi } = fakePi();
    const controller = new AbortController();
    const { createSession, faux, model, modelRegistry } =
      await createRealSessionHarness([
        fauxAssistantMessage(
          fauxToolCall(
            MANAGED_COMPLETION_TOOL_NAME,
            { result: "accepted" },
            { id: "complete" },
          ),
        ),
      ]);
    const runtime = new SubagentRuntime(pi as never, {
      createSession: async (options) => {
        const { session } = await createSession(options);
        const dispose = session.dispose.bind(session);
        session.dispose = () => {
          controller.abort();
          dispose();
        };
        return { session };
      },
    });

    const final = await runtime.runManagedAgent({
      type: "general-purpose",
      prompt: "work",
      cwd: TEST_CWD,
      ctx: realContext(model, modelRegistry),
      signal: controller.signal,
      completion: {
        schema: Type.Object({ result: Type.String() }),
        description: "Return a result.",
      },
    });

    expect(final).toMatchObject({
      status: "completed",
      result: { result: "accepted" },
    });
    expect(faux.state.callCount).toBe(1);
  });

  it("preserves accepted completion across later provider and session failures", async () => {
    const { pi } = fakePi();
    const providerHarness = await createRealSessionHarness([
      fauxAssistantMessage(
        fauxToolCall(
          MANAGED_COMPLETION_TOOL_NAME,
          { result: "provider accepted" },
          { id: "complete" },
        ),
      ),
    ]);
    const providerRuntime = new SubagentRuntime(pi as never, {
      createSession: async (options) => {
        const { session } = await providerHarness.createSession(options);
        const prompt = session.prompt.bind(session);
        session.prompt = async (...args) => {
          await prompt(...args);
          throw new Error("late provider failure");
        };
        return { session };
      },
    });
    const providerFinal = await providerRuntime.runManagedAgent({
      type: "general-purpose",
      prompt: "work",
      cwd: TEST_CWD,
      ctx: realContext(providerHarness.model, providerHarness.modelRegistry),
      completion: {
        schema: Type.Object({ result: Type.String() }),
        description: "Return a result.",
      },
    });

    expect(providerFinal).toMatchObject({
      status: "completed",
      result: { result: "provider accepted" },
    });

    const sessionHarness = await createRealSessionHarness([
      fauxAssistantMessage(
        fauxToolCall(
          MANAGED_COMPLETION_TOOL_NAME,
          { result: "session accepted" },
          { id: "complete" },
        ),
      ),
    ]);
    const sessionRuntime = new SubagentRuntime(pi as never, {
      createSession: async (options) => {
        const { session } = await sessionHarness.createSession(options);
        const prompt = session.prompt.bind(session);
        session.prompt = async (...args) => {
          await prompt(...args);
          Object.defineProperty(session, "state", {
            value: { errorMessage: "late session failure" },
          });
        };
        return { session };
      },
    });
    const sessionFinal = await sessionRuntime.runManagedAgent({
      type: "general-purpose",
      prompt: "work",
      cwd: TEST_CWD,
      ctx: realContext(sessionHarness.model, sessionHarness.modelRegistry),
      completion: {
        schema: Type.Object({ result: Type.String() }),
        description: "Return a result.",
      },
    });

    expect(sessionFinal).toMatchObject({
      status: "completed",
      result: { result: "session accepted" },
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

    const providerHarness = await createRealSessionHarness([
      fauxAssistantMessage("", {
        stopReason: "error",
        errorMessage: "provider unavailable",
      }),
    ]);
    const providerRuntime = new SubagentRuntime(pi as never, {
      createSession: providerHarness.createSession,
    });
    await expect(
      providerRuntime.runManagedAgent({
        type: "general-purpose",
        prompt: "work",
        cwd: TEST_CWD,
        ctx: realContext(providerHarness.model, providerHarness.modelRegistry),
        completion: {
          schema: Type.Object({ result: Type.String() }),
          description: "Return a result.",
        },
      }),
    ).resolves.toMatchObject({
      status: "failed",
      error: "provider unavailable",
    });

    const sessionHarness = await createRealSessionHarness([
      fauxAssistantMessage("settled prose"),
    ]);
    const sessionRuntime = new SubagentRuntime(pi as never, {
      createSession: async (options) => {
        const { session } = await sessionHarness.createSession(options);
        const prompt = session.prompt.bind(session);
        session.prompt = async (...args) => {
          await prompt(...args);
          Object.defineProperty(session, "state", {
            value: { errorMessage: "session unavailable" },
          });
        };
        return { session };
      },
    });
    await expect(
      sessionRuntime.runManagedAgent({
        type: "general-purpose",
        prompt: "work",
        cwd: TEST_CWD,
        ctx: realContext(sessionHarness.model, sessionHarness.modelRegistry),
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

  it("keeps completion dispatchable through explicit allowlist and exclusion collisions", async () => {
    const { pi } = fakePi();
    const { createSession, model, modelRegistry } =
      await createRealSessionHarness([
        fauxAssistantMessage(
          fauxToolCall(
            MANAGED_COMPLETION_TOOL_NAME,
            { result: "accepted" },
            { id: "complete" },
          ),
        ),
      ]);
    const runtime = new SubagentRuntime(pi as never, { createSession });

    const final = await runtime.runManagedAgent({
      type: "general-purpose",
      prompt: "work",
      cwd: TEST_CWD,
      ctx: realContext(model, modelRegistry),
      tools: ["read"],
      excludeTools: [MANAGED_COMPLETION_TOOL_NAME, "bash"],
      completion: {
        schema: Type.Object({ result: Type.String() }),
        description: "Return a result.",
      },
    });

    expect(final).toMatchObject({ result: { result: "accepted" } });
  });

  it("suppresses a duplicate completion emitted through Pi's sequential loop", async () => {
    const { pi } = fakePi();
    const { createSession, faux, model, modelRegistry } =
      await createRealSessionHarness([
        fauxAssistantMessage([
          fauxToolCall(
            MANAGED_COMPLETION_TOOL_NAME,
            { result: "first" },
            { id: "first-completion" },
          ),
          fauxToolCall(
            MANAGED_COMPLETION_TOOL_NAME,
            { result: "second" },
            { id: "duplicate-completion" },
          ),
        ]),
      ]);
    const runtime = new SubagentRuntime(pi as never, { createSession });

    const final = await runtime.runManagedAgent({
      type: "general-purpose",
      prompt: "work",
      cwd: TEST_CWD,
      ctx: realContext(model, modelRegistry),
      completion: {
        schema: Type.Object({ result: Type.String() }),
        description: "Return a result.",
      },
    });

    expect(final).toMatchObject({ result: { result: "first" } });
    expect(faux.state.callCount).toBe(1);
  });

  it("rejects a direct duplicate completion without replacing the first payload", async () => {
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
      completion: {
        schema: Type.Object({ result: Type.String() }),
        description: "Return a result.",
      },
    });

    expect(final).toMatchObject({ result: { result: "first" } });
  });

  it("records explicitly supplied model and thinking metadata", () => {
    const { pi } = fakePi();
    const runtime = new SubagentRuntime(pi as never);

    expect(
      runtime.queue({
        owner: "public-tool",
        type: "Explore",
        description: "map the codebase",
        cwd: "/workspace",
        model: "provider/explore",
        thinking: "low",
      }),
    ).toMatchObject({
      model: "provider/explore",
      thinking: "low",
    });
  });
});
