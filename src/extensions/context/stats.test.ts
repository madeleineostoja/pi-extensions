import { describe, it, expect } from "vitest";
import { createStatsStore, formatStats } from "./stats.ts";
import { formatTokenCount } from "./elision.ts";

function entry(
  toolCallId: string,
  tokenCount: number,
  toolName: string,
  savedTokens = tokenCount - 10,
): import("./stats.ts").ElisionPassEntry {
  return {
    toolCallId,
    tokenCount,
    toolName,
    reason: "standard-stale",
    savedTokens,
    stubTokens: tokenCount - savedTokens,
    suffixTokens: 5,
  };
}

describe("createStatsStore", () => {
  it("initial snapshot has all zeros", () => {
    const store = createStatsStore();
    expect(store.snapshot()).toEqual({
      tokensElidedCumulative: 0,
      elidedCountLatest: 0,
      recallCount: 0,
      byReason: [],
      byTool: [],
    });
  });

  it("accumulates tokensElidedCumulative across elision passes with distinct ids", () => {
    const store = createStatsStore();
    store.onElisionPass({ entries: [entry("id-1", 100, "read")] });
    store.onElisionPass({ entries: [entry("id-2", 200, "read")] });
    expect(store.snapshot().tokensElidedCumulative).toBe(280);
  });

  it("same toolCallId elided twice counts only once in tokensElidedCumulative", () => {
    const store = createStatsStore();
    store.onElisionPass({ entries: [entry("id-1", 100, "read")] });
    store.onElisionPass({ entries: [entry("id-1", 100, "read")] });
    expect(store.snapshot().tokensElidedCumulative).toBe(90);
  });

  it("two distinct ids across two passes sum to both sizes", () => {
    const store = createStatsStore();
    store.onElisionPass({ entries: [entry("id-a", 400, "bash")] });
    store.onElisionPass({ entries: [entry("id-b", 600, "bash")] });
    expect(store.snapshot().tokensElidedCumulative).toBe(980);
  });

  it("elidedCountLatest reflects only the most recent pass, not cumulative", () => {
    const store = createStatsStore();
    store.onElisionPass({
      entries: [
        entry("id-1", 500, "read"),
        entry("id-2", 100, "read"),
        entry("id-3", 200, "bash"),
      ],
    });
    store.onElisionPass({ entries: [entry("id-4", 100, "bash")] });
    expect(store.snapshot().elidedCountLatest).toBe(1);
  });

  it("elidedCountLatest updates on each pass", () => {
    const store = createStatsStore();
    store.onElisionPass({
      entries: [
        entry("a", 10, "read"),
        entry("b", 20, "read"),
        entry("c", 30, "bash"),
        entry("d", 40, "bash"),
        entry("e", 50, "bash"),
      ],
    });
    expect(store.snapshot().elidedCountLatest).toBe(5);
    store.onElisionPass({
      entries: [entry("f", 10, "read"), entry("g", 20, "bash")],
    });
    expect(store.snapshot().elidedCountLatest).toBe(2);
  });

  it("increments recallCount by one per onRecall call", () => {
    const store = createStatsStore();
    store.onRecall("read");
    store.onRecall("read");
    store.onRecall("bash");
    expect(store.snapshot().recallCount).toBe(3);
  });

  it("reset returns all counters to zero", () => {
    const store = createStatsStore();
    store.onElisionPass({
      entries: [
        entry("id-1", 2048, "read"),
        entry("id-2", 100, "bash"),
        entry("id-3", 200, "bash"),
        entry("id-4", 300, "read"),
      ],
    });
    store.onRecall("read");
    store.reset();
    expect(store.snapshot()).toEqual({
      tokensElidedCumulative: 0,
      elidedCountLatest: 0,
      recallCount: 0,
      byReason: [],
      byTool: [],
    });
  });

  it("tokensElidedCumulative is unaffected by elision passes with zero entries", () => {
    const store = createStatsStore();
    store.onElisionPass({ entries: [] });
    expect(store.snapshot().tokensElidedCumulative).toBe(0);
  });

  it("snapshot is a value copy that does not change when store mutates", () => {
    const store = createStatsStore();
    const snap1 = store.snapshot();
    store.onElisionPass({ entries: [entry("id-1", 512, "read")] });
    expect(snap1.tokensElidedCumulative).toBe(0);
  });

  it("per-tool bytes accumulate correctly across multiple passes", () => {
    const store = createStatsStore();
    store.onElisionPass({
      entries: [entry("r1", 10000, "read"), entry("r2", 14000, "read")],
    });
    store.onElisionPass({ entries: [entry("b1", 10000, "bash")] });
    const snap = store.snapshot();
    const readTool = snap.byTool.find((t) => t.toolName === "read");
    const bashTool = snap.byTool.find((t) => t.toolName === "bash");
    expect(readTool?.tokens).toBe(23980);
    expect(readTool?.entries).toBe(2);
    expect(bashTool?.tokens).toBe(9990);
    expect(bashTool?.entries).toBe(1);
  });

  it("dedup-by-toolCallId carries over to per-tool counts", () => {
    const store = createStatsStore();
    store.onElisionPass({ entries: [entry("r1", 5000, "read")] });
    store.onElisionPass({ entries: [entry("r1", 5000, "read")] });
    const snap = store.snapshot();
    const readTool = snap.byTool.find((t) => t.toolName === "read");
    expect(readTool?.tokens).toBe(4990);
    expect(readTool?.entries).toBe(1);
  });

  it("per-tool recall counter increments only for the tool of the recalled result", () => {
    const store = createStatsStore();
    store.onElisionPass({
      entries: [entry("r1", 1000, "read"), entry("b1", 500, "bash")],
    });
    store.onRecall("read");
    const snap = store.snapshot();
    const readTool = snap.byTool.find((t) => t.toolName === "read");
    const bashTool = snap.byTool.find((t) => t.toolName === "bash");
    expect(readTool?.recalls).toBe(1);
    expect(bashTool?.recalls).toBe(0);
  });

  it("sort order is descending by bytes, ties broken alphabetically", () => {
    const store = createStatsStore();
    store.onElisionPass({
      entries: [
        entry("b1", 10000, "bash"),
        entry("r1", 24000, "read"),
        entry("w1", 10000, "write"),
      ],
    });
    const snap = store.snapshot();
    expect(snap.byTool[0].toolName).toBe("read");
    expect(snap.byTool[1].toolName).toBe("bash");
    expect(snap.byTool[2].toolName).toBe("write");
  });
});

