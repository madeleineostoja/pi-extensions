import { describe, expect, it, vi, beforeEach } from "vitest";
import { getSubagentRuntime, resetSubagentRuntime } from "./runtime.js";
import { GENERAL_DEFINITION } from "./definitions.js";
import { readConfig } from "./config.js";

vi.mock("@earendil-works/pi-coding-agent", async () => {
  const actual = await vi.importActual<
    typeof import("@earendil-works/pi-coding-agent")
  >("@earendil-works/pi-coding-agent");
  return {
    ...actual,
    createAgentSession: vi.fn(async () => ({
      session: {
        subscribe: vi.fn(),
        sendUserMessage: vi.fn(async () => {}),
        steer: vi.fn(async () => {}),
        abort: vi.fn(async () => {}),
        dispose: vi.fn(),
        isStreaming: false,
        hasPendingMessages: vi.fn(() => false),
        getSessionStats: vi.fn(() => ({
          tokens: {
            total: 0,
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
          },
          cost: 0,
          userMessages: 0,
          assistantMessages: 0,
          toolCalls: 0,
          toolResults: 0,
          totalMessages: 0,
        })),
        getLastAssistantText: vi.fn(() => "done"),
      },
      extensionsResult: {},
    })),
  };
});

vi.mock("./config.js", async () => {
  const actual =
    await vi.importActual<typeof import("./config.js")>("./config.js");
  return {
    ...actual,
    readConfig: vi.fn(() => ({ path: "/fake/config.json", config: {} })),
  };
});

describe("SubagentRuntime", () => {
  beforeEach(() => {
    resetSubagentRuntime();
    vi.mocked(readConfig).mockReturnValue({
      path: "/fake/config.json",
      config: {},
    });
  });

  it("registers and lists definitions", () => {
    const runtime = getSubagentRuntime();
    const result = runtime.registerDefinition(GENERAL_DEFINITION);
    expect(result.ok).toBe(true);
    expect(runtime.hasDefinition("General")).toBe(true);
    expect(runtime.getDefinition("General")?.displayName).toBe("General");
    expect(runtime.listDefinitions()).toHaveLength(1);
  });

  it("returns error for conflicting definitions", () => {
    const runtime = getSubagentRuntime();
    runtime.registerDefinition(GENERAL_DEFINITION);
    const result = runtime.registerDefinition({
      ...GENERAL_DEFINITION,
      description: "different",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("already registered");
    }
  });

  it("is idempotent for equivalent definitions", () => {
    const runtime = getSubagentRuntime();
    runtime.registerDefinition(GENERAL_DEFINITION);
    const result = runtime.registerDefinition({ ...GENERAL_DEFINITION });
    expect(result.ok).toBe(true);
  });

  it("lists only public definitions when publicOnly is true", () => {
    const runtime = getSubagentRuntime();
    runtime.registerDefinition(GENERAL_DEFINITION);
    runtime.registerDefinition({
      ...GENERAL_DEFINITION,
      name: "Internal",
      public: false,
    });
    const all = runtime.listDefinitions();
    const publicOnly = runtime.listDefinitions({ publicOnly: true });
    expect(all).toHaveLength(2);
    expect(publicOnly).toHaveLength(1);
    expect(publicOnly[0].name).toBe("General");
  });

  it("throws when spawning unknown type", async () => {
    const runtime = getSubagentRuntime();
    await expect(
      runtime.spawn({ type: "Unknown", prompt: "p", description: "d" }),
    ).rejects.toThrow("Unknown agent type");
  });

  it("returns an id immediately on spawn", async () => {
    const runtime = getSubagentRuntime();
    runtime.registerDefinition(GENERAL_DEFINITION);
    const id = await runtime.spawn({
      type: "General",
      prompt: "hello",
      description: "test",
    });
    expect(id).toMatch(/^subagent-/);
    const record = runtime.getRecord(id);
    expect(record).toBeDefined();
    expect(record?.status).toBe("running");
  });

  it("waitFor returns failed for missing agent", async () => {
    const runtime = getSubagentRuntime();
    const result = await runtime.waitFor("nonexistent");
    expect(result.status).toBe("failed");
    if (result.status !== "completed") {
      expect(result.error).toContain("not found");
    }
  });

  it("stop is no-op for missing agent", async () => {
    const runtime = getSubagentRuntime();
    await expect(runtime.stop("nonexistent")).resolves.toBeUndefined();
  });

  it("steer queues message when session not initialized", async () => {
    const runtime = getSubagentRuntime();
    runtime.registerDefinition(GENERAL_DEFINITION);
    const id = await runtime.spawn({
      type: "General",
      prompt: "hello",
      description: "test",
    });
    await runtime.steer(id, "change direction");
    const record = runtime.getRecord(id);
    expect(record).toBeDefined();
  });

  it("snapshots returns current records", async () => {
    const runtime = getSubagentRuntime();
    runtime.registerDefinition(GENERAL_DEFINITION);
    const id = await runtime.spawn({
      type: "General",
      prompt: "hello",
      description: "test",
    });
    const snapshots = runtime.snapshots();
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].id).toBe(id);
  });
});

