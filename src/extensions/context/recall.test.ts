import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseLineRange, registerRecallTool } from "./recall.ts";

function toolResult(id: string, content: unknown, details?: unknown) {
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
      details,
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
  it("advertises retained outcomes as immediately recallable", () => {
    const { definition } = recall([]);

    expect(definition.description).toContain(
      "retained by an outcome tool or hidden behind a Context pruning stub",
    );
    expect(definition.promptSnippet).toBeUndefined();
    expect(definition.promptGuidelines).toBeUndefined();
  });

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
    expect(definition.parameters.properties.lines.description).toContain(
      "mutually exclusive with find",
    );
    expect(definition.parameters.properties.find.description).toContain(
      "mutually exclusive with lines",
    );
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
      "Additional matches were not selected as anchors; narrow the literal to select a smaller set.",
    );
    expect(matches.content[0].text).toContain("11 | match 10");
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

  it("identifies whitespace-sensitive literals with unambiguous labels", async () => {
    const execute = recall([
      toolResult("source", [
        {
          type: "text",
          text: 'foo bar\nfoo\tbar\nfoo\\tbar\nfoo\\nbar\nquoted "value" \\tail',
        },
      ]),
    ]).execute;
    const repeatedSpace = await execute({ id: "source", find: "foo  bar" });
    expect(repeatedSpace.content[0].text).toContain(
      'No matches for "foo  bar"',
    );
    const tab = await execute({ id: "source", find: "foo\tbar" });
    expect(tab.content[0].text).toContain('Matches for "foo\\tbar"');
    const literalTab = await execute({ id: "source", find: "foo\\tbar" });
    expect(literalTab.content[0].text).toContain('Matches for "foo\\\\tbar"');
    const newline = await execute({ id: "source", find: "foo\nbar" });
    expect(newline.content[0].text).toContain('No matches for "foo\\nbar"');
    const literalNewline = await execute({ id: "source", find: "foo\\nbar" });
    expect(literalNewline.content[0].text).toContain(
      'Matches for "foo\\\\nbar"',
    );
    const quoted = await execute({
      id: "source",
      find: 'quoted "value" \\tail',
    });
    expect(quoted.content[0].text).toContain(
      'Matches for "quoted \\"value\\" \\\\tail"',
    );
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

  it("prefers validated retained Bash content and rejects malformed projections", async () => {
    const retained = await recall([
      toolResult(
        "outcome",
        [{ type: "text", text: "Bash command succeeded." }],
        {
          retainedResult: {
            type: "pipkin.context.retained-result",
            version: 1,
            result: {
              content: [{ type: "text", text: "first\nsecond" }],
              details: { truncation: { truncated: false } },
            },
          },
        },
      ),
    ]).execute({ id: "outcome", lines: "2" });
    expect(retained.content).toEqual([{ type: "text", text: "second" }]);
    expect(retained.details.retainedDetails).toEqual({
      truncation: { truncated: false },
    });

    await expect(
      recall([
        {
          type: "message",
          id: "entry-broken",
          parentId: null,
          timestamp: "now",
          message: {
            role: "toolResult",
            toolCallId: "broken",
            toolName: "bash_outcome",
            content: [{ type: "text", text: "Bash command succeeded." }],
            details: { retainedResult: { version: 1 } },
            isError: false,
          },
        },
      ]).execute({ id: "broken" }),
    ).rejects.toThrow("retained Bash content");
  });

  it("recalls ordinary failed Bash outcomes without exposing success projections", async () => {
    const entries = [
      {
        type: "message",
        id: "entry-failure",
        parentId: null,
        timestamp: "now",
        message: {
          role: "toolResult",
          toolCallId: "failure",
          toolName: "bash_outcome",
          content: [{ type: "text", text: "exit 1\nAssertionError" }],
          isError: true,
        },
      },
    ];
    const execute = recall(entries).execute;

    await expect(execute({ id: "failure" })).resolves.toMatchObject({
      content: [{ type: "text", text: "exit 1\nAssertionError" }],
    });
    await expect(execute({ id: "failure", lines: "2" })).resolves.toMatchObject(
      {
        content: [{ type: "text", text: "AssertionError" }],
      },
    );
    await expect(
      execute({ id: "failure", find: "assertionerror" }),
    ).resolves.toMatchObject({
      content: [
        { type: "text", text: expect.stringContaining("2 | AssertionError") },
      ],
    });
  });

  it("fails closed for a malformed managed-process envelope even when details claim failure", async () => {
    const execute = recall([
      toolCall("malformed-process", "get_process_result", {
        id: "process-1",
        wait: true,
        resultMode: "outcome",
      }),
      toolResult("malformed-process", [{ type: "text", text: "summary" }], {
        retainedResult: { version: 1 },
        snapshot: { id: "process-1", status: "failed" },
        resultMode: "outcome",
      }),
    ]).execute;
    await expect(execute({ id: "malformed-process" })).rejects.toThrow(
      "retained managed process content",
    );
  });

  it("recalls the ordinary failed managed-process outcome fallback", async () => {
    const execute = recall([
      toolCall("failed-process", "get_process_result", {
        id: "process-1",
        wait: true,
        resultMode: "outcome",
      }),
      toolResult("failed-process", [{ type: "text", text: "exit 1\nneedle" }], {
        snapshot: { id: "process-1", status: "failed" },
        resultMode: "outcome",
      }),
    ]).execute;
    await expect(execute({ id: "failed-process" })).resolves.toMatchObject({
      content: [{ type: "text", text: "exit 1\nneedle" }],
    });
    await expect(
      execute({ id: "failed-process", lines: "2" }),
    ).resolves.toMatchObject({ content: [{ type: "text", text: "needle" }] });
    await expect(
      execute({ id: "failed-process", find: "needle" }),
    ).resolves.toMatchObject({
      content: [{ type: "text", text: expect.stringContaining("2 | needle") }],
    });
  });

  it("retains recalled outcomes through persisted, resumed, forked, and in-memory sessions", async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), "pipkin-context-recall-"));
    const ordinary = {
      content: [{ type: "text", text: "first\nneedle\nthird" }],
      details: { truncation: { truncated: false } },
    };
    const details = {
      retainedResult: {
        type: "pipkin.context.retained-result",
        version: 1,
        result: ordinary,
      },
    };
    const message = {
      role: "toolResult" as const,
      toolCallId: "outcome",
      toolName: "bash_outcome",
      content: [{ type: "text" as const, text: "Bash command succeeded." }],
      details,
      isError: false,
      timestamp: 1,
    };
    const recallFrom = async (
      manager: SessionManager,
      params: { id: string; lines?: string; find?: string },
    ) => {
      const execute = recall(manager.getEntries()).execute;
      return execute(params);
    };
    const appendOutcome = (manager: SessionManager) => {
      manager.appendMessage({
        role: "assistant",
        content: [],
        timestamp: 0,
      } as never);
      manager.appendMessage(message);
    };
    try {
      const persisted = SessionManager.create("/work", sessionDir);
      appendOutcome(persisted);
      const file = persisted.getSessionFile()!;
      const resumed = SessionManager.open(file, sessionDir);
      const forked = SessionManager.forkFrom(file, "/fork", sessionDir);
      const inMemory = SessionManager.inMemory("/work");
      appendOutcome(inMemory);

      await expect(
        recallFrom(persisted, { id: "outcome" }),
      ).resolves.toMatchObject({
        content: ordinary.content,
      });
      await expect(
        recallFrom(resumed, { id: "outcome", lines: "2" }),
      ).resolves.toMatchObject({
        content: [{ type: "text", text: "needle" }],
      });
      await expect(
        recallFrom(forked, { id: "outcome", find: "needle" }),
      ).resolves.toMatchObject({
        content: [
          { type: "text", text: expect.stringContaining("2 | needle") },
        ],
      });
      await expect(
        recallFrom(inMemory, { id: "outcome" }),
      ).resolves.toMatchObject({
        details: { retainedDetails: ordinary.details },
      });
    } finally {
      rmSync(sessionDir, { force: true, recursive: true });
    }
  });

  it("renders source-aware recall accounting without changing recalled content", async () => {
    const entries = [
      toolCall("bash-id", "bash", {
        command: [
          "printf first",
          "\u001b[31msecond\u001b[0m",
          "x".repeat(200),
        ].join("\n"),
      }),
      toolResult("bash-id", [{ type: "text", text: "first\nsecond" }]),
    ];
    const { definition, execute } = recall(entries);
    const result = await execute({ id: "bash-id", find: "second" });
    const theme = {
      bold: (text: string) => text,
      fg: (_color: string, text: string) => text,
    };
    const call = definition.renderCall({ id: "bash-id" }, theme, {});
    const collapsed = definition
      .renderResult(result, { expanded: false, isPartial: false }, theme, {
        isError: false,
      })
      .render(120)
      .join("\n");
    const expanded = definition
      .renderResult(result, { expanded: true, isPartial: false }, theme, {
        isError: false,
      })
      .render(120)
      .join("\n");

    expect(call.render(120).join("\n")).toContain("bash-id");
    expect(
      definition
        .renderResult(result, { expanded: false, isPartial: false }, theme, {
          isError: false,
        })
        .render(20)
        .every((line: string) => line.length <= 20),
    ).toBe(true);
    expect(collapsed.replaceAll("\\n", " ").replace(/\s+/g, " ")).toContain(
      "printf first second",
    );
    expect(collapsed.replace(/\s+/g, " ")).toContain("1 matches");
    expect(expanded).toContain("tool call ID: bash-id");
    expect(expanded).toContain("literal: second");
    expect(expanded).toContain("2 | second");
    expect(result.content).toEqual([
      {
        type: "text",
        text: expect.stringContaining("2 | second"),
      },
    ]);
    expect(
      definition
        .renderResult(
          {
            content: [{ type: "text", text: "context_recall: unavailable" }],
          },
          { expanded: false, isPartial: false },
          theme,
          { isError: true },
        )
        .render(120)
        .join("\n"),
    ).toContain("unavailable");
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
