import { describe, it, expect } from "vitest";
import { makeContextHook } from "./elision.ts";
import { defaultConfig } from "./config.ts";
import { createPruningState } from "./policy.ts";

const BIG = 256 * 4 + 1;

function makeUserMsg(): any {
  return {
    role: "user",
    content: [{ type: "text", text: "hello" }],
    timestamp: Date.now(),
  };
}

function makeToolResult(
  toolCallId: string,
  text: string,
  isError = false,
): any {
  return {
    role: "toolResult",
    toolCallId,
    toolName: "read",
    content: [{ type: "text", text }],
    isError,
    timestamp: Date.now(),
  };
}

function makeMessages(turnsAfter: number, toolResult: any): any[] {
  const msgs: any[] = [makeUserMsg(), toolResult];
  for (let i = 1; i < turnsAfter; i++) {
    msgs.push(makeUserMsg());
  }
  return msgs;
}

describe("elision latching", () => {
  it("reuses latched elision on second pass with same messages", () => {
    const state = createPruningState();
    const hook = makeContextHook(defaultConfig(), undefined, state);
    const toolResult = makeToolResult("call-1", "x".repeat(BIG));
    const messages = makeMessages(5, toolResult);

    const r1 = hook({ type: "context", messages } as any, {} as any);
    const r2 = hook({ type: "context", messages } as any, {} as any);

    expect(r1).toEqual(r2);
    expect(state.latched.get("call-1")?.reason).toBe("standard-stale");
  });

  it("does not un-elide when policy becomes more permissive", () => {
    const state = createPruningState();
    const strictConfig = { ...defaultConfig(), staleTurns: 2, minTokens: 64 };
    const strictHook = makeContextHook(strictConfig, undefined, state);
    const toolResult = makeToolResult("call-2", "x".repeat(BIG));
    const messages = makeMessages(3, toolResult);

    const r1 = strictHook({ type: "context", messages } as any, {} as any);
    const m1 = r1.messages![1] as any;
    expect(m1.content[0].text).toMatch(/result elided:/);

    const permissiveConfig = {
      ...defaultConfig(),
      staleTurns: 10,
      minTokens: 2000,
    };
    const permissiveHook = makeContextHook(permissiveConfig, undefined, state);
    const r2 = permissiveHook({ type: "context", messages } as any, {} as any);

    const m2 = r2.messages![1] as any;
    expect(m2.content[0].text).toMatch(/result elided:/);
    expect(state.latched.get("call-2")?.reason).toBe("standard-stale");
  });

  it("latches duplicate-read reason and preserves it across passes", () => {
    const state = createPruningState();
    const config = {
      ...defaultConfig(),
      duplicateReadsEnabled: true,
      supersededReadsEnabled: false,
    };
    const hook = makeContextHook(config, undefined, state);

    const messages: any[] = [
      makeUserMsg(),
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "r1",
            name: "read",
            arguments: { path: "src/foo.ts" },
          },
        ],
        timestamp: Date.now(),
      },
      makeToolResult("r1", "first"),
      makeUserMsg(),
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "r2",
            name: "read",
            arguments: { path: "src/foo.ts" },
          },
        ],
        timestamp: Date.now(),
      },
      makeToolResult("r2", "second"),
    ];

    const r1 = hook(
      { type: "context", messages } as any,
      { cwd: "/cwd" } as any,
    );
    expect(state.latched.get("r1")?.reason).toBe("duplicate-read-young");

    const r2 = hook(
      { type: "context", messages } as any,
      { cwd: "/cwd" } as any,
    );
    expect(r1).toEqual(r2);
  });

  it("latches superseded-read reason and preserves it across passes", () => {
    const state = createPruningState();
    const config = {
      ...defaultConfig(),
      supersededReadsEnabled: true,
      duplicateReadsEnabled: false,
    };
    const hook = makeContextHook(config, undefined, state);

    const messages: any[] = [
      makeUserMsg(),
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "r1",
            name: "read",
            arguments: { path: "src/foo.ts" },
          },
        ],
        timestamp: Date.now(),
      },
      makeToolResult("r1", "content"),
      makeUserMsg(),
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "e1",
            name: "edit",
            arguments: { path: "src/foo.ts", old_string: "x", new_string: "y" },
          },
        ],
        timestamp: Date.now(),
      },
      {
        role: "toolResult",
        toolCallId: "e1",
        toolName: "edit",
        content: [{ type: "text", text: "ok" }],
        isError: false,
        timestamp: Date.now(),
      },
    ];

    const r1 = hook(
      { type: "context", messages } as any,
      { cwd: "/cwd" } as any,
    );
    expect(state.latched.get("r1")?.reason).toBe("superseded-read-young");

    const r2 = hook(
      { type: "context", messages } as any,
      { cwd: "/cwd" } as any,
    );
    expect(r1).toEqual(r2);
  });

  it("is deterministic for identical input plus state", () => {
    const state = createPruningState();
    const hook = makeContextHook(defaultConfig(), undefined, state);
    const toolResult = makeToolResult("call-3", "x".repeat(BIG));
    const messages = makeMessages(5, toolResult);

    const r1 = hook({ type: "context", messages } as any, {} as any);
    const r2 = hook({ type: "context", messages } as any, {} as any);
    expect(r1.messages).toEqual(r2.messages);
    expect(r1).toEqual(r2);
  });

  it("still allows new elisions for unseen toolCallIds on a stricter pass", () => {
    const state = createPruningState();
    const config = { ...defaultConfig(), staleTurns: 2, minTokens: 64 };
    const hook = makeContextHook(config, undefined, state);

    const messages: any[] = [
      makeUserMsg(),
      makeToolResult("call-a", "x".repeat(BIG)),
      makeUserMsg(),
      makeUserMsg(),
      makeUserMsg(),
      makeToolResult("call-b", "x".repeat(BIG)),
      makeUserMsg(),
      makeUserMsg(),
    ];

    const r1 = hook({ type: "context", messages } as any, {} as any);
    expect(state.latched.has("call-a")).toBe(true);
    expect(state.latched.has("call-b")).toBe(true);

    const r2 = hook({ type: "context", messages } as any, {} as any);
    expect(r1).toEqual(r2);
  });
});

