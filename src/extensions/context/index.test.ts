import { describe, expect, it } from "vitest";
import registerContext from "./index.ts";
import { EPOCH_TYPE } from "./policy.ts";

function readCall(id: string) {
  return {
    role: "assistant" as const,
    content: [
      {
        type: "toolCall" as const,
        id,
        name: "read",
        arguments: { path: "a.ts", offset: 1, limit: 200 },
      },
    ],
  };
}

function readResult(id: string, lines: number) {
  return {
    role: "toolResult" as const,
    toolCallId: id,
    toolName: "read",
    content: [{ type: "text" as const, text: "x".repeat(40_000) }],
    isError: false,
    timestamp: 1,
    details: {
      truncation: {
        totalLines: lines,
        totalBytes: 40_000,
        outputLines: lines,
        outputBytes: 40_000,
        truncated: false,
        truncatedBy: null,
        lastLinePartial: false,
        firstLineExceedsLimit: false,
        maxLines: 2_000,
        maxBytes: 50_000,
      },
    },
  };
}

describe("Context registration", () => {
  it("does not alter sibling read results before their first provider exposure", () => {
    let contextHandler: any;
    const entries: any[] = [
      { type: "model_change", provider: "other", modelId: "other" },
      { type: "model_change", provider: "test", modelId: "model" },
    ];
    registerContext({
      on: (event: string, handler: unknown) => {
        if (event === "context") {
          contextHandler = handler;
        }
      },
      registerTool: () => {},
      appendEntry: (customType: string, data: unknown) =>
        entries.push({ type: "custom", id: "epoch", customType, data }),
    } as never);
    const messages = [
      {
        role: "assistant" as const,
        content: [readCall("early").content[0], readCall("late").content[0]],
      },
      readResult("early", 2),
      readResult("late", 100),
    ];
    const ctx = {
      cwd: "/work",
      model: { provider: "test", id: "model" },
      sessionManager: {
        getBranch: () => entries,
        getLeafId: () => null,
      },
      ui: { notify: () => {} },
    };

    const first = contextHandler({ type: "context", messages }, ctx);

    expect(first.messages).toEqual(messages);
    expect(entries).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ customType: EPOCH_TYPE }),
      ]),
    );

    messages.push({ role: "assistant", content: [] });
    const exposed = contextHandler({ type: "context", messages }, ctx);

    expect((exposed.messages[1] as any).content[0]?.text).toContain(
      'context_recall("early")',
    );
    expect(entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          customType: EPOCH_TYPE,
          data: expect.objectContaining({ kind: "known-cold" }),
        }),
      ]),
    );
    expect((messages[1] as any)?.content[0]?.text).toHaveLength(40_000);
  });
});
