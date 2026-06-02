import { describe, it, expect } from "vitest";
import { parseLineRange, registerRecallTool } from "./recall.ts";
import { createPruningState, recordElision } from "./policy.ts";

function makeSessionEntry(toolCallId: string, text: string) {
  return {
    type: "message" as const,
    id: `entry-${toolCallId}`,
    parentId: null,
    timestamp: new Date().toISOString(),
    message: {
      role: "toolResult",
      toolCallId,
      toolName: "Read",
      content: [{ type: "text", text }],
      isError: false,
      timestamp: Date.now(),
    },
  };
}

function makeMultiBlockEntry(toolCallId: string, texts: string[]) {
  return {
    type: "message" as const,
    id: `entry-${toolCallId}`,
    parentId: null,
    timestamp: new Date().toISOString(),
    message: {
      role: "toolResult",
      toolCallId,
      toolName: "Read",
      content: texts.map((t) => ({ type: "text" as const, text: t })),
      isError: false,
      timestamp: Date.now(),
    },
  };
}

function makeImageEntry(toolCallId: string) {
  return {
    type: "message" as const,
    id: `entry-${toolCallId}`,
    parentId: null,
    timestamp: new Date().toISOString(),
    message: {
      role: "toolResult",
      toolCallId,
      toolName: "Read",
      content: [{ type: "image", source: { type: "base64", data: "abc" } }],
      isError: false,
      timestamp: Date.now(),
    },
  };
}

function makeCompactionEntry() {
  return {
    type: "compaction" as const,
    id: "compaction-entry-1",
    parentId: null,
    timestamp: new Date().toISOString(),
    summary: "Compacted session summary.",
    firstKeptEntryId: "some-entry",
    tokensBefore: 10000,
  };
}

function makeBranchSummaryEntry() {
  return {
    type: "branch_summary" as const,
    id: "branch-summary-entry-1",
    parentId: null,
    timestamp: new Date().toISOString(),
    fromId: "some-entry",
    summary: "Branch summary text.",
  };
}

async function executeRecall(
  entries: ReturnType<typeof makeSessionEntry>[],
  params: { id: string; lines?: string },
) {
  const { registerRecallTool } = await import("./recall.ts");

  let capturedExecute:
    | ((
        toolCallId: string,
        params: any,
        signal: any,
        onUpdate: any,
        ctx: any,
      ) => Promise<any>)
    | null = null;

  const fakePI = {
    registerTool(def: any) {
      capturedExecute = def.execute;
    },
  };

  registerRecallTool(fakePI as any);

  const ctx = {
    sessionManager: {
      getEntries: () => entries,
    },
  };

  return capturedExecute!("recall-call-id", params, undefined, undefined, ctx);
}

