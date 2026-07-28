import { describe, expect, it } from "vitest";
import { parseLineRange, registerRecallTool } from "./recall.ts";

function toolResult(id: string, content: unknown) {
  return {
    type: "message",
    id: `entry-${id}`,
    parentId: null,
    timestamp: "now",
    message: {
      role: "toolResult",
      toolCallId: id,
      toolName: "read",
      content,
      isError: false,
    },
  };
}

function recall(entries: unknown[]) {
  let definition: any;
  registerRecallTool({
    registerTool: (tool: unknown) => (definition = tool),
  } as any);
  return (params: { id: string; lines?: string }) =>
    definition.execute("recall", params, undefined, undefined, {
      sessionManager: { getEntries: () => entries },
    });
}

describe("context_recall", () => {
  it("returns stored full content unchanged", async () => {
    const content = [
      { type: "text" as const, text: "first" },
      { type: "image" as const, source: { type: "base64", data: "abc" } },
    ];
    const result = await recall([toolResult("source", content)])({
      id: "source",
    });
    expect(result.isError).toBeUndefined();
    expect(result.content).toBe(content);
  });

  it("returns real failures for missing ids, invalid shapes, and empty slices", async () => {
    const execute = recall([
      toolResult("text", [{ type: "text", text: "one\ntwo" }]),
      toolResult("multi", [
        { type: "text", text: "one" },
        { type: "text", text: "two" },
      ]),
    ]);
    await expect(execute({ id: "missing" })).resolves.toMatchObject({
      isError: true,
    });
    await expect(execute({ id: "text", lines: "0" })).resolves.toMatchObject({
      isError: true,
    });
    await expect(execute({ id: "multi", lines: "1" })).resolves.toMatchObject({
      isError: true,
    });
    await expect(execute({ id: "text", lines: "99" })).resolves.toMatchObject({
      isError: true,
    });
  });

  it("returns a bounded line slice", async () => {
    const result = await recall([
      toolResult("text", [{ type: "text", text: "one\ntwo\nthree" }]),
    ])({ id: "text", lines: "2-3" });
    expect(result).toMatchObject({
      content: [{ type: "text", text: "two\nthree" }],
    });
  });
});

describe("parseLineRange", () => {
  it("accepts only positive ordered ranges", () => {
    expect(parseLineRange("5")).toEqual({ start: 5, end: 5 });
    expect(parseLineRange("5-7")).toEqual({ start: 5, end: 7 });
    expect(parseLineRange("7-5")).toBeUndefined();
  });
});
