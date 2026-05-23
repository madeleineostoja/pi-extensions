import { describe, it, expect } from "vitest";
import { createStatsStore, formatStats } from "./stats.ts";
import { formatTokenCount } from "./elision.ts";

describe("createStatsStore", () => {
  it("initial snapshot has all zeros", () => {
    const store = createStatsStore();
    expect(store.snapshot()).toEqual({
      tokensElidedCumulative: 0,
      elidedCountLatest: 0,
      recallCount: 0,
      byTool: [],
    });
  });

  it("accumulates tokensElidedCumulative across elision passes with distinct ids", () => {
    const store = createStatsStore();
    store.onElisionPass({
      entries: [{ toolCallId: "id-1", tokenCount: 100, toolName: "read" }],
    });
    store.onElisionPass({
      entries: [{ toolCallId: "id-2", tokenCount: 200, toolName: "read" }],
    });
    expect(store.snapshot().tokensElidedCumulative).toBe(300);
  });

  it("same toolCallId elided twice counts only once in tokensElidedCumulative", () => {
    const store = createStatsStore();
    store.onElisionPass({
      entries: [{ toolCallId: "id-1", tokenCount: 100, toolName: "read" }],
    });
    store.onElisionPass({
      entries: [{ toolCallId: "id-1", tokenCount: 100, toolName: "read" }],
    });
    expect(store.snapshot().tokensElidedCumulative).toBe(100);
  });

  it("two distinct ids across two passes sum to both sizes", () => {
    const store = createStatsStore();
    store.onElisionPass({
      entries: [{ toolCallId: "id-a", tokenCount: 400, toolName: "bash" }],
    });
    store.onElisionPass({
      entries: [{ toolCallId: "id-b", tokenCount: 600, toolName: "bash" }],
    });
    expect(store.snapshot().tokensElidedCumulative).toBe(1000);
  });

  it("elidedCountLatest reflects only the most recent pass, not cumulative", () => {
    const store = createStatsStore();
    store.onElisionPass({
      entries: [
        { toolCallId: "id-1", tokenCount: 500, toolName: "read" },
        { toolCallId: "id-2", tokenCount: 100, toolName: "read" },
        { toolCallId: "id-3", tokenCount: 200, toolName: "bash" },
      ],
    });
    store.onElisionPass({
      entries: [{ toolCallId: "id-4", tokenCount: 100, toolName: "bash" }],
    });
    expect(store.snapshot().elidedCountLatest).toBe(1);
  });

  it("elidedCountLatest updates on each pass", () => {
    const store = createStatsStore();
    store.onElisionPass({
      entries: [
        { toolCallId: "a", tokenCount: 10, toolName: "read" },
        { toolCallId: "b", tokenCount: 20, toolName: "read" },
        { toolCallId: "c", tokenCount: 30, toolName: "bash" },
        { toolCallId: "d", tokenCount: 40, toolName: "bash" },
        { toolCallId: "e", tokenCount: 50, toolName: "bash" },
      ],
    });
    expect(store.snapshot().elidedCountLatest).toBe(5);
    store.onElisionPass({
      entries: [
        { toolCallId: "f", tokenCount: 10, toolName: "read" },
        { toolCallId: "g", tokenCount: 20, toolName: "bash" },
      ],
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
        { toolCallId: "id-1", tokenCount: 2048, toolName: "read" },
        { toolCallId: "id-2", tokenCount: 100, toolName: "bash" },
        { toolCallId: "id-3", tokenCount: 200, toolName: "bash" },
        { toolCallId: "id-4", tokenCount: 300, toolName: "read" },
      ],
    });
    store.onRecall("read");
    store.reset();
    expect(store.snapshot()).toEqual({
      tokensElidedCumulative: 0,
      elidedCountLatest: 0,
      recallCount: 0,
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
    store.onElisionPass({
      entries: [{ toolCallId: "id-1", tokenCount: 512, toolName: "read" }],
    });
    expect(snap1.tokensElidedCumulative).toBe(0);
  });

  it("per-tool bytes accumulate correctly across multiple passes", () => {
    const store = createStatsStore();
    store.onElisionPass({
      entries: [
        { toolCallId: "r1", tokenCount: 10000, toolName: "read" },
        { toolCallId: "r2", tokenCount: 14000, toolName: "read" },
      ],
    });
    store.onElisionPass({
      entries: [{ toolCallId: "b1", tokenCount: 10000, toolName: "bash" }],
    });
    const snap = store.snapshot();
    const readTool = snap.byTool.find((t) => t.toolName === "read");
    const bashTool = snap.byTool.find((t) => t.toolName === "bash");
    expect(readTool?.tokens).toBe(24000);
    expect(readTool?.entries).toBe(2);
    expect(bashTool?.tokens).toBe(10000);
    expect(bashTool?.entries).toBe(1);
  });

  it("dedup-by-toolCallId carries over to per-tool counts", () => {
    const store = createStatsStore();
    store.onElisionPass({
      entries: [{ toolCallId: "r1", tokenCount: 5000, toolName: "read" }],
    });
    store.onElisionPass({
      entries: [{ toolCallId: "r1", tokenCount: 5000, toolName: "read" }],
    });
    const snap = store.snapshot();
    const readTool = snap.byTool.find((t) => t.toolName === "read");
    expect(readTool?.tokens).toBe(5000);
    expect(readTool?.entries).toBe(1);
  });

  it("per-tool recall counter increments only for the tool of the recalled result", () => {
    const store = createStatsStore();
    store.onElisionPass({
      entries: [
        { toolCallId: "r1", tokenCount: 1000, toolName: "read" },
        { toolCallId: "b1", tokenCount: 500, toolName: "bash" },
      ],
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
        { toolCallId: "b1", tokenCount: 10000, toolName: "bash" },
        { toolCallId: "r1", tokenCount: 24000, toolName: "read" },
        { toolCallId: "w1", tokenCount: 10000, toolName: "write" },
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
      byTool: [],
    });
    expect(output).toContain(formatTokenCount(4096));
    expect(output).toContain("3");
    expect(output).toContain("7");
    expect(output).toMatch(/tokens elided/i);
    expect(output).toMatch(/entries elided/i);
    expect(output).toMatch(/ctx_recall/i);
  });

  it("formats zeros correctly", () => {
    const output = formatStats({
      tokensElidedCumulative: 0,
      elidedCountLatest: 0,
      recallCount: 0,
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
      byTool: [],
    });
    expect(output.split("\n").length).toBe(3);
  });

  it("includes by tool section when there are elisions", () => {
    const output = formatStats({
      tokensElidedCumulative: 34000,
      elidedCountLatest: 15,
      recallCount: 1,
      byTool: [
        { toolName: "read", tokens: 24000, entries: 12, recalls: 1 },
        { toolName: "bash", tokens: 10000, entries: 3, recalls: 0 },
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
      byTool: [{ toolName: "read", tokens: 256, entries: 1, recalls: 1 }],
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
      byTool: [{ toolName: "bash", tokens: 3000, entries: 3, recalls: 2 }],
    });
    expect(output).toContain("3 entries");
    expect(output).toContain("2 recalls");
  });

  it("first three lines are preserved verbatim with elisions present", () => {
    const output = formatStats({
      tokensElidedCumulative: 34000,
      elidedCountLatest: 3,
      recallCount: 1,
      byTool: [{ toolName: "read", tokens: 34000, entries: 3, recalls: 1 }],
    });
    const lines = output.split("\n");
    expect(lines[0]).toBe(
      `tokens elided (cumulative): ${formatTokenCount(34000)}`,
    );
    expect(lines[1]).toBe("entries elided (latest pass): 3");
    expect(lines[2]).toBe("ctx_recall invocations: 1");
  });
});