describe("ElisionPassEntry fields", () => {
  it("includes reason, savedTokens, stubTokens, and suffixTokens", () => {
    const passes: any[] = [];
    const hook = makeContextHook(defaultConfig(), (result) =>
      passes.push(result),
    );
    const toolResult = makeToolResult("call-1", "x".repeat(BIG));
    const messages = makeMessages(5, toolResult);

    hook({ type: "context", messages } as any, {} as any);
    expect(passes).toHaveLength(1);
    const entry = passes[0].entries[0];
    expect(entry.reason).toBe("standard-stale");
    expect(typeof entry.savedTokens).toBe("number");
    expect(typeof entry.stubTokens).toBe("number");
    expect(typeof entry.suffixTokens).toBe("number");
    expect(entry.savedTokens).toBeGreaterThan(0);
    expect(entry.stubTokens).toBeGreaterThan(0);
  });

  it("never reports negative savedTokens even when stub is larger than original", () => {
    const passes: any[] = [];
    const hook = makeContextHook(
      {
        ...defaultConfig(),
        duplicateReadsEnabled: true,
        supersededReadsEnabled: false,
      },
      (result) => passes.push(result),
    );

    const messages: any[] = [
      makeUserMsg(),
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "r1",
            name: "read",
            arguments: { path: "src/foo.ts" },
          },
        ],
        timestamp: Date.now(),
      },
      makeToolResult("r1", "x"),
      makeUserMsg(),
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "r2",
            name: "read",
            arguments: { path: "src/foo.ts" },
          },
        ],
        timestamp: Date.now(),
      },
      makeToolResult("r2", "y"),
    ];

    hook({ type: "context", messages } as any, { cwd: "/cwd" } as any);
    expect(passes).toHaveLength(1);
    const entry = passes[0].entries[0];
    expect(entry.savedTokens).toBeGreaterThanOrEqual(0);
  });
});
