import { describe, expect, it, vi } from "vitest";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import { buildPrompt, estimateBtwTokens } from "./prompt.js";

vi.mock("@earendil-works/pi-coding-agent", async () => {
  const actual = await vi.importActual<
    typeof import("@earendil-works/pi-coding-agent")
  >("@earendil-works/pi-coding-agent");
  return { ...actual, convertToLlm: vi.fn() };
});

const convertToLlmMock = vi.mocked(convertToLlm);

const model = { contextWindow: 1_600, maxTokens: 1_024 };

function session(messages: unknown[]) {
  return {
    buildSessionContext: () => ({ messages }),
  } as never;
}

function expectWithinModelWindow(
  prompt: ReturnType<typeof buildPrompt>,
  contextWindow = model.contextWindow,
) {
  expect(
    estimateBtwTokens(prompt.context) +
      prompt.maxTokens +
      prompt.overheadTokens,
  ).toBeLessThanOrEqual(contextWindow);
}

describe("BTW prompt", () => {
  it("uses Pi's compaction-aware session context instead of the raw branch", () => {
    const builtMessages = [{ role: "user", content: "kept" }];
    convertToLlmMock.mockReturnValue(builtMessages as never);
    const manager = session(builtMessages);

    const prompt = buildPrompt(manager, [], "current question", model);

    expect(convertToLlmMock).toHaveBeenCalledWith(builtMessages);
    expect(prompt.context.messages.at(-1)).toMatchObject({ role: "user" });
  });

  it("retains only complete, ID-matched tool-call groups", () => {
    const completeCall = {
      role: "assistant",
      content: [
        { type: "toolCall", id: "call-1", name: "read", arguments: {} },
        { type: "toolCall", id: "call-2", name: "grep", arguments: {} },
      ],
      timestamp: 2,
    };
    const completeResults = [
      {
        role: "toolResult",
        toolCallId: "call-2",
        toolName: "grep",
        content: [{ type: "text", text: "second" }],
        isError: false,
        timestamp: 3,
      },
      {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "read",
        content: [{ type: "text", text: "first" }],
        isError: false,
        timestamp: 4,
      },
    ];
    const incompleteCall = {
      role: "assistant",
      content: [
        { type: "toolCall", id: "missing", name: "read", arguments: {} },
      ],
      timestamp: 5,
    };
    const wrongResult = {
      role: "toolResult",
      toolCallId: "wrong",
      toolName: "read",
      content: [{ type: "text", text: "omit" }],
      isError: false,
      timestamp: 6,
    };
    convertToLlmMock.mockReturnValue([
      completeCall,
      ...completeResults,
      incompleteCall,
      wrongResult,
    ] as never);

    const prompt = buildPrompt(session([]), [], "question", model);
    const messages = prompt.context.messages as Array<{
      role: string;
      content?: Array<{ type: string; id?: string }>;
      toolCallId?: string;
    }>;
    const calls = new Set(
      messages.flatMap(
        (message) =>
          message.content?.flatMap((part) =>
            part.type === "toolCall" && part.id ? [part.id] : [],
          ) ?? [],
      ),
    );

    expect(calls).toEqual(new Set(["call-1", "call-2"]));
    expect(
      messages.filter((message) => message.role === "toolResult"),
    ).toHaveLength(2);
    expect(
      messages
        .filter((message) => message.role === "toolResult")
        .every((message) => calls.has(message.toolCallId!)),
    ).toBe(true);
  });

  it("keeps contiguous newest boundaries without recovering older context", () => {
    convertToLlmMock.mockReturnValue([
      { role: "user", content: "older fitting context", timestamp: 1 },
      { role: "user", content: "newest ".repeat(4_000), timestamp: 2 },
    ] as never);

    const prompt = buildPrompt(session([]), [], "question", model);

    expect(JSON.stringify(prompt.context.messages)).not.toContain(
      "older fitting context",
    );
  });

  it("prioritizes fitting recent side exchanges before session context", () => {
    const constrained = { contextWindow: 1_000, maxTokens: 600 };
    convertToLlmMock.mockReturnValue([
      { role: "user", content: "older session context", timestamp: 1 },
      { role: "user", content: "newest session ".repeat(500), timestamp: 2 },
    ] as never);

    const prompt = buildPrompt(
      session([]),
      [
        {
          question: "recent side question ".repeat(20),
          answer: "recent side answer ".repeat(20),
        },
      ],
      "current question",
      constrained,
    );

    expect(JSON.stringify(prompt.context.messages)).toContain(
      "recent side question",
    );
    expect(JSON.stringify(prompt.context.messages)).not.toContain(
      "older session context",
    );
    expectWithinModelWindow(prompt, constrained.contextWindow);
  });

  it.each([
    ["ASCII", "question ".repeat(10_000)],
    ["astral", "😀".repeat(10_000)],
  ])(
    "fits an oversized %s question with the answer and overhead reserves",
    (_kind, question) => {
      convertToLlmMock.mockReturnValue([] as never);

      const prompt = buildPrompt(session([]), [], question, model);
      const current = prompt.context.messages.at(-1) as {
        content: Array<{ text: string }>;
      };

      expect(current.content[0]?.text).toMatch(/…$/);
      expect(prompt.maxTokens).toBeGreaterThan(0);
      expect(prompt.maxTokens).toBeLessThanOrEqual(model.maxTokens);
      expectWithinModelWindow(prompt);
    },
  );
});
