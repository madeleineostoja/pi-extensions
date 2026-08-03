import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
} from "@earendil-works/pi-coding-agent";
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

function toolCall(id: string, name: string, arguments_: unknown) {
  return {
    type: "message",
    id: `call-entry-${id}`,
    parentId: null,
    timestamp: "now",
    message: {
      role: "assistant",
      content: [{ type: "toolCall", id, name, arguments: arguments_ }],
    },
  };
}

function recall(entries: unknown[]) {
  let definition: any;
  registerRecallTool({
    registerTool: (tool: unknown) => (definition = tool),
  } as any);
  return {
    execute: (params: { id: string; lines?: string; find?: string }) =>
      definition.execute("recall", params, undefined, undefined, {
        sessionManager: { getEntries: () => entries },
      }),
    definition,
  };
}

describe("context_recall", () => {
  it("returns stored full content unchanged", async () => {
    const content = [
      { type: "text" as const, text: "first" },
      { type: "image" as const, data: "abc", mimeType: "image/png" },
    ];
    const result = await recall([toolResult("source", content)]).execute({
      id: "source",
    });
    expect(result.isError).toBeUndefined();
    expect(result.content).toBe(content);
    expect(result.details).toMatchObject({
      id: "source",
      source: { fullToolCallId: "source", target: "source" },
      selector: { type: "full" },
    });
  });

  it("returns real failures for missing ids, invalid shapes, and empty slices", async () => {
    const execute = recall([
      toolResult("text", [{ type: "text", text: "one\ntwo" }]),
      toolResult("multi", [
        { type: "text", text: "one" },
        { type: "text", text: "two" },
      ]),
      toolResult("image", [
        { type: "image", data: "abc", mimeType: "image/png" },
      ]),
    ]).execute;
    await expect(execute({ id: "missing" })).rejects.toThrow("no tool result");
    await expect(execute({ id: "text", lines: "" })).rejects.toThrow(
      "invalid lines",
    );
    await expect(execute({ id: "text", lines: "0" })).rejects.toThrow(
      "invalid lines",
    );
    await expect(execute({ id: "multi", lines: "1" })).rejects.toThrow(
      "requires one text",
    );
    await expect(execute({ id: "multi", lines: "bad" })).rejects.toThrow(
      "invalid lines",
    );
    await expect(execute({ id: "image", lines: "bad" })).rejects.toThrow(
      "invalid lines",
    );
    await expect(execute({ id: "text", lines: "99" })).rejects.toThrow(
      "unavailable",
    );
  });

  it("returns a bounded line slice", async () => {
    const result = await recall([
      toolResult("text", [{ type: "text", text: "one\ntwo\nthree" }]),
    ]).execute({ id: "text", lines: "2-3" });
    expect(result).toMatchObject({
      content: [{ type: "text", text: "two\nthree" }],
      details: {
        id: "text",
        lines: "2-3",
        selector: { type: "lines", lines: "2-3" },
      },
    });
  });

  it("uses a strict mutually exclusive selector schema", async () => {
    const { definition, execute } = recall([
      toolResult("text", [{ type: "text", text: "one\ntwo" }]),
    ]);
    expect(definition.parameters.additionalProperties).toBe(false);
    await expect(
      execute({ id: "text", lines: "1", find: "one" }),
    ).rejects.toThrow("either lines or find");
    await expect(execute({ id: "text", find: "  " })).rejects.toThrow(
      "non-empty literal",
    );
  });

  it("searches ANSI-stripped text without changing the stored source line", async () => {
    const source = "first\n\u001b[31mAsSeRtIoNeRrOr\u001b[0m: boom\nthird";
    const result = await recall([
      toolResult("source", [{ type: "text", text: source }]),
    ]).execute({ id: "source", find: "assertionerror" });
    expect(result.content[0].text).toContain("2 | \u001b[31mAsSeRtIoNeRrOr");
    expect(result.content[0].text).toContain("1 | first");
    expect(result.content[0].text).toContain("3 | third");
    expect(result.details.selector).toMatchObject({
      type: "find",
      totalMatches: 1,
      selectedMatchAnchors: 1,
      visibleSelectedMatchAnchors: 1,
      visibleMatchingLines: 1,
      sourceLines: 3,
    });
  });

  it("merges overlapping and adjacent match windows", async () => {
    const source = Array.from({ length: 12 }, (_, index) =>
      index === 3 || index === 5 ? `match ${index + 1}` : `line ${index + 1}`,
    ).join("\n");
    const result = await recall([
      toolResult("source", [{ type: "text", text: source }]),
    ]).execute({ id: "source", find: "match" });
    const text = result.content[0].text;
    expect(text).toContain("1 | line 1");
    expect(text).toContain("9 | line 9");
    expect(text).not.toContain("…");
    expect(result.details.selector.windows).toBe(1);
  });

  it("reports omitted matches and successful no-match searches", async () => {
    const source = Array.from({ length: 11 }, (_, index) => `match ${index}`)
      .concat("other")
      .join("\n");
    const execute = recall([
      toolResult("source", [{ type: "text", text: source }]),
    ]).execute;
    const matches = await execute({ id: "source", find: "match" });
    expect(matches.content[0].text).toContain(
      "Additional matches were not selected as anchors",
    );
    expect(matches.content[0].text).not.toContain("matches shown");
    expect(matches.details.selector).toMatchObject({
      totalMatches: 11,
      selectedMatchAnchors: 10,
      visibleSelectedMatchAnchors: 10,
      visibleMatchingLines: 11,
      outputTruncated: false,
    });
    const noMatch = await execute({ id: "source", find: "absent" });
    expect(noMatch.content[0].text).toContain(
      'No matches for "absent" in source.',
    );
    expect(noMatch.isError).toBeUndefined();
  });

  it("bounds search projections and visibly truncates pathological source lines", async () => {
    const source = Array.from({ length: 10 }, (_, match) =>
      Array.from(
        { length: 8 },
        (_, line) =>
          `${line === 3 ? `match ${match}` : "spacer"} ${"🙂".repeat(20_000)}`,
      ).join("\n"),
    ).join("\n");
    const result = await recall([
      toolResult("source", [{ type: "text", text: source }]),
    ]).execute({ id: "source", find: "match" });
    const text = result.content[0].text;
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(
      DEFAULT_MAX_BYTES,
    );
    expect(text.split("\n").length).toBeLessThanOrEqual(DEFAULT_MAX_LINES);
    expect(text).toContain("[truncated]");
    expect(text).toContain("Search output truncated");
    expect(result.details.selector).toMatchObject({
      selectedMatchAnchors: 10,
      visibleSelectedMatchAnchors: expect.any(Number),
      outputTruncated: true,
    });
    expect(result.details.selector.visibleSelectedMatchAnchors).toBeLessThan(
      result.details.selector.selectedMatchAnchors,
    );
  });

  it("identifies whitespace-sensitive literals without changing their meaning", async () => {
    const execute = recall([
      toolResult("source", [{ type: "text", text: "foo bar\nfoo\tbar" }]),
    ]).execute;
    const repeatedSpace = await execute({ id: "source", find: "foo  bar" });
    expect(repeatedSpace.content[0].text).toContain(
      'No matches for "foo  bar"',
    );
    const tab = await execute({ id: "source", find: "foo\tbar" });
    expect(tab.content[0].text).toContain('Matches for "foo\\tbar"');
    const newline = await execute({ id: "source", find: "foo\nbar" });
    expect(newline.content[0].text).toContain('No matches for "foo\\nbar"');
  });

  it("rejects searches and slices for image or multi-block sources", async () => {
    const execute = recall([
      toolResult("image", [
        { type: "image", data: "abc", mimeType: "image/png" },
      ]),
      toolResult("multi", [
        { type: "text", text: "one" },
        { type: "text", text: "two" },
      ]),
    ]).execute;
    await expect(execute({ id: "image", find: "one" })).rejects.toThrow(
      "literal search requires one text",
    );
    await expect(execute({ id: "multi", find: "one" })).rejects.toThrow(
      "literal search requires one text",
    );
  });

  it("keeps source display metadata separate and uses safe fallbacks", async () => {
    const bash = await recall([
      toolCall("bash-id", "bash", {
        command: "echo\n\u001b[31mhello\u001b[0m",
      }),
      toolResult("bash-id", [{ type: "text", text: "stored output" }]),
    ]).execute({ id: "bash-id" });
    expect(bash.content).toEqual([{ type: "text", text: "stored output" }]);
    expect(bash.details.source).toEqual({
      fullToolCallId: "bash-id",
      toolName: "bash",
      target: "echo hello",
    });

    const read = await recall([
      toolCall("read-id", "read", { path: "ignored" }),
      toolResult("read-id", [{ type: "text", text: "stored" }]),
    ]).execute({ id: "read-id" });
    expect(read.details.source).toEqual({
      fullToolCallId: "read-id",
      toolName: "read",
      target: "read",
    });

    const fallback = await recall([
      toolCall("bad-id", "bash", {}),
      toolResult("bad-id", [{ type: "text", text: "stored" }]),
    ]).execute({ id: "bad-id" });
    expect(fallback.details.source).toEqual({
      fullToolCallId: "bad-id",
      target: "bad-id",
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
