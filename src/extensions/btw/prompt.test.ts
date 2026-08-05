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
  it("uses only Pi's current compaction-aware session context and question", () => {
    const builtMessages = [{ role: "user", content: "kept" }];
    convertToLlmMock.mockReturnValue(builtMessages as never);

    const prompt = buildPrompt(
      session(builtMessages),
      "current question",
      model,
    );

    expect(convertToLlmMock).toHaveBeenCalledWith(builtMessages);
    expect(prompt.context.messages).toHaveLength(2);
    expect(prompt.context.messages.at(-1)).toMatchObject({ role: "user" });
    expect(JSON.stringify(prompt.context.messages)).not.toContain(
      "Previous side question",
    );
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
    convertToLlmMock.mockReturnValue([
      completeCall,
      ...completeResults,
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "missing", name: "read", arguments: {} },
        ],
        timestamp: 5,
      },
    ] as never);

    const prompt = buildPrompt(session([]), "question", model);
    const messages = prompt.context.messages as Array<{
      role: string;
      content?: Array<{ type: string; id?: string }>;
      toolCallId?: string;
    }>;

    expect(
      messages.filter((message) => message.role === "toolResult"),
    ).toHaveLength(2);
    expect(JSON.stringify(messages)).not.toContain("missing");
  });

  it("keeps contiguous newest session boundaries", () => {
    convertToLlmMock.mockReturnValue([
      { role: "user", content: "older fitting context", timestamp: 1 },
      { role: "user", content: "newest ".repeat(4_000), timestamp: 2 },
    ] as never);

    const prompt = buildPrompt(session([]), "question", model);

    expect(JSON.stringify(prompt.context.messages)).not.toContain(
      "older fitting context",
    );
  });

  it.each([
    ["ASCII", "question ".repeat(10_000)],
    ["astral", "😀".repeat(10_000)],
  ])(
    "fits an oversized %s question with answer and overhead reserves",
    (_kind, question) => {
      convertToLlmMock.mockReturnValue([] as never);

      const prompt = buildPrompt(session([]), question, model);
      const current = prompt.context.messages.at(-1) as {
        content: Array<{ text: string }>;
      };

      expect(current.content[0]?.text).toMatch(/…$/);
      expectWithinModelWindow(prompt);
    },
  );
});
