import { describe, it, expect, vi } from "vitest";
import { estimateContextTokens, prepareCompaction } from "./compaction";

vi.mock("@earendil-works/pi-coding-agent", async () => {
  const actual = await vi.importActual<
    typeof import("@earendil-works/pi-coding-agent")
  >("@earendil-works/pi-coding-agent");
  return {
    ...actual,
    estimateTokens: vi.fn().mockImplementation((msg: { content?: string }) => {
      return msg.content?.length ?? 0;
    }),
  };
});

describe("estimateContextTokens", () => {
  it("estimates all tokens when no assistant usage exists", () => {
    const messages = [
      { role: "user", content: "aaa" },
      { role: "assistant", content: "bbbb", usage: undefined },
    ];
    const result = estimateContextTokens(messages as never);
    expect(result.tokens).toBe(7);
    expect(result.usageTokens).toBe(0);
    expect(result.trailingTokens).toBe(7);
    expect(result.lastUsageIndex).toBeNull();
  });

  it("uses assistant usage and adds trailing token estimates", () => {
    const messages = [
      { role: "user", content: "x" },
      {
        role: "assistant",
        content: "yy",
        usage: {
          totalTokens: 100,
          input: 40,
          output: 60,
          cacheRead: 0,
          cacheWrite: 0,
        },
      },
      { role: "user", content: "zzz" },
    ];
    const result = estimateContextTokens(messages as never);
    expect(result.tokens).toBe(103);
    expect(result.usageTokens).toBe(100);
    expect(result.trailingTokens).toBe(3);
    expect(result.lastUsageIndex).toBe(1);
  });

  it("skips aborted/error assistant messages when finding last usage", () => {
    const messages = [
      { role: "user", content: "x" },
      {
        role: "assistant",
        content: "yy",
        stopReason: "aborted",
        usage: {
          totalTokens: 100,
          input: 40,
          output: 60,
          cacheRead: 0,
          cacheWrite: 0,
        },
      },
      {
        role: "assistant",
        content: "zzz",
        stopReason: "error",
        usage: {
          totalTokens: 80,
          input: 30,
          output: 50,
          cacheRead: 0,
          cacheWrite: 0,
        },
      },
      {
        role: "assistant",
        content: "w",
        usage: {
          totalTokens: 50,
          input: 20,
          output: 30,
          cacheRead: 0,
          cacheWrite: 0,
        },
      },
      { role: "user", content: "uu" },
    ];
    const result = estimateContextTokens(messages as never);
    expect(result.tokens).toBe(52);
    expect(result.usageTokens).toBe(50);
    expect(result.trailingTokens).toBe(2);
    expect(result.lastUsageIndex).toBe(3);
  });

  it("falls back to estimateTokens when no valid assistant usage at all", () => {
    const messages = [
      { role: "user", content: "abcd" },
      {
        role: "assistant",
        content: "efg",
        stopReason: "aborted",
        usage: {
          totalTokens: 10,
          input: 5,
          output: 5,
          cacheRead: 0,
          cacheWrite: 0,
        },
      },
    ];
    const result = estimateContextTokens(messages as never);
    expect(result.tokens).toBe(7);
    expect(result.usageTokens).toBe(0);
    expect(result.trailingTokens).toBe(7);
    expect(result.lastUsageIndex).toBeNull();
  });

  it("uses most recent valid usage when multiple exist", () => {
    const messages = [
      { role: "user", content: "a" },
      {
        role: "assistant",
        content: "bb",
        usage: {
          totalTokens: 20,
          input: 10,
          output: 10,
          cacheRead: 0,
          cacheWrite: 0,
        },
      },
      { role: "user", content: "ccc" },
      {
        role: "assistant",
        content: "dddd",
        usage: {
          totalTokens: 40,
          input: 20,
          output: 20,
          cacheRead: 0,
          cacheWrite: 0,
        },
      },
      { role: "user", content: "eeeee" },
    ];
    const result = estimateContextTokens(messages as never);
    expect(result.tokens).toBe(45);
    expect(result.usageTokens).toBe(40);
    expect(result.trailingTokens).toBe(5);
    expect(result.lastUsageIndex).toBe(3);
  });
});

describe("prepareCompaction tokensBefore", () => {
  it("matches Pi usage-aware calculation for entries with assistant usage", () => {
    const entries = [
      {
        id: "e1",
        type: "message" as const,
        message: { role: "user", content: "x" } as never,
        timestamp: 1,
        parentId: null as string | null,
      },
      {
        id: "e2",
        type: "message" as const,
        message: {
          role: "assistant",
          content: "yy",
          usage: {
            totalTokens: 200,
            input: 80,
            output: 120,
            cacheRead: 0,
            cacheWrite: 0,
          },
        } as never,
        timestamp: 2,
        parentId: "e1",
      },
      {
        id: "e3",
        type: "message" as const,
        message: { role: "user", content: "zzz" } as never,
        timestamp: 3,
        parentId: "e2",
      },
    ];

    const preparation = prepareCompaction(entries as never, {
      enabled: true,
      reserveTokens: 16384,
      keepRecentTokens: 20000,
    });

    expect(preparation).toBeDefined();
    expect(preparation!.tokensBefore).toBe(203);
  });

  it("falls back to estimateTokens when no assistant usage is present", () => {
    const entries = [
      {
        id: "e1",
        type: "message" as const,
        message: { role: "user", content: "aaa" } as never,
        timestamp: 1,
        parentId: null as string | null,
      },
      {
        id: "e2",
        type: "message" as const,
        message: { role: "assistant", content: "bbbb" } as never,
        timestamp: 2,
        parentId: "e1",
      },
    ];

    const preparation = prepareCompaction(entries as never, {
      enabled: true,
      reserveTokens: 16384,
      keepRecentTokens: 20000,
    });

    expect(preparation).toBeDefined();
    expect(preparation!.tokensBefore).toBe(7);
  });
});
