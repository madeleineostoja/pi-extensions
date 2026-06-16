import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";

const getAgentDirMock = vi.hoisted(() => vi.fn(() => "/agent-dir"));
const reloadMock = vi.hoisted(() =>
  vi.fn(async function (this: any) {
    this.reloaded = true;
  }),
);
const resourceLoaderConstructions = vi.hoisted(() => [] as any[]);

vi.mock("@earendil-works/pi-coding-agent", async () => {
  const actual = await vi.importActual<
    typeof import("@earendil-works/pi-coding-agent")
  >("@earendil-works/pi-coding-agent");
  return {
    ...actual,
    getAgentDir: getAgentDirMock,
    DefaultResourceLoader: vi.fn(function (this: any, options: any) {
      this.options = options;
      resourceLoaderConstructions.push({ loader: this, options });
    }),
  };
});

import registerExtension from "./index.js";
import {
  EXPLORE_PROMPT,
  GENERAL_PROMPT,
  PUBLIC_AGENT_PROFILES,
  REVIEW_PROMPT,
} from "./agent-profiles.js";
import { getSubagentRuntime, SubagentRuntime } from "./runtime.js";
import { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";

vi.mocked(DefaultResourceLoader).prototype.reload = reloadMock;

type ToolDef = {
  name: string;
  description: string;
  parameters: unknown;
  execute: (...args: any[]) => Promise<any>;
  renderCall?: (...args: any[]) => unknown;
  renderResult?: (...args: any[]) => unknown;
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

function asAgentSession<T>(session: T): T & AgentSession {
  return session as T & AgentSession;
}

function textContent(result: {
  content: Array<{ type: string; text?: string }>;
}) {
  return result.content.find((part) => part.type === "text")?.text;
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
    session: asAgentSession({
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
      state: {},
      messages: [],
      sessionId: "session-id",
      sessionFile: undefined,
      subscribe: vi.fn(() => vi.fn()),
      getAllTools: vi.fn(() => []),
      extensionRunner: extensionRunner as any,
    }),
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
  beforeEach(() => {
    getAgentDirMock.mockReturnValue("/agent-dir");
    reloadMock.mockClear();
    resourceLoaderConstructions.length = 0;
  });

  it("registers the public tools with the exact public agent choices", () => {
    const { pi, tools } = makePi();

    registerExtension(pi as never);

    expect(pi.on).toHaveBeenCalledWith(
      "session_shutdown",
      expect.any(Function),
    );
    expect(pi.on).toHaveBeenCalledWith("session_start", expect.any(Function));
    expect(tools.map((tool) => tool.name)).toEqual([
      "Agent",
      "get_subagent_result",
      "steer_subagent",
    ]);
    expect(tools[0].description).toContain("foreground");
    expect(tools[0].renderCall).toEqual(expect.any(Function));
    expect(tools[0].renderResult).toEqual(expect.any(Function));
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
    expect(JSON.stringify(tools[0].parameters)).toContain(
      PUBLIC_AGENT_PROFILES.General.description,
    );
    expect(JSON.stringify(tools[0].parameters)).toContain(
      PUBLIC_AGENT_PROFILES.Explore.description,
    );
    expect(JSON.stringify(tools[0].parameters)).toContain(
      PUBLIC_AGENT_PROFILES.Review.description,
    );
  });

  it("returns complete foreground content and actionable background content", async () => {
    const { pi, tools } = makePi(["read"]);
    registerExtension(pi as never);
    const agent = tools.find((tool) => tool.name === "Agent");
    expect(agent).toBeDefined();

    const promptDone = deferred<void>();
    const runtime = SubagentRuntime.prototype;
    const runPublicAgent = vi
      .spyOn(runtime, "runPublicAgent")
      .mockImplementation(async function (this: SubagentRuntime, input) {
        const queued = this.queue({
          owner: "public-tool",
          type: input.type,
          description: input.description ?? input.prompt,
          cwd: input.cwd,
        });
        this.start(queued.id);
        if (input.mode === "background") {
          void promptDone.promise.then(() => this.complete(queued.id, "later"));
          return this.snapshot(queued.id)!;
        }
        return this.complete(queued.id, "done");
      });
    try {
      const foreground = await agent!.execute(
        "call-1",
        { subagent_type: "General", prompt: "do it" },
        undefined,
        undefined,
        makeCtx(),
      );
      expect(textContent(foreground)).toBe("done");
      expect(foreground.isError).toBe(false);
      expect(foreground.details).toMatchObject({
        type: "General",
        status: "completed",
        result: "done",
      });

      const background = await agent!.execute(
        "call-2",
        {
          subagent_type: "Explore",
          prompt: "inspect",
          mode: "background",
        },
        undefined,
        undefined,
        makeCtx(),
      );
      expect(textContent(background)).toContain("Subagent subagent-");
      expect(textContent(background)).toContain("get_subagent_result");
      expect(textContent(background)).toContain("wait:true");
      expect(background.isError).toBe(false);
      expect(background.details).toMatchObject({
        type: "Explore",
        status: "running",
      });
    } finally {
      runPublicAgent.mockRestore();
      promptDone.resolve();
    }
  });

  it("returns full completed status results and error flags from public status tools", async () => {
    const { pi, tools } = makePi(["read"]);
    registerExtension(pi as never);
    const getResult = tools.find((tool) => tool.name === "get_subagent_result");
    const steer = tools.find((tool) => tool.name === "steer_subagent");
    expect(getResult).toBeDefined();
    expect(steer).toBeDefined();

    const runtime = getSubagentRuntime(pi as never);
    const completed = runtime.queue({
      owner: "test",
      type: "General",
      description: "finished",
      cwd: "/workspace",
    });
    runtime.start(completed.id);
    runtime.complete(
      completed.id,
      "complete final deliverable with retrieval-only content avoided",
    );

    const completedResult = await getResult!.execute(
      "call-1",
      { id: completed.id, wait: true },
      undefined,
      undefined,
      makeCtx(),
    );
    expect(textContent(completedResult)).toBe(
      "complete final deliverable with retrieval-only content avoided",
    );
    expect(completedResult.isError).toBe(false);
    expect(completedResult.details).toMatchObject({
      id: completed.id,
      status: "completed",
      result: "complete final deliverable with retrieval-only content avoided",
    });

    const failed = runtime.queue({
      owner: "test",
      type: "Explore",
      description: "failed",
      cwd: "/workspace",
    });
    runtime.start(failed.id);
    runtime.fail(failed.id, "provider unavailable");

    const failedResult = await getResult!.execute(
      "call-2",
      { id: failed.id, wait: false },
      undefined,
      undefined,
      makeCtx(),
    );
    expect(textContent(failedResult)).toContain("failed: provider unavailable");
    expect(failedResult.isError).toBe(true);

    const stopped = runtime.queue({
      owner: "test",
      type: "Review",
      description: "stopped",
      cwd: "/workspace",
    });
    runtime.start(stopped.id);
    runtime.stop(stopped.id, "Stopped by test.");

    const stoppedResult = await getResult!.execute(
      "call-3",
      { id: stopped.id, wait: false },
      undefined,
      undefined,
      makeCtx(),
    );
    expect(textContent(stoppedResult)).toContain("stopped: Stopped by test.");
    expect(stoppedResult.isError).toBe(true);

    const running = runtime.queue({
      owner: "test",
      type: "General",
      description: "running",
      cwd: "/workspace",
    });
    runtime.start(running.id);
    const steerResult = await steer!.execute(
      "call-4",
      { id: running.id, message: "continue" },
      undefined,
      undefined,
      makeCtx(),
    );
    expect(steerResult.isError).toBe(false);

    const failedForSteer = runtime.queue({
      owner: "test",
      type: "General",
      description: "failed steer result",
      cwd: "/workspace",
    });
    runtime.start(failedForSteer.id);
    const failedSteerSnapshot = runtime.fail(
      failedForSteer.id,
      "steer failure",
    );
    const steerSpy = vi
      .spyOn(runtime, "steer")
      .mockResolvedValueOnce(failedSteerSnapshot);
    const failedSteerResult = await steer!.execute(
      "call-5",
      { id: failedForSteer.id, message: "continue" },
      undefined,
      undefined,
      makeCtx(),
    );
    expect(failedSteerResult.isError).toBe(true);
    expect(textContent(failedSteerResult)).toContain("failed: steer failure");

    const stoppedForSteer = runtime.queue({
      owner: "test",
      type: "Review",
      description: "stopped steer result",
      cwd: "/workspace",
    });
    runtime.start(stoppedForSteer.id);
    const stoppedSteerSnapshot = runtime.stop(
      stoppedForSteer.id,
      "Steer stopped.",
    );
    steerSpy.mockResolvedValueOnce(stoppedSteerSnapshot);
    const stoppedSteerResult = await steer!.execute(
      "call-6",
      { id: stoppedForSteer.id, message: "continue" },
      undefined,
      undefined,
      makeCtx(),
    );
    expect(stoppedSteerResult.isError).toBe(true);
    expect(textContent(stoppedSteerResult)).toContain(
      "stopped: Steer stopped.",
    );
    steerSpy.mockRestore();
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
    expect(createSession).toHaveBeenCalledWith(
      expect.not.objectContaining({ resourceLoader: expect.anything() }),
    );
    expect(createSession).toHaveBeenCalledWith(
      expect.not.objectContaining({ agentDir: expect.anything() }),
    );
    expect(session.setActiveToolsByName).toHaveBeenCalledWith([
      "read",
      "bash",
      "edit",
      "explore",
    ]);
  });

  it("withholds public agent tools from inherited active tools for all subagent types", async () => {
    const publicAgentTools = ["Agent", "get_subagent_result", "steer_subagent"];
    const { pi } = makePi([
      "read",
      "bash",
      ...publicAgentTools,
      "edit",
      "explore",
    ]);
    const general = makeSession("general");
    const explore = makeSession("explore");
    const review = makeSession("review");
    const internal = makeSession("internal");
    const sessions = [general, explore, review, internal];
    const createSession = vi.fn(async () => ({
      session: sessions.shift()!.session,
    }));
    const runtime = new SubagentRuntime(pi as never, { createSession });

    await runtime.runPublicAgent({
      type: "General",
      prompt: "general",
      cwd: "/workspace",
      ctx: makeCtx() as never,
    });
    await runtime.runPublicAgent({
      type: "Explore",
      prompt: "explore",
      cwd: "/workspace",
      ctx: makeCtx() as never,
    });
    await runtime.runPublicAgent({
      type: "Review",
      prompt: "review",
      cwd: "/workspace",
      ctx: makeCtx() as never,
    });
    await runtime.runManagedAgent({
      owner: { kind: "internal", name: "pi-implement" },
      type: "custom-internal",
      prompt: "internal",
      cwd: "/workspace",
      ctx: makeCtx() as never,
    });

    for (const { session } of [general, explore, review, internal]) {
      const activeTools = vi.mocked(session.setActiveToolsByName).mock
        .calls[0][0];
      expect(activeTools).not.toEqual(expect.arrayContaining(publicAgentTools));
    }
    expect(general.session.setActiveToolsByName).toHaveBeenCalledWith([
      "read",
      "bash",
      "edit",
      "explore",
    ]);
    expect(explore.session.setActiveToolsByName).toHaveBeenCalledWith([
      "read",
      "bash",
      "grep",
      "find",
      "ls",
    ]);
    expect(review.session.setActiveToolsByName).toHaveBeenCalledWith([
      "read",
      "bash",
      "grep",
      "find",
      "ls",
      "explore",
    ]);
    expect(internal.session.setActiveToolsByName).toHaveBeenCalledWith([
      "read",
      "bash",
      "edit",
    ]);
  });

  it("sanitizes explicit runtime tool allowlists before activation", async () => {
    const { pi } = makePi(["read"]);
    const { session } = makeSession("explicit");
    const createSession = vi.fn(async (_options: any) => ({ session }));
    const runtime = new SubagentRuntime(pi as never, { createSession });

    await runtime.runManagedAgent({
      owner: { kind: "internal", name: "pi-implement" },
      type: "general-purpose",
      prompt: "explicit tools",
      cwd: "/workspace",
      tools: ["read", "explore", "Agent", "get_subagent_result", "bash"],
      ctx: makeCtx() as never,
    });

    expect(createSession.mock.calls[0][0]).toMatchObject({
      tools: ["read", "explore", "bash"],
    });
    expect(session.setActiveToolsByName).toHaveBeenCalledWith([
      "read",
      "explore",
      "bash",
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
    expect(resourceLoaderConstructions).toHaveLength(1);
    expect(resourceLoaderConstructions[0].options).toEqual({
      cwd: "/workspace",
      agentDir: "/agent-dir",
      appendSystemPrompt: [GENERAL_PROMPT],
    });
    expect(reloadMock).toHaveBeenCalledBefore(createSession);
    expect(createSession.mock.calls[0][0]).toMatchObject({
      agentDir: "/agent-dir",
      resourceLoader: resourceLoaderConstructions[0].loader,
    });
  });

  it("uses replace-mode prompt loading and pinned tools for Explore", async () => {
    const { pi } = makePi(["read", "bash", "edit", "write", "Agent"]);
    const { session } = makeSession("explore result");
    const createSession = vi.fn(async (_options: any) => ({ session }));
    const runtime = new SubagentRuntime(pi as never, { createSession });

    await runtime.runPublicAgent({
      type: "Explore",
      prompt: "map it",
      cwd: "/workspace",
      ctx: makeCtx() as never,
    });

    expect(resourceLoaderConstructions).toHaveLength(1);
    expect(resourceLoaderConstructions[0].options).toEqual({
      cwd: "/workspace",
      agentDir: "/agent-dir",
      systemPrompt: EXPLORE_PROMPT,
    });
    expect(reloadMock).toHaveBeenCalledBefore(createSession);
    expect(createSession.mock.calls[0][0]).toMatchObject({
      agentDir: "/agent-dir",
      resourceLoader: resourceLoaderConstructions[0].loader,
      tools: ["read", "bash", "grep", "find", "ls"],
    });
    expect(session.setActiveToolsByName).toHaveBeenCalledWith([
      "read",
      "bash",
      "grep",
      "find",
      "ls",
    ]);
  });

  it("uses append-mode prompt loading and pinned tools for Review", async () => {
    const { pi } = makePi(["read", "bash", "edit", "write", "Agent"]);
    const { session } = makeSession("review result");
    const createSession = vi.fn(async (_options: any) => ({ session }));
    const runtime = new SubagentRuntime(pi as never, { createSession });

    await runtime.runPublicAgent({
      type: "Review",
      prompt: "review it",
      cwd: "/workspace",
      ctx: makeCtx() as never,
    });

    expect(resourceLoaderConstructions).toHaveLength(1);
    expect(resourceLoaderConstructions[0].options).toEqual({
      cwd: "/workspace",
      agentDir: "/agent-dir",
      appendSystemPrompt: [REVIEW_PROMPT],
    });
    expect(createSession.mock.calls[0][0]).toMatchObject({
      agentDir: "/agent-dir",
      resourceLoader: resourceLoaderConstructions[0].loader,
      tools: ["read", "bash", "grep", "find", "ls", "explore"],
    });
    expect(session.setActiveToolsByName).toHaveBeenCalledWith([
      "read",
      "bash",
      "grep",
      "find",
      "ls",
      "explore",
    ]);
  });

  it("loads explicit internal system prompts without otherwise changing tool behavior", async () => {
    const { pi } = makePi(["read", "bash", "edit", "Agent"]);
    const { session } = makeSession("internal result");
    const createSession = vi.fn(async (_options: any) => ({ session }));
    const runtime = new SubagentRuntime(pi as never, { createSession });

    await runtime.runManagedAgent({
      type: "custom-internal",
      prompt: "do work",
      systemPrompt: "Internal instructions",
      systemPromptMode: "replace",
      cwd: "/workspace",
      ctx: makeCtx() as never,
    });

    expect(resourceLoaderConstructions[0].options).toEqual({
      cwd: "/workspace",
      agentDir: "/agent-dir",
      systemPrompt: "Internal instructions",
    });
    expect(session.setActiveToolsByName).toHaveBeenCalledWith([
      "read",
      "bash",
      "edit",
    ]);
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
