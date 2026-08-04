import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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

import { loadPipkinConfig } from "#lib/config";
import { EXPLORE_PROMPT, REVIEW_PROMPT } from "./agent-profiles.js";
import { ForegroundInterruptGuard } from "./foreground-interrupt.js";
import { registerSubagentLifecycle } from "./lifecycle.js";
import { registerPublicAgentTools } from "./public-tools.js";
import { SubagentActivityProjector } from "./activity-projector.js";
import { getSubagentRuntime, SubagentRuntime } from "./runtime.js";
import { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";

vi.mocked(DefaultResourceLoader).prototype.reload = reloadMock;

function registerExtension(pi: any): void {
  const config = loadPipkinConfig(getAgentDirMock());
  const runtime = getSubagentRuntime(pi, {
    low: config.config.models.low,
    high: config.config.models.high,
  });
  const activity = new SubagentActivityProjector(runtime, pi.events);
  const foregroundInterrupt = new ForegroundInterruptGuard();
  registerSubagentLifecycle({ pi, runtime, activity, foregroundInterrupt });
  registerPublicAgentTools({
    pi,
    runtime,
    foregroundInterrupt,
    configPath: config.path,
    modelPresets: config.config.models,
  });
}

type ToolDef = {
  name: string;
  description: string;
  parameters: unknown;
  promptSnippet?: string;
  promptGuidelines?: string[];
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
  activeTools = [
    "read",
    "bash",
    "Agent",
    "get_subagent_result",
    "record_papercut",
  ],
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

function makeInteractiveCtx() {
  const confirm = vi.fn<(...args: any[]) => Promise<boolean>>();
  const defaultEscape = vi.fn();
  let editor:
    | { handleInput(data: string): void; onEscape?: () => void }
    | undefined;
  const ctx = makeCtx({
    mode: "tui",
    hasUI: true,
    ui: {
      confirm,
      setWidget: vi.fn(),
      setEditorComponent: vi.fn((factory: (...args: any[]) => any) => {
        editor = factory(
          { requestRender: vi.fn() },
          { borderColor: (text: string) => text, selectList: {} },
          {
            matches: (data: string, action: string) =>
              action === "app.interrupt" && data === "\u001b",
          },
        );
        editor!.onEscape = defaultEscape;
      }),
    },
  });
  return {
    ctx,
    confirm,
    defaultEscape,
    send(data: string) {
      editor?.handleInput(data);
    },
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

function renderedText(component: unknown) {
  return (component as { render: (width: number) => string[] })
    .render(120)
    .join("\n");
}

const mockTheme = {
  bold: (text: string) => text,
  fg: (_color: string, text: string) => text,
} as any;

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

describe("public subagent tools", () => {
  beforeEach(() => {
    const agentDir = "/tmp/pipkin-subagents-config";
    mkdirSync(join(agentDir, "pipkin"), { recursive: true });
    writeFileSync(
      join(agentDir, "pipkin", "config.json"),
      JSON.stringify({
        models: {
          utility: { model: "ctx/default", thinking: "minimal" },
          low: { model: "ctx/default", thinking: "low" },
          medium: { model: "ctx/default", thinking: "medium" },
          high: { model: "ctx/default", thinking: "high" },
        },
      }),
    );
    getAgentDirMock.mockReturnValue(agentDir);
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
    expect(tools[0].description).toContain("Foreground returns");
    expect(tools[0].description).toContain(
      "background starts independent work",
    );
    expect(tools[0].promptSnippet).toBeUndefined();
    expect(tools[0].promptGuidelines).toBeUndefined();
    expect(tools[0].renderCall).toEqual(expect.any(Function));
    expect(tools[0].renderResult).toEqual(expect.any(Function));
    expect(tools[1].description).toContain("wait:true blocks");
    expect(tools[1].description).toContain("wait:false returns");
    expect(tools[1].description).toContain("bounded partial progress");
    expect(tools[2].description).toContain("running background subagent");
    const parameters = JSON.parse(JSON.stringify(tools[0].parameters));
    expect(parameters.properties.subagent_type).toMatchObject({
      type: "string",
      enum: ["Explore", "Review"],
    });
    expect(parameters.properties.mode).toMatchObject({
      type: "string",
      enum: ["foreground", "background"],
    });
    expect(parameters.properties.thinking).toMatchObject({
      type: "string",
      enum: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
    });
    expect(parameters.properties.cwd).toBeUndefined();
    expect(JSON.stringify(tools[0].parameters)).not.toContain(
      "working directory override",
    );
    expect(JSON.stringify(tools[0].parameters)).toContain(
      "do not guess available models",
    );
    const resultParameters = JSON.parse(JSON.stringify(tools[1].parameters));
    expect(resultParameters.properties.include_progress.description).toContain(
      "wait:false returns currently available progress",
    );
    expect(resultParameters.properties.include_progress.description).toContain(
      "wait:true waits for frozen post-cleanup progress",
    );
    expect(resultParameters.required).toEqual(["id", "wait"]);
    expect(tools[1].promptSnippet).toBeUndefined();
    expect(tools[1].promptGuidelines).toBeUndefined();
  });

  it("rejects unsupported public roles with the supported inventory", async () => {
    const { pi } = makePi(["read"]);
    const runtime = new SubagentRuntime(pi as never, {
      createSession: vi.fn(),
    });

    await expect(
      runtime.runPublicAgent({
        type: "Worker" as never,
        prompt: "unsupported",
        cwd: "/workspace",
        ctx: makeCtx() as never,
      }),
    ).rejects.toThrow("Use Explore or Review.");
  });

  it("roots public agents at the invoking cwd despite an injected legacy cwd", async () => {
    const { pi, tools } = makePi(["read"]);
    const sessions = [makeSession("explore"), makeSession("review")];
    const createdCwds: string[] = [];
    const createSession = vi.fn(async (options?: { cwd?: string }) => {
      createdCwds.push(options?.cwd ?? "");
      return { session: sessions.shift()!.session };
    });
    const runtime = new SubagentRuntime(pi as never, { createSession });
    const config = loadPipkinConfig(getAgentDirMock());
    registerPublicAgentTools({
      pi: pi as never,
      runtime,
      foregroundInterrupt: new ForegroundInterruptGuard(),
      configPath: config.path,
      modelPresets: config.config.models,
    });
    const agent = tools.find((tool) => tool.name === "Agent");

    for (const subagent_type of ["Explore", "Review"] as const) {
      const result = await agent!.execute(
        `call-${subagent_type}`,
        {
          subagent_type,
          prompt: `run ${subagent_type}`,
          cwd: "/legacy-redirect",
        },
        undefined,
        undefined,
        makeCtx({ cwd: "/invoking" }),
      );

      expect(result.details).toMatchObject({
        type: subagent_type,
        cwd: "/invoking",
      });
    }
    expect(createSession).toHaveBeenCalledTimes(2);
    expect(createdCwds).toEqual(["/invoking", "/invoking"]);
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
        { subagent_type: "Review", prompt: "do it" },
        undefined,
        undefined,
        makeCtx(),
      );
      expect(textContent(foreground)).toBe("done");
      expect(foreground.isError).toBe(false);
      expect(foreground.details).toMatchObject({
        type: "Review",
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
      expect(textContent(background)).toContain(
        "Continue the independent work that justified background mode",
      );
      expect(textContent(background)).toContain("result becomes a dependency");
      expect(textContent(background)).toContain("get_subagent_result");
      expect(textContent(background)).toContain("wait:true");
      expect(textContent(background)).toContain("Do not poll");
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

  it("confirms one interrupt for all foreground agents without affecting background agents", async () => {
    const { pi, tools } = makePi(["read"]);
    registerExtension(pi as never);
    const agent = tools.find((tool) => tool.name === "Agent");
    const runtime = SubagentRuntime.prototype;
    const runs: Array<ReturnType<typeof deferred<any>>> = [];
    const inputs: any[] = [];
    const runPublicAgent = vi
      .spyOn(runtime, "runPublicAgent")
      .mockImplementation((input) => {
        inputs.push(input);
        if (input.mode === "background") {
          return Promise.resolve({ status: "running" } as never);
        }
        const run = deferred<any>();
        runs.push(run);
        return run.promise;
      });
    const ui = makeInteractiveCtx();
    const sessionStart = vi
      .mocked(pi.on)
      .mock.calls.find(([event]) => event === "session_start")?.[1] as (
      event: { reason: string },
      ctx: any,
    ) => void;
    sessionStart({ reason: "startup" }, ui.ctx);
    ui.confirm.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const parent = new AbortController();

    try {
      ui.send("\u001b");
      expect(ui.defaultEscape).toHaveBeenCalledOnce();
      ui.defaultEscape.mockClear();

      const background = agent!.execute(
        "call-1",
        {
          subagent_type: "Explore",
          prompt: "background task",
          mode: "background",
        },
        parent.signal,
        undefined,
        ui.ctx,
      );
      const first = agent!.execute(
        "call-2",
        {
          subagent_type: "Review",
          prompt: "first task",
          description: "First agent",
        },
        parent.signal,
        undefined,
        ui.ctx,
      );
      const second = agent!.execute(
        "call-3",
        {
          subagent_type: "Explore",
          prompt: "second task",
          description: "Second agent",
        },
        parent.signal,
        undefined,
        ui.ctx,
      );

      ui.send("\u001b");
      await vi.waitFor(() => expect(ui.confirm).toHaveBeenCalledTimes(1));
      expect(ui.confirm).toHaveBeenCalledWith(
        "Stop 2 foreground subagents?",
        expect.stringMatching(
          /Review: First agent[\s\S]*Explore: Second agent/,
        ),
        { signal: expect.any(AbortSignal) },
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(inputs[1].signal.aborted).toBe(false);
      expect(inputs[2].signal.aborted).toBe(false);
      expect(ui.defaultEscape).not.toHaveBeenCalled();

      ui.send("\u001b");
      await vi.waitFor(() => expect(inputs[1].signal.aborted).toBe(true));
      expect(inputs[2].signal.aborted).toBe(true);
      expect(parent.signal.aborted).toBe(false);
      expect(inputs[0].signal.aborted).toBe(false);

      runs[0]!.resolve({ status: "stopped", error: "Stopped by user." });
      runs[1]!.resolve({ status: "stopped", error: "Stopped by user." });
      await Promise.all([background, first, second]);

      ui.send("\u001b");
      expect(ui.defaultEscape).toHaveBeenCalledOnce();
    } finally {
      for (const run of runs) {
        run.resolve({ status: "stopped", error: "Test cleanup." });
      }
      runPublicAgent.mockRestore();
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
      owner: "public-tool",
      type: "Explore",
      description: "finished",
      cwd: "/workspace",
    });
    runtime.start(completed.id);
    const deliverable = [
      "complete final deliverable with retrieval-only content avoided",
      "expanded-only detail ".repeat(20),
    ].join("\n");
    runtime.complete(completed.id, deliverable);

    const completedResult = await getResult!.execute(
      "call-1",
      { id: completed.id, wait: true },
      undefined,
      undefined,
      makeCtx(),
    );
    expect(textContent(completedResult)).toBe(deliverable);
    expect(completedResult.isError).toBe(false);
    expect(completedResult.details).toMatchObject({
      id: completed.id,
      status: "completed",
      result: deliverable,
    });

    const collapsed = renderedText(
      getResult!.renderResult!(
        completedResult,
        { expanded: false, isPartial: false },
        mockTheme,
      ),
    );
    const expanded = renderedText(
      getResult!.renderResult!(
        completedResult,
        { expanded: true, isPartial: false },
        mockTheme,
      ),
    );
    expect(collapsed).toContain(
      "complete final deliverable with retrieval-only content avoided",
    );
    expect(collapsed).toContain("…");
    expect(expanded).not.toContain("…");
    expect(expanded.split("\n").length).toBeGreaterThan(
      collapsed.split("\n").length,
    );
    expect(expanded).toContain("expanded-only detail expanded-only detail");

    const failed = runtime.queue({
      owner: "public-tool",
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
      owner: "public-tool",
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
      owner: "public-tool",
      type: "Explore",
      description: "running",
      cwd: "/workspace",
    });
    runtime.start(running.id);
    await expect(
      steer!.execute(
        "call-4",
        { id: running.id, message: "continue" },
        undefined,
        undefined,
        makeCtx(),
      ),
    ).rejects.toThrow(/not steerable/);

    const failedForSteer = runtime.queue({
      owner: "public-tool",
      type: "Explore",
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
      owner: "public-tool",
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

  it("returns bounded public progress without changing completed output", async () => {
    const { pi, tools } = makePi(["read"]);
    registerExtension(pi as never);
    const getResult = tools.find((tool) => tool.name === "get_subagent_result");
    const runtime = getSubagentRuntime(pi as never);
    const running = runtime.queue({
      owner: "public-tool",
      type: "Explore",
      description: "progress",
      cwd: "/workspace",
    });
    runtime.start(running.id);
    const withProgress = await getResult!.execute(
      "call-progress",
      { id: running.id, wait: false, include_progress: true },
      undefined,
      undefined,
      makeCtx(),
    );
    expect(textContent(withProgress)).toContain("No inspectable progress yet.");

    runtime.complete(running.id, "authoritative final");
    const ordinary = await getResult!.execute(
      "call-final-default",
      { id: running.id, wait: true },
      undefined,
      undefined,
      makeCtx(),
    );
    const requested = await getResult!.execute(
      "call-final-progress",
      { id: running.id, wait: true, include_progress: true },
      undefined,
      undefined,
      makeCtx(),
    );
    expect(textContent(requested)).toBe(textContent(ordinary));
  });

  it("rejects internally owned records as unknown public subagents", async () => {
    const { pi, tools } = makePi(["read"]);
    registerExtension(pi as never);
    const getResult = tools.find((tool) => tool.name === "get_subagent_result");
    const runtime = getSubagentRuntime(pi as never);
    const internal = runtime.queue({
      owner: { kind: "nested", parentId: "subagent-0", tool: "explore" },
      type: "Explore",
      description: "internal",
      cwd: "/workspace",
    });

    await expect(
      getResult!.execute(
        "call-internal",
        { id: internal.id, wait: false, include_progress: true },
        undefined,
        undefined,
        makeCtx(),
      ),
    ).rejects.toThrow(`Unknown subagent ${internal.id}`);
  });

  it("runs pipkin-implement managed background sessions and waits for completion", async () => {
    const { pi } = makePi([
      "read",
      "bash",
      "start_process",
      "get_process_result",
      "stop_process",
      "bash_outcome",
      "context_recall",
      "Agent",
      "edit",
    ]);
    const promptDone = deferred<void>();
    const { session } = makeSession("implemented");
    session.prompt = vi.fn(() => promptDone.promise);
    const createSession = vi.fn(async () => ({ session }));
    const runtime = new SubagentRuntime(pi as never, { createSession });

    const started = await runtime.runManagedAgent({
      owner: { kind: "internal", name: "pipkin:implement" },
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
      owner: { kind: "internal", name: "pipkin:implement" },
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
      "start_process",
      "get_process_result",
      "stop_process",
      "bash_outcome",
      "context_recall",
      "edit",
      "explore",
    ]);
  });

  it("withholds public agent tools from inherited active tools for all subagent types", async () => {
    const publicAgentTools = ["Agent", "get_subagent_result", "steer_subagent"];
    const { pi } = makePi([
      "read",
      "bash",
      "bash_outcome",
      "context_recall",
      ...publicAgentTools,
      "record_papercut",
      "edit",
      "explore",
    ]);
    const explore = makeSession("explore");
    const review = makeSession("review");
    const internal = makeSession("internal");
    const sessions = [explore, review, internal];
    const createSession = vi.fn(async () => ({
      session: sessions.shift()!.session,
    }));
    const runtime = new SubagentRuntime(pi as never, { createSession });

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
      owner: { kind: "internal", name: "pipkin:implement" },
      type: "custom-internal",
      prompt: "internal",
      cwd: "/workspace",
      ctx: makeCtx() as never,
    });

    for (const { session } of [explore, review, internal]) {
      const activeTools = vi.mocked(session.setActiveToolsByName).mock
        .calls[0][0];
      expect(activeTools).not.toEqual(expect.arrayContaining(publicAgentTools));
    }
    expect(explore.session.setActiveToolsByName).toHaveBeenCalledWith([
      "read",
      "bash",
      "bash_outcome",
      "context_recall",
      "grep",
      "find",
      "ls",
      "record_papercut",
    ]);
    expect(review.session.setActiveToolsByName).toHaveBeenCalledWith([
      "read",
      "bash",
      "bash_outcome",
      "context_recall",
      "grep",
      "find",
      "ls",
      "explore",
      "record_papercut",
    ]);
    expect(internal.session.setActiveToolsByName).toHaveBeenCalledWith([
      "read",
      "bash",
      "bash_outcome",
      "context_recall",
      "edit",
    ]);
  });

  it("sanitizes explicit runtime tool allowlists before activation", async () => {
    const { pi } = makePi(["read"]);
    const { session } = makeSession("explicit");
    const createSession = vi.fn(async (_options: any) => ({ session }));
    const runtime = new SubagentRuntime(pi as never, { createSession });

    await runtime.runManagedAgent({
      owner: { kind: "internal", name: "pipkin:implement" },
      type: "general-purpose",
      prompt: "explicit tools",
      cwd: "/workspace",
      tools: [
        "read",
        "explore",
        "Agent",
        "get_subagent_result",
        "record_papercut",
        "bash",
      ],
      ctx: makeCtx() as never,
    });

    expect(createSession.mock.calls[0][0]).toMatchObject({
      tools: ["read", "explore"],
    });
    expect(session.setActiveToolsByName).toHaveBeenCalledWith([
      "read",
      "explore",
    ]);
  });

  it("intersects process capabilities with parent active tools", async () => {
    const bashFree = makePi([
      "read",
      "start_process",
      "get_process_result",
      "stop_process",
      "bash_outcome",
      "context_recall",
    ]);
    const missingRecall = makePi(["read", "bash", "bash_outcome"]);
    const bashFreeSession = makeSession("bash-free");
    const missingRecallSession = makeSession("missing-recall");
    const runtime = new SubagentRuntime(bashFree.pi as never, {
      createSession: vi.fn(async () => ({ session: bashFreeSession.session })),
    });

    await runtime.runPublicAgent({
      type: "Explore",
      prompt: "map it",
      cwd: "/workspace",
      ctx: makeCtx() as never,
    });
    const missingRecallRuntime = new SubagentRuntime(
      missingRecall.pi as never,
      {
        createSession: vi.fn(async () => ({
          session: missingRecallSession.session,
        })),
      },
    );
    await missingRecallRuntime.runPublicAgent({
      type: "Review",
      prompt: "review it",
      cwd: "/workspace",
      ctx: makeCtx() as never,
    });

    expect(bashFreeSession.session.setActiveToolsByName).toHaveBeenCalledWith([
      "read",
      "get_process_result",
      "stop_process",
      "grep",
      "find",
      "ls",
      "record_papercut",
    ]);
    expect(
      missingRecallSession.session.setActiveToolsByName,
    ).toHaveBeenCalledWith([
      "read",
      "bash",
      "grep",
      "find",
      "ls",
      "explore",
      "record_papercut",
    ]);
  });

  it("runs foreground agents to completion after binding inherited extensions", async () => {
    const { pi } = makePi(["read", "bash", "Agent", "steer_subagent"]);
    const { session, calls } = makeSession("final answer");
    const createSession = vi.fn(async (_options: any) => ({ session }));
    const runtime = new SubagentRuntime(pi as never, { createSession });

    const result = await runtime.runPublicAgent({
      type: "Review",
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
      "grep",
      "find",
      "ls",
      "explore",
      "record_papercut",
    ]);
    expect(session.prompt).toHaveBeenCalledWith("do work", {
      source: "extension",
      expandPromptTemplates: false,
    });
    expect(resourceLoaderConstructions).toHaveLength(1);
    expect(resourceLoaderConstructions[0].options).toEqual({
      cwd: "/workspace",
      agentDir: "/tmp/pipkin-subagents-config",
      eventBus: expect.anything(),
      appendSystemPrompt: [REVIEW_PROMPT],
    });
    expect(resourceLoaderConstructions[0].options.eventBus).not.toBe(pi.events);
    expect(reloadMock).toHaveBeenCalledBefore(createSession);
    expect(createSession.mock.calls[0][0]).toMatchObject({
      agentDir: "/tmp/pipkin-subagents-config",
      resourceLoader: resourceLoaderConstructions[0].loader,
    });
  });

  it("uses append-mode prompt loading and pinned tools for Explore", async () => {
    expect(EXPLORE_PROMPT).toContain(
      "Inspect and verify only; leave the repository unchanged.",
    );
    expect(EXPLORE_PROMPT).toContain("Use lsp when available");
    expect(EXPLORE_PROMPT).toContain("broad, literal, or non-semantic");
    expect(EXPLORE_PROMPT).toContain("fall back to search and reads");
    expect(EXPLORE_PROMPT).toContain("sole allowed personal-metadata write");
    expect(EXPLORE_PROMPT).not.toContain("Use the find tool");
    expect(EXPLORE_PROMPT).not.toContain("NOT bash grep/rg");

    const { pi } = makePi([
      "read",
      "bash",
      "start_process",
      "get_process_result",
      "stop_process",
      "record_papercut",
      "edit",
      "write",
      "Agent",
    ]);
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
      agentDir: "/tmp/pipkin-subagents-config",
      eventBus: expect.anything(),
      appendSystemPrompt: [EXPLORE_PROMPT],
    });
    expect(reloadMock).toHaveBeenCalledBefore(createSession);
    expect(createSession.mock.calls[0][0]).toMatchObject({
      agentDir: "/tmp/pipkin-subagents-config",
      resourceLoader: resourceLoaderConstructions[0].loader,
      tools: [
        "read",
        "bash",
        "start_process",
        "get_process_result",
        "stop_process",
        "grep",
        "find",
        "ls",
        "record_papercut",
      ],
    });
    expect(session.setActiveToolsByName).toHaveBeenCalledWith([
      "read",
      "bash",
      "start_process",
      "get_process_result",
      "stop_process",
      "grep",
      "find",
      "ls",
      "record_papercut",
    ]);
  });

  it("uses append-mode prompt loading and pinned tools for Review", async () => {
    expect(REVIEW_PROMPT).toContain("sole allowed personal-metadata write");
    const { pi } = makePi([
      "read",
      "bash",
      "start_process",
      "get_process_result",
      "stop_process",
      "record_papercut",
      "edit",
      "write",
      "Agent",
    ]);
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
      agentDir: "/tmp/pipkin-subagents-config",
      eventBus: expect.anything(),
      appendSystemPrompt: [REVIEW_PROMPT],
    });
    expect(createSession.mock.calls[0][0]).toMatchObject({
      agentDir: "/tmp/pipkin-subagents-config",
      resourceLoader: resourceLoaderConstructions[0].loader,
      tools: [
        "read",
        "bash",
        "start_process",
        "get_process_result",
        "stop_process",
        "grep",
        "find",
        "ls",
        "explore",
        "record_papercut",
      ],
    });
    expect(session.setActiveToolsByName).toHaveBeenCalledWith([
      "read",
      "bash",
      "start_process",
      "get_process_result",
      "stop_process",
      "grep",
      "find",
      "ls",
      "explore",
      "record_papercut",
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
      agentDir: "/tmp/pipkin-subagents-config",
      eventBus: expect.anything(),
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
      type: "Explore",
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
    const steering = runtime.steer(started.id, "look here");
    expect(session.steer).not.toHaveBeenCalled();

    sessionReady.resolve({ session });
    await expect(steering).resolves.toMatchObject({ status: "running" });
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
      modelPresets: {},
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

  it("preserves requested thinking and reports Pi's effective level", async () => {
    const { pi } = makePi(["read"]);
    const { session } = makeSession();
    Object.defineProperty(session, "thinkingLevel", { value: "low" });
    const createSession = vi.fn(async (_options: any) => ({ session }));
    const ctx = makeCtx();
    const runtime = new SubagentRuntime(pi as never, {
      createSession,
      modelPresets: {
        low: { model: "configured/explore", thinking: "max" },
      },
    });

    await runtime.runPublicAgent({
      type: "Explore",
      prompt: "inspect",
      cwd: "/workspace",
      ctx: ctx as never,
      model: "explicit/model",
      thinking: "max",
    });

    expect(ctx.modelRegistry.find).toHaveBeenCalledWith("explicit", "model");
    expect(createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        model: { provider: "explicit", id: "model" },
        thinkingLevel: "max",
      }),
    );
    expect(await runtime.result("subagent-1", false)).toMatchObject({
      thinking: "max",
      effectiveThinking: "low",
    });
  });
});
