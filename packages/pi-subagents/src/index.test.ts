import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resetSubagentRuntime } from "./runtime.js";

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

function makeFakeExtensionAPI(): ExtensionAPI {
  return {
    registerTool: vi.fn(),
    registerCommand: vi.fn(),
    registerShortcut: vi.fn(),
    registerFlag: vi.fn(),
    getFlag: vi.fn(),
    registerMessageRenderer: vi.fn(),
    sendMessage: vi.fn(),
    sendUserMessage: vi.fn(),
    appendEntry: vi.fn(),
    setSessionName: vi.fn(),
    getSessionName: vi.fn(),
    setLabel: vi.fn(),
    exec: vi.fn(),
    getActiveTools: vi.fn(),
    getAllTools: vi.fn(),
    setActiveTools: vi.fn(),
    getCommands: vi.fn(),
    setModel: vi.fn(),
    getThinkingLevel: vi.fn(),
    setThinkingLevel: vi.fn(),
    registerProvider: vi.fn(),
    unregisterProvider: vi.fn(),
    events: {
      on: vi.fn(() => () => {}),
      emit: vi.fn(),
    },
    on: vi.fn(),
  } as unknown as ExtensionAPI;
}

describe("pi-subagents extension entrypoint", () => {
  beforeEach(() => {
    resetSubagentRuntime();
  });

  it("registers public builtin definitions and interactive tools", async () => {
    const pi = makeFakeExtensionAPI();
    const init = (await import("./index.js")).default;
    init(pi);

    expect(pi.registerTool).toHaveBeenCalledTimes(3);
    const toolNames = vi
      .mocked(pi.registerTool)
      .mock.calls.map((call) => call[0].name);
    expect(toolNames).toContain("Agent");
    expect(toolNames).toContain("get_subagent_result");
    expect(toolNames).toContain("steer_subagent");
  });

  it("Agent tool description mentions General, Explore, and Review", async () => {
    const pi = makeFakeExtensionAPI();
    const init = (await import("./index.js")).default;
    init(pi);

    const agentTool = vi
      .mocked(pi.registerTool)
      .mock.calls.find((call) => call[0].name === "Agent")?.[0];
    expect(agentTool).toBeDefined();
    expect(agentTool!.description).toContain("General");
    expect(agentTool!.description).toContain("Explore");
    expect(agentTool!.description).toContain("Review");
  });
});