describe("context_recall execute", () => {
  it("returns original content for a known id", async () => {
    const entries = [makeSessionEntry("call-abc", "hello world content")];
    const result = await executeRecall(entries as any, { id: "call-abc" });
    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual([
      { type: "text", text: "hello world content" },
    ]);
  });

  it("returns isError true with message for unknown id", async () => {
    const entries = [makeSessionEntry("call-abc", "content")];
    const result = await executeRecall(entries as any, {
      id: "does_not_exist",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(
      /context_recall: no tool result with id=does_not_exist/,
    );
  });

  it("slices lines 10-20 from single text block", async () => {
    const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
    const entries = [makeSessionEntry("call-lines", lines.join("\n"))];
    const result = await executeRecall(entries as any, {
      id: "call-lines",
      lines: "10-20",
    });
    expect(result.isError).toBeFalsy();
    const returned = result.content[0].text.split("\n");
    expect(returned[0]).toBe("line 10");
    expect(returned[returned.length - 1]).toBe("line 20");
    expect(returned.length).toBe(11);
  });

  it("slices single line using '5' format", async () => {
    const lines = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`);
    const entries = [makeSessionEntry("call-single-line", lines.join("\n"))];
    const result = await executeRecall(entries as any, {
      id: "call-single-line",
      lines: "5",
    });
    expect(result.content[0].text).toBe("line 5");
  });

  it("returns empty string for out-of-range lines", async () => {
    const lines = Array.from({ length: 5 }, (_, i) => `line ${i + 1}`);
    const entries = [makeSessionEntry("call-oor", lines.join("\n"))];
    const result = await executeRecall(entries as any, {
      id: "call-oor",
      lines: "9999-10000",
    });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toBe("");
  });

  it("returns isError true when lines is provided against multiple text blocks", async () => {
    const entries = [
      makeMultiBlockEntry("call-multi", ["block one", "block two"]),
    ];
    const result = await executeRecall(entries as any, {
      id: "call-multi",
      lines: "1-1",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/multiple text blocks/i);
  });

  it("returns isError true when lines is provided against image-bearing content", async () => {
    const entries = [makeImageEntry("call-img")];
    const result = await executeRecall(entries as any, {
      id: "call-img",
      lines: "1",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/non-text|image/i);
  });

  it("returns full content when no lines param", async () => {
    const text = "full content here";
    const entries = [makeSessionEntry("call-full", text)];
    const result = await executeRecall(entries as any, { id: "call-full" });
    expect(result.content[0].text).toBe(text);
  });

  it("returns isError true for invalid lines argument", async () => {
    const entries = [makeSessionEntry("call-abc", "some content")];
    const result = await executeRecall(entries as any, {
      id: "call-abc",
      lines: "abc",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/abc/);
  });

  it("returns compaction error when compactionSummary entry exists and id is not found", async () => {
    const entries = [
      makeCompactionEntry(),
      makeSessionEntry("other-id", "other content"),
    ];
    const result = await executeRecall(entries as any, { id: "missing-id" });
    expect(result.isError).toBe(true);
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("text");
    expect(result.content[0].text).toMatch(/compacted away/);
    expect(result.content[0].text).toMatch(/cannot be recovered/);
  });

  it("returns no-tool-result error when no compactionSummary entry exists and id is not found", async () => {
    const entries = [makeSessionEntry("other-id", "other content")];
    const result = await executeRecall(entries as any, { id: "missing-id" });
    expect(result.isError).toBe(true);
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("text");
    expect(result.content[0].text).toMatch(/no tool result with id=missing-id/);
  });

  it("returns result normally when both compactionSummary and a matching toolResult exist", async () => {
    const entries = [
      makeCompactionEntry(),
      makeSessionEntry("call-exists", "found content"),
    ];
    const result = await executeRecall(entries as any, { id: "call-exists" });
    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual([{ type: "text", text: "found content" }]);
  });

  it("finds target toolResult in a mixed-entry list with non-message entries adjacent to it", async () => {
    const entries = [
      makeBranchSummaryEntry(),
      makeCompactionEntry(),
      makeSessionEntry("call-mixed", "target content"),
      makeBranchSummaryEntry(),
    ];
    const result = await executeRecall(entries as any, { id: "call-mixed" });
    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual([{ type: "text", text: "target content" }]);
  });
});

describe("registerRecallTool recall attribution", () => {
  it("updates pruningState recall counters when reason is latched", async () => {
    const pruningState = createPruningState();
    recordElision(pruningState, {
      toolCallId: "call-abc",
      reason: "superseded-read-young",
      toolName: "read",
      originalTokens: 100,
    });

    const entries = [makeSessionEntry("call-abc", "original content")];

    let capturedDef: any = null;
    const fakePI = {
      registerTool(def: any) {
        capturedDef = def;
      },
    };

    registerRecallTool(fakePI as any, () => {}, pruningState);

    const result = await capturedDef.execute(
      "recall-id",
      { id: "call-abc" },
      undefined,
      undefined,
      {
        sessionManager: {
          getEntries: () => entries,
        },
      },
    );

    expect(result.isError).toBeFalsy();
    expect(pruningState.recallCountByReason.get("superseded-read-young")).toBe(
      1,
    );
  });

  it("does not double-count recalls for the same toolCallId", async () => {
    const pruningState = createPruningState();
    recordElision(pruningState, {
      toolCallId: "call-abc",
      reason: "duplicate-read-young",
      toolName: "read",
      originalTokens: 100,
    });

    const entries = [makeSessionEntry("call-abc", "original content")];

    let capturedDef: any = null;
    const fakePI = {
      registerTool(def: any) {
        capturedDef = def;
      },
    };

    registerRecallTool(fakePI as any, () => {}, pruningState);

    const ctx = {
      sessionManager: {
        getEntries: () => entries,
      },
    };

    await capturedDef.execute(
      "recall-id",
      { id: "call-abc" },
      undefined,
      undefined,
      ctx,
    );
    await capturedDef.execute(
      "recall-id",
      { id: "call-abc" },
      undefined,
      undefined,
      ctx,
    );

    expect(pruningState.recallCountByReason.get("duplicate-read-young")).toBe(
      1,
    );
  });
});

describe("registerRecallTool registration metadata", () => {
  function captureRegistration() {
    let captured: any = null;
    const fakePI = {
      registerTool(def: any) {
        captured = def;
      },
    };
    registerRecallTool(fakePI as any);
    return captured;
  }

  it("provides a non-empty promptSnippet", () => {
    const def = captureRegistration();
    expect(typeof def.promptSnippet).toBe("string");
    expect(def.promptSnippet.length).toBeGreaterThan(0);
  });

  it("provides a promptGuidelines array with at least three bullets", () => {
    const def = captureRegistration();
    expect(Array.isArray(def.promptGuidelines)).toBe(true);
    expect(def.promptGuidelines.length).toBeGreaterThanOrEqual(3);
  });

  it("every promptGuidelines bullet contains 'context_recall'", () => {
    const def = captureRegistration();
    for (const bullet of def.promptGuidelines as string[]) {
      expect(bullet).toContain("context_recall");
    }
  });
});

describe("parseLineRange", () => {
  it("returns null for empty string", () => {
    expect(parseLineRange("")).toBeNull();
  });

  it("returns null for non-numeric input", () => {
    expect(parseLineRange("abc")).toBeNull();
  });

  it("returns null for trailing garbage on single number", () => {
    expect(parseLineRange("5abc")).toBeNull();
  });

  it("returns null for trailing garbage on range", () => {
    expect(parseLineRange("10-20x")).toBeNull();
  });

  it("returns null for missing end endpoint", () => {
    expect(parseLineRange("5-")).toBeNull();
  });

  it("returns null for missing start endpoint", () => {
    expect(parseLineRange("-5")).toBeNull();
  });

  it("returns null for bare separator", () => {
    expect(parseLineRange("-")).toBeNull();
  });

  it("returns null for multi-separator form", () => {
    expect(parseLineRange("1-2-3")).toBeNull();
  });

  it("returns null for zero", () => {
    expect(parseLineRange("0")).toBeNull();
  });

  it("returns null for negative number", () => {
    expect(parseLineRange("-1")).toBeNull();
  });

  it("returns null when end is less than start", () => {
    expect(parseLineRange("10-5")).toBeNull();
  });

  it("returns correct range for single line", () => {
    expect(parseLineRange("5")).toEqual({ start: 5, end: 5 });
  });

  it("returns correct range for line range", () => {
    expect(parseLineRange("10-20")).toEqual({ start: 10, end: 20 });
  });
});