describe("formatStats", () => {
  it("contains all three labels and expected numbers", () => {
    const output = formatStats({
      tokensElidedCumulative: 4096,
      elidedCountLatest: 3,
      recallCount: 7,
      byReason: [],
      byTool: [],
    });
    expect(output).toContain(formatTokenCount(4096));
    expect(output).toContain("3");
    expect(output).toContain("7");
    expect(output).toMatch(/tokens elided/i);
    expect(output).toMatch(/entries elided/i);
    expect(output).toMatch(/context_recall/i);
  });

  it("formats zeros correctly", () => {
    const output = formatStats({
      tokensElidedCumulative: 0,
      elidedCountLatest: 0,
      recallCount: 0,
      byReason: [],
      byTool: [],
    });
    expect(output).toContain("0 tokens");
    expect(output.split("\n").length).toBe(3);
  });

  it("output has three lines when no elisions", () => {
    const output = formatStats({
      tokensElidedCumulative: 1000,
      elidedCountLatest: 2,
      recallCount: 5,
      byReason: [],
      byTool: [],
    });
    expect(output.split("\n").length).toBe(3);
  });

  it("includes by tool section when there are elisions", () => {
    const output = formatStats({
      tokensElidedCumulative: 34000,
      elidedCountLatest: 15,
      recallCount: 1,
      byReason: [],
      byTool: [
        { toolName: "read", tokens: 23980, entries: 12, recalls: 1 },
        { toolName: "bash", tokens: 9990, entries: 3, recalls: 0 },
      ],
    });
    expect(output).toContain("by tool:");
    expect(output).toContain("read");
    expect(output).toContain("bash");
    expect(output).toContain("12 entries");
    expect(output).toContain("1 recall");
    expect(output).toContain("3 entries");
    expect(output).toContain("0 recalls");
  });

  it("omits by tool section when byTool is empty", () => {
    const output = formatStats({
      tokensElidedCumulative: 0,
      elidedCountLatest: 0,
      recallCount: 0,
      byReason: [],
      byTool: [],
    });
    expect(output).not.toContain("by tool:");
    expect(output.split("\n").length).toBe(3);
  });

  it("uses singular entry for count of 1", () => {
    const output = formatStats({
      tokensElidedCumulative: 256,
      elidedCountLatest: 1,
      recallCount: 1,
      byReason: [
        { reason: "standard-stale", tokens: 246, entries: 1, recalls: 1 },
      ],
      byTool: [{ toolName: "read", tokens: 246, entries: 1, recalls: 1 }],
    });
    expect(output).toContain("1 entry");
    expect(output).not.toContain("1 entries");
    expect(output).toContain("1 recall");
    expect(output).not.toContain("1 recalls");
  });

  it("uses plural entries and recalls for counts other than 1", () => {
    const output = formatStats({
      tokensElidedCumulative: 3000,
      elidedCountLatest: 3,
      recallCount: 2,
      byReason: [
        { reason: "batch-pressure", tokens: 2970, entries: 3, recalls: 2 },
      ],
      byTool: [{ toolName: "bash", tokens: 2970, entries: 3, recalls: 2 }],
    });
    expect(output).toContain("3 entries");
    expect(output).toContain("2 recalls");
  });

  it("first three lines are preserved verbatim with elisions present", () => {
    const output = formatStats({
      tokensElidedCumulative: 34000,
      elidedCountLatest: 3,
      recallCount: 1,
      byReason: [
        { reason: "standard-stale", tokens: 33970, entries: 3, recalls: 1 },
      ],
      byTool: [{ toolName: "read", tokens: 33970, entries: 3, recalls: 1 }],
    });
    const lines = output.split("\n");
    expect(lines[0]).toBe(
      `tokens elided (cumulative): ${formatTokenCount(34000)}`,
    );
    expect(lines[1]).toBe("entries elided (latest pass): 3");
    expect(lines[2]).toBe("context_recall invocations: 1");
  });
});
