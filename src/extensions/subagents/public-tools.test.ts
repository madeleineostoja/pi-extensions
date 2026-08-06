import type { AgentSession, Theme } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { registerPublicAgentTools } from "./public-tools.js";
import { renderAgentResult } from "./tool-rendering.js";
import { SubagentRuntime } from "./runtime.js";

type Tool = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (...args: any[]) => Promise<any>;
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function session(result = "complete") {
  return {
    bindExtensions: vi.fn(async () => {}),
    prompt: vi.fn(async () => {}),
    steer: vi.fn(async () => {}),
    abort: vi.fn(async () => {}),
    dispose: vi.fn(),
    getLastAssistantText: vi.fn(() => result),
    setActiveToolsByName: vi.fn(),
    state: {},
    messages: [],
    sessionId: "child",
    subscribe: vi.fn(() => vi.fn()),
    getAllTools: vi.fn(() => []),
    extensionRunner: { hasHandlers: vi.fn(() => false), emit: vi.fn() },
  } as unknown as AgentSession;
}

function context() {
  return {
    cwd: "/workspace",
    model: { provider: "ctx", id: "default" },
    modelRegistry: {
      find: vi.fn((provider: string, id: string) => ({ provider, id })),
    },
  };
}

function setup(createSession = vi.fn(async () => ({ session: session() }))) {
  const tools: Tool[] = [];
  const pi = {
    registerTool: (tool: Tool) => tools.push(tool),
    getActiveTools: () => ["read"],
  };
  const runtime = new SubagentRuntime(pi as never, { createSession });
  registerPublicAgentTools({
    pi: pi as never,
    runtime,
    configPath: "/config.json",
    modelPresets: {
      low: { model: "ctx/default", thinking: "low" },
      high: { model: "ctx/default", thinking: "high" },
    },
  });
  return { tools, runtime, createSession };
}

function tool(tools: Tool[], name: string): Tool {
  const found = tools.find((candidate) => candidate.name === name);
  if (!found) {
    throw new Error(`Missing ${name}`);
  }
  return found;
}

describe("public subagent tools", () => {
  it("exposes an asynchronous-only public Agent contract", () => {
    const { tools } = setup();
    const agent = tool(tools, "Agent");
    const parameters = JSON.parse(JSON.stringify(agent.parameters));

    expect(agent.description).toContain("return its ID immediately");
    expect(parameters.properties.subagent_type.enum).toEqual([
      "Explore",
      "Review",
    ]);
    expect(parameters.properties).not.toHaveProperty("mode");
    expect(tool(tools, "get_subagent_result").description).toContain(
      "managed subagent",
    );
    expect(tool(tools, "steer_subagent").description).toContain(
      "running managed subagent",
    );
  });

  it("accepts Agent work without waiting and directs the caller to join", async () => {
    const promptDone = deferred<void>();
    const child = session("delivered result");
    child.prompt = vi.fn(() => promptDone.promise);
    const createSession = vi.fn(async () => ({ session: child }));
    const { tools, runtime } = setup(createSession);

    const result = await tool(tools, "Agent").execute(
      "call",
      { subagent_type: "Explore", prompt: "map the codebase" },
      undefined,
      undefined,
      context(),
    );

    expect(result.details).toMatchObject({
      id: "explore-1",
      status: "running",
    });
    expect(result.content[0].text).toContain(
      "Started managed subagent explore-1",
    );
    expect(result.content[0].text).toContain(
      "Continue useful independent work",
    );
    expect(result.content[0].text).toContain("get_subagent_result");
    expect(runtime.snapshot("explore-1")?.status).toBe("running");
    await vi.waitFor(() =>
      expect(createSession).toHaveBeenCalledWith(
        expect.objectContaining({
          cwd: "/workspace",
          tools: expect.arrayContaining(["read"]),
        }),
      ),
    );
    expect(child.setActiveToolsByName).toHaveBeenCalledWith(
      expect.arrayContaining(["read"]),
    );

    promptDone.resolve();
    await expect(runtime.wait("explore-1")).resolves.toMatchObject({
      status: "completed",
      result: "delivered result",
    });
  });

  it("cancels only a blocking public wait and permits a later join", async () => {
    const promptDone = deferred<void>();
    const child = session("complete after cancelled wait");
    child.prompt = vi.fn(() => promptDone.promise);
    const { tools, runtime } = setup(vi.fn(async () => ({ session: child })));
    const agent = tool(tools, "Agent");
    const getResult = tool(tools, "get_subagent_result");
    const started = await agent.execute(
      "start",
      { subagent_type: "Review", prompt: "review it" },
      undefined,
      undefined,
      context(),
    );
    const id = started.details.id as string;
    const controller = new AbortController();
    const waiting = getResult.execute(
      "wait",
      { id, wait: true },
      controller.signal,
      undefined,
      context(),
    );

    controller.abort();
    await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
    expect(runtime.snapshot(id)?.status).toBe("running");

    promptDone.resolve();
    const later = await getResult.execute(
      "later",
      { id, wait: true },
      undefined,
      undefined,
      context(),
    );
    expect(later.content[0].text).toBe("complete after cancelled wait");
  });

  it("keeps status and error rows distinct and actionable", () => {
    const theme = {
      fg: (_color: string, text: string) => text,
      bold: (text: string) => text,
    } as Theme;
    const rendered = (result: unknown, context: Record<string, unknown>) =>
      renderAgentResult(
        result as never,
        { expanded: false, isPartial: false },
        theme,
        context as never,
      )
        .render(120)
        .join("\n");

    expect(
      rendered(
        {
          content: [{ type: "text", text: "Unknown subagent review-404." }],
          isError: true,
        },
        { args: { id: "review-404", wait: true } },
      ),
    ).toContain("Could not retrieve subagent review-404");
    expect(
      rendered(
        {
          content: [{ type: "text", text: "Unknown subagent review-404." }],
          isError: true,
        },
        { args: { id: "review-404", message: "continue" } },
      ),
    ).toContain("Could not steer subagent review-404");
  });

  it("uses unique semantic IDs for public and Implement-managed work", async () => {
    const { runtime } = setup();
    const explore = runtime.queue({
      owner: "public-tool",
      type: "Explore",
      description: "explore",
      cwd: "/workspace",
    });
    const review = runtime.queue({
      owner: "public-tool",
      type: "Review",
      description: "review",
      cwd: "/workspace",
    });
    const implementer = runtime.queue({
      owner: { kind: "pipkin:implement", runId: "run", role: "implementer" },
      type: "pipkin:implement:implementer",
      description: "implement",
      cwd: "/workspace",
    });

    expect([explore.id, review.id, implementer.id]).toEqual([
      "explore-1",
      "review-2",
      "implementer-3",
    ]);
  });
});