describe("model resolution", () => {
  beforeEach(() => {
    resetSubagentRuntime();
  });

  it("uses explicit spawn model first", async () => {
    const runtime = getSubagentRuntime();
    runtime.registerDefinition(GENERAL_DEFINITION);
    const id = await runtime.spawn(
      {
        type: "General",
        prompt: "p",
        description: "d",
        model: "explicit/model",
      },
      { parentModel: "parent/model" },
    );
    const record = runtime.getRecord(id);
    expect(record?.model).toBe("explicit/model");
  });

  it("uses config model when no explicit model and config is valid", async () => {
    vi.mocked(readConfig).mockReturnValue({
      path: "/fake/config.json",
      config: { models: { General: "config/model" } },
    });
    const runtime = getSubagentRuntime();
    runtime.registerDefinition(GENERAL_DEFINITION);
    const fakeRegistry = {
      find: vi.fn((provider: string, id: string) =>
        provider === "config" && id === "model"
          ? ({ provider, id } as any)
          : undefined,
      ),
    };
    const id = await runtime.spawn(
      { type: "General", prompt: "p", description: "d" },
      { modelRegistry: fakeRegistry as any, parentModel: "parent/model" },
    );
    const record = runtime.getRecord(id);
    expect(record?.model).toBe("config/model");
  });

  it("falls back to parent model when config model is invalid", async () => {
    vi.mocked(readConfig).mockReturnValue({
      path: "/fake/config.json",
      config: { models: { General: "invalid-model" } },
    });
    const runtime = getSubagentRuntime();
    runtime.registerDefinition(GENERAL_DEFINITION);
    const fakeRegistry = {
      find: vi.fn(() => undefined),
    };
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const id = await runtime.spawn(
      { type: "General", prompt: "p", description: "d" },
      { modelRegistry: fakeRegistry as any, parentModel: "parent/model" },
    );
    const record = runtime.getRecord(id);
    expect(record?.model).toBe("parent/model");
    expect(consoleWarn).toHaveBeenCalledWith(
      expect.stringContaining("invalid-model"),
    );
    consoleWarn.mockRestore();
  });

  it("falls back to parent model when no config model", async () => {
    const runtime = getSubagentRuntime();
    runtime.registerDefinition(GENERAL_DEFINITION);
    const id = await runtime.spawn(
      { type: "General", prompt: "p", description: "d" },
      { parentModel: "parent/model" },
    );
    const record = runtime.getRecord(id);
    expect(record?.model).toBe("parent/model");
  });

  it("does not fall back to parent model for caller-only definitions", async () => {
    const runtime = getSubagentRuntime();
    runtime.registerDefinition({
      ...GENERAL_DEFINITION,
      name: "Internal",
      public: false,
      resolveModel: "caller-only",
    });
    const id = await runtime.spawn(
      { type: "Internal", prompt: "p", description: "d" },
      { parentModel: "parent/model" },
    );
    const record = runtime.getRecord(id);
    expect(record?.model).toBe("parent/model");
  });
});
