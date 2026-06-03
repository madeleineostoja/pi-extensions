import { describe, it, expect } from "vitest";
import {
  isEligibleForElision,
  formatStub,
  formatSupersededStub,
  formatDuplicateStub,
  formatAfterConsumptionBashStub,
  formatBatchPressureStub,
  formatEmergencyPressureStub,
  extractPreview,
  estimateContentTokens,
  userTurnsAfterEachPosition,
  estimateSuffixTokens,
  makeContextHook,
} from "./elision.ts";
import { defaultConfig, DEFAULTS } from "./config.ts";
import { createPruningState } from "./policy.ts";

// Helpers so tests stay robust to threshold changes in DEFAULTS.
// BIG: a char count guaranteed to produce tokenCount > DEFAULTS.minTokens
// HUGE: a char count large enough to pass bounded policy min-savings guards
// SMALL: a char count guaranteed to produce tokenCount < DEFAULTS.minTokens
const BIG = DEFAULTS.minTokens * 4 + 1;
const HUGE = 12_000;
const SMALL = (DEFAULTS.minTokens - 1) * 4;

describe("isEligibleForElision", () => {
  it("returns true when both thresholds are met exactly", () => {
    expect(isEligibleForElision(DEFAULTS.staleTurns, DEFAULTS.minTokens)).toBe(
      true,
    );
  });

  it("returns true when both thresholds are exceeded", () => {
    expect(
      isEligibleForElision(DEFAULTS.staleTurns + 2, DEFAULTS.minTokens + 50),
    ).toBe(true);
  });

  it("returns false when turn distance is below threshold", () => {
    expect(
      isEligibleForElision(DEFAULTS.staleTurns - 1, DEFAULTS.minTokens + 50),
    ).toBe(false);
  });

  it("returns false when token count is below threshold", () => {
    expect(
      isEligibleForElision(DEFAULTS.staleTurns + 1, DEFAULTS.minTokens - 1),
    ).toBe(false);
  });

  it("returns false when both are below threshold", () => {
    expect(isEligibleForElision(0, 0)).toBe(false);
  });

  it("returns false when turn distance is zero", () => {
    expect(isEligibleForElision(0, DEFAULTS.minTokens * 2)).toBe(false);
  });

  it("returns false when token count is zero", () => {
    expect(isEligibleForElision(DEFAULTS.staleTurns * 2, 0)).toBe(false);
  });
});

describe("formatStub", () => {
  it("preserves the recall contract with optional preview text", () => {
    const withPreview = formatStub({
      toolName: "read",
      tokenCount: 300,
      toolCallId: "id-prev",
      preview: "hello world",
    });
    const withoutPreview = formatStub({
      toolName: "bash",
      tokenCount: 1000,
      toolCallId: "xyz-789",
    });

    expect(withPreview).toBe(
      '[read result elided: 300 tokens. Preview: "hello world". Call context_recall("id-prev") to retrieve.]',
    );
    expect(withoutPreview).toContain(
      'Call context_recall("xyz-789") to retrieve.',
    );
    expect(withoutPreview).not.toContain("Preview:");
  });
});

describe("extractPreview", () => {
  it("returns null when there is no text content", () => {
    expect(extractPreview([])).toBeNull();
    expect(
      extractPreview([
        { type: "image" } as unknown as {
          type: "image";
          data: string;
          mimeType: string;
        },
      ]),
    ).toBeNull();
  });

  it("joins text blocks and truncates long previews", () => {
    expect(
      extractPreview([
        { type: "text" as const, text: "foo" },
        { type: "text" as const, text: "bar" },
      ]),
    ).toBe("foo\\nbar");

    const text = "a".repeat(101);
    expect(extractPreview([{ type: "text" as const, text }])).toBe(
      "a".repeat(100) + "…",
    );
  });

  it("escapes special characters used inside stub quotes", () => {
    expect(
      extractPreview([
        { type: "text" as const, text: 'line1\nline2\t"q"\\path' },
      ]),
    ).toBe('line1\\nline2\\t\\"q\\"\\\\path');
  });
});

describe("estimateContentTokens", () => {
  it("counts only text blocks", () => {
    expect(estimateContentTokens([])).toBe(0);
    expect(
      estimateContentTokens([
        { type: "text" as const, text: "hello" },
        { type: "image" } as unknown as {
          type: "image";
          data: string;
          mimeType: string;
        },
        { type: "text" as const, text: " world" },
      ]),
    ).toBe(Math.ceil(11 / 4));
  });

  it("returns a value large enough to exceed minTokens when content is large", () => {
    const text = "x".repeat(DEFAULTS.minTokens * 4 + 4);
    expect(
      estimateContentTokens([{ type: "text" as const, text }]),
    ).toBeGreaterThan(DEFAULTS.minTokens);
  });
});

describe("userTurnsAfterEachPosition", () => {
  it("returns all zeros for empty messages", () => {
    expect(userTurnsAfterEachPosition([])).toEqual([]);
  });

  it("returns zero for single user message", () => {
    const msgs = [{ role: "user" }] as any[];
    expect(userTurnsAfterEachPosition(msgs)).toEqual([0]);
  });

  it("computes correct distances for mixed messages", () => {
    const msgs = [
      { role: "user" },
      { role: "assistant" },
      { role: "toolResult" },
      { role: "user" },
      { role: "assistant" },
    ] as any[];
    const distances = userTurnsAfterEachPosition(msgs);
    expect(distances[0]).toBe(1);
    expect(distances[1]).toBe(1);
    expect(distances[2]).toBe(1);
    expect(distances[3]).toBe(0);
    expect(distances[4]).toBe(0);
  });

  it("distance counts user messages AFTER each position", () => {
    const msgs = [
      { role: "toolResult" },
      { role: "user" },
      { role: "toolResult" },
      { role: "user" },
      { role: "toolResult" },
    ] as any[];
    const distances = userTurnsAfterEachPosition(msgs);
    expect(distances[0]).toBe(2);
    expect(distances[1]).toBe(1);
    expect(distances[2]).toBe(1);
    expect(distances[3]).toBe(0);
    expect(distances[4]).toBe(0);
  });
});

function makeToolResult(opts: {
  toolCallId: string;
  toolName: string;
  text: string;
  repeat?: number;
  isError?: boolean;
}): object {
  const text = opts.repeat ? opts.text.repeat(opts.repeat) : opts.text;
  return {
    role: "toolResult",
    toolCallId: opts.toolCallId,
    toolName: opts.toolName,
    content: [{ type: "text", text }],
    isError: opts.isError ?? false,
    timestamp: Date.now(),
  };
}

function makeUserMsg(): object {
  return {
    role: "user",
    content: [{ type: "text", text: "hello" }],
    timestamp: Date.now(),
  };
}

function makeMessages(numUserTurns: number, toolResult: object): any[] {
  const msgs: any[] = [];
  msgs.push(makeUserMsg());
  msgs.push(toolResult);
  for (let i = 1; i < numUserTurns; i++) {
    msgs.push(makeUserMsg());
  }
  return msgs;
}

describe("context hook", () => {
  const hook = makeContextHook(defaultConfig());
  const fakeCtx = {} as any;

  it("elides a large, old non-source tool result", () => {
    const toolResult = makeToolResult({
      toolCallId: "call-abc",
      toolName: "bash",
      text: "x",
      repeat: HUGE,
    });
    const messages = makeMessages(DEFAULTS.staleTurns + 1, toolResult);
    const result = hook({ type: "context", messages } as any, fakeCtx);
    const elided = result.messages!.find(
      (m: any) => m.role === "toolResult",
    ) as any;
    expect(elided.content[0].text).toMatch(/^\[bash result elided:/);
    expect(elided.content[0].text).toMatch(
      /Call context_recall\("call-abc"\) to retrieve\.\]$/,
    );
  });

  it("does not elide a tool result that is too small", () => {
    const toolResult = makeToolResult({
      toolCallId: "call-small",
      toolName: "read",
      text: "x",
      repeat: SMALL,
    });
    const messages = makeMessages(DEFAULTS.staleTurns + 1, toolResult);
    const result = hook({ type: "context", messages } as any, fakeCtx);
    const found = result.messages!.find(
      (m: any) => m.role === "toolResult",
    ) as any;
    expect(found.content[0].text).toBe("x".repeat(SMALL));
  });

  it("does not elide a tool result that is too young", () => {
    const toolResult = makeToolResult({
      toolCallId: "call-young",
      toolName: "read",
      text: "x",
      repeat: HUGE,
    });
    const messages = makeMessages(DEFAULTS.staleTurns - 1, toolResult);
    const result = hook({ type: "context", messages } as any, fakeCtx);
    const found = result.messages!.find(
      (m: any) => m.role === "toolResult",
    ) as any;
    expect(found.content[0].text).toBe("x".repeat(HUGE));
  });

  it("does not elide a tool result with isError: true even when large and old", () => {
    const toolResult = makeToolResult({
      toolCallId: "call-err",
      toolName: "bash",
      text: "x",
      repeat: HUGE,
      isError: true,
    });
    const messages = makeMessages(DEFAULTS.staleTurns + 5, toolResult);
    const result = hook({ type: "context", messages } as any, fakeCtx);
    const found = result.messages!.find(
      (m: any) => m.role === "toolResult",
    ) as any;
    expect(found.content[0].text).toBe("x".repeat(HUGE));
  });

  it("does not elide a tool result whose only large content is an image block", () => {
    const hugeImageData = "A".repeat(1_000_000);
    const toolResult: any = {
      role: "toolResult",
      toolCallId: "call-image-only",
      toolName: "read",
      content: [
        { type: "text", text: "tiny" },
        { type: "image", source: { type: "base64", data: hugeImageData } },
      ],
      isError: false,
      timestamp: Date.now(),
    };
    const messages = makeMessages(DEFAULTS.staleTurns + 1, toolResult);
    const result = hook({ type: "context", messages } as any, fakeCtx);
    const found = result.messages!.find(
      (m: any) => m.role === "toolResult",
    ) as any;
    expect(found.content[0].text).toBe("tiny");
    expect(found.content[1].type).toBe("image");
  });

  it("uses 'unknown' toolName when toolName is missing", () => {
    const toolResult: any = {
      role: "toolResult",
      toolCallId: "call-no-name",
      toolName: undefined,
      content: [{ type: "text", text: "x".repeat(HUGE) }],
      isError: false,
      timestamp: Date.now(),
    };
    const messages = makeMessages(DEFAULTS.staleTurns + 1, toolResult);
    const result = hook({ type: "context", messages } as any, fakeCtx);
    const elided = result.messages!.find(
      (m: any) => m.role === "toolResult",
    ) as any;
    expect(elided.content[0].text).toMatch(/^\[unknown result elided:/);
  });

  it("elided message does not carry forward details from the source", () => {
    const toolResult: any = {
      role: "toolResult",
      toolCallId: "call-details",
      toolName: "bash",
      content: [{ type: "text", text: "x".repeat(HUGE) }],
      isError: false,
      timestamp: Date.now(),
      details: { rawOutput: "sensitive data", exitCode: 0 },
    };
    const messages = makeMessages(DEFAULTS.staleTurns + 1, toolResult);
    const result = hook({ type: "context", messages } as any, fakeCtx);
    const elided = result.messages!.find(
      (m: any) => m.role === "toolResult",
    ) as any;
    expect(elided.details).toBeUndefined();
    expect("details" in elided).toBe(false);
  });
});

// ---- Helpers for superseded-read detection tests ----

function makeAssistantMsg(
  toolCalls: Array<{
    id: string;
    name: string;
    arguments: Record<string, unknown>;
  }>,
): object {
  return {
    role: "assistant",
    content: toolCalls.map((tc) => ({
      type: "toolCall",
      id: tc.id,
      name: tc.name,
      arguments: tc.arguments,
    })),
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-test",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "toolUse",
    timestamp: Date.now(),
  };
}

function makeToolResultMsg(opts: {
  toolCallId: string;
  toolName: string;
  text?: string;
  isError?: boolean;
  imageOnly?: boolean;
}): object {
  const content = opts.imageOnly
    ? [{ type: "image", data: "abc", mimeType: "image/png" }]
    : [{ type: "text", text: opts.text ?? "file content here" }];
  return {
    role: "toolResult",
    toolCallId: opts.toolCallId,
    toolName: opts.toolName,
    content,
    isError: opts.isError ?? false,
    timestamp: Date.now(),
  };
}

const CWD = "/cwd";
const fakeCtxWithCwd = { cwd: CWD } as any;

function supersededConfig() {
  return { ...defaultConfig(), supersededReadsEnabled: true };
}

function supersededDisabledConfig() {
  return { ...defaultConfig(), supersededReadsEnabled: false };
}

describe("superseded-read detection", () => {
  it("read followed by successful edit of same path → stubbed regardless of size/age", () => {
    const readId = "read-1";
    const editId = "edit-1";
    const messages: any[] = [
      makeUserMsg(),
      makeAssistantMsg([
        { id: readId, name: "read", arguments: { path: "src/foo.ts" } },
      ]),
      makeToolResultMsg({
        toolCallId: readId,
        toolName: "read",
        text: "small",
      }),
      makeUserMsg(),
      makeAssistantMsg([
        {
          id: editId,
          name: "edit",
          arguments: { path: "src/foo.ts", old_string: "x", new_string: "y" },
        },
      ]),
      makeToolResultMsg({ toolCallId: editId, toolName: "edit", text: "ok" }),
    ];
    const hook = makeContextHook(supersededConfig());
    const result = hook({ type: "context", messages } as any, fakeCtxWithCwd);
    const readResult = result.messages!.find(
      (m: any) => m.toolCallId === readId,
    ) as any;
    expect(readResult.content[0].text).toMatch(
      /^\[read result elided \(superseded by later edit\/write of \/cwd\/src\/foo\.ts\):/,
    );
    expect(readResult.content[0].text).toMatch(
      /Call context_recall\("read-1"\) to retrieve original\.\]$/,
    );
  });

  it("read followed by successful write of same path → stubbed", () => {
    const readId = "read-w1";
    const writeId = "write-w1";
    const messages: any[] = [
      makeUserMsg(),
      makeAssistantMsg([
        { id: readId, name: "read", arguments: { path: "src/foo.ts" } },
      ]),
      makeToolResultMsg({
        toolCallId: readId,
        toolName: "read",
        text: "content",
      }),
      makeUserMsg(),
      makeAssistantMsg([
        {
          id: writeId,
          name: "write",
          arguments: { path: "src/foo.ts", content: "new" },
        },
      ]),
      makeToolResultMsg({
        toolCallId: writeId,
        toolName: "write",
        text: "written",
      }),
    ];
    const hook = makeContextHook(supersededConfig());
    const result = hook({ type: "context", messages } as any, fakeCtxWithCwd);
    const readResult = result.messages!.find(
      (m: any) => m.toolCallId === readId,
    ) as any;
    expect(readResult.content[0].text).toMatch(
      /\[read result elided \(superseded by later edit\/write of/,
    );
  });

  it("read followed by edit of different path → NOT stubbed by superseded rule", () => {
    const readId = "read-diff";
    const editId = "edit-diff";
    const messages: any[] = [
      makeUserMsg(),
      makeAssistantMsg([
        { id: readId, name: "read", arguments: { path: "src/foo.ts" } },
      ]),
      makeToolResultMsg({
        toolCallId: readId,
        toolName: "read",
        text: "x".repeat(10),
      }),
      makeUserMsg(),
      makeAssistantMsg([
        {
          id: editId,
          name: "edit",
          arguments: { path: "src/bar.ts", old_string: "a", new_string: "b" },
        },
      ]),
      makeToolResultMsg({ toolCallId: editId, toolName: "edit", text: "ok" }),
    ];
    const hook = makeContextHook(supersededConfig());
    const result = hook({ type: "context", messages } as any, fakeCtxWithCwd);
    const readResult = result.messages!.find(
      (m: any) => m.toolCallId === readId,
    ) as any;
    expect(readResult.content[0].text).toBe("x".repeat(10));
  });

  it("read followed by failed edit of same path (isError: true) → NOT stubbed", () => {
    const readId = "read-fail";
    const editId = "edit-fail";
    const messages: any[] = [
      makeUserMsg(),
      makeAssistantMsg([
        { id: readId, name: "read", arguments: { path: "src/foo.ts" } },
      ]),
      makeToolResultMsg({
        toolCallId: readId,
        toolName: "read",
        text: "content",
      }),
      makeUserMsg(),
      makeAssistantMsg([
        {
          id: editId,
          name: "edit",
          arguments: { path: "src/foo.ts", old_string: "x", new_string: "y" },
        },
      ]),
      makeToolResultMsg({
        toolCallId: editId,
        toolName: "edit",
        text: "error",
        isError: true,
      }),
    ];
    const hook = makeContextHook(supersededConfig());
    const result = hook({ type: "context", messages } as any, fakeCtxWithCwd);
    const readResult = result.messages!.find(
      (m: any) => m.toolCallId === readId,
    ) as any;
    expect(readResult.content[0].text).toBe("content");
  });

  it("two reads of same path followed by one successful edit → both stubbed", () => {
    const readId1 = "read-two-1";
    const readId2 = "read-two-2";
    const editId = "edit-two";
    const messages: any[] = [
      makeUserMsg(),
      makeAssistantMsg([
        { id: readId1, name: "read", arguments: { path: "src/foo.ts" } },
        { id: readId2, name: "read", arguments: { path: "src/foo.ts" } },
      ]),
      makeToolResultMsg({
        toolCallId: readId1,
        toolName: "read",
        text: "first read",
      }),
      makeToolResultMsg({
        toolCallId: readId2,
        toolName: "read",
        text: "second read",
      }),
      makeUserMsg(),
      makeAssistantMsg([
        {
          id: editId,
          name: "edit",
          arguments: { path: "src/foo.ts", old_string: "x", new_string: "y" },
        },
      ]),
      makeToolResultMsg({ toolCallId: editId, toolName: "edit", text: "ok" }),
    ];
    const hook = makeContextHook(supersededConfig());
    const result = hook({ type: "context", messages } as any, fakeCtxWithCwd);
    const read1 = result.messages!.find(
      (m: any) => m.toolCallId === readId1,
    ) as any;
    const read2 = result.messages!.find(
      (m: any) => m.toolCallId === readId2,
    ) as any;
    expect(read1.content[0].text).toMatch(/superseded by later edit\/write/);
    expect(read2.content[0].text).toMatch(/superseded by later edit\/write/);
  });

  it("read of ./src/foo.ts matched by edit of /cwd/src/foo.ts (same normalized path)", () => {
    const readId = "read-rel";
    const editId = "edit-abs";
    const messages: any[] = [
      makeUserMsg(),
      makeAssistantMsg([
        { id: readId, name: "read", arguments: { path: "./src/foo.ts" } },
      ]),
      makeToolResultMsg({
        toolCallId: readId,
        toolName: "read",
        text: "content",
      }),
      makeUserMsg(),
      makeAssistantMsg([
        {
          id: editId,
          name: "edit",
          arguments: {
            path: "/cwd/src/foo.ts",
            old_string: "x",
            new_string: "y",
          },
        },
      ]),
      makeToolResultMsg({ toolCallId: editId, toolName: "edit", text: "ok" }),
    ];
    const hook = makeContextHook(supersededConfig());
    const result = hook({ type: "context", messages } as any, fakeCtxWithCwd);
    const readResult = result.messages!.find(
      (m: any) => m.toolCallId === readId,
    ) as any;
    expect(readResult.content[0].text).toMatch(
      /superseded by later edit\/write of \/cwd\/src\/foo\.ts/,
    );
  });

  it("read of ../sibling/foo.ts matched by edit of /cwd/sibling/foo.ts (same resolved path)", () => {
    const readId = "read-parent";
    const editId = "edit-abs-sib";
    const ctxWithSubdir = { cwd: "/cwd/sub" } as any;
    const messages: any[] = [
      makeUserMsg(),
      makeAssistantMsg([
        { id: readId, name: "read", arguments: { path: "../sibling/foo.ts" } },
      ]),
      makeToolResultMsg({ toolCallId: readId, toolName: "read", text: "data" }),
      makeUserMsg(),
      makeAssistantMsg([
        {
          id: editId,
          name: "edit",
          arguments: {
            path: "/cwd/sibling/foo.ts",
            old_string: "x",
            new_string: "y",
          },
        },
      ]),
      makeToolResultMsg({ toolCallId: editId, toolName: "edit", text: "ok" }),
    ];
    const hook = makeContextHook(supersededConfig());
    const result = hook({ type: "context", messages } as any, ctxWithSubdir);
    const readResult = result.messages!.find(
      (m: any) => m.toolCallId === readId,
    ) as any;
    expect(readResult.content[0].text).toMatch(
      /superseded by later edit\/write of \/cwd\/sibling\/foo\.ts/,
    );
  });

  it("superseded rule disabled → read not stubbed by superseded rule", () => {
    const readId = "read-dis";
    const editId = "edit-dis";
    const messages: any[] = [
      makeUserMsg(),
      makeAssistantMsg([
        { id: readId, name: "read", arguments: { path: "src/foo.ts" } },
      ]),
      makeToolResultMsg({
        toolCallId: readId,
        toolName: "read",
        text: "content",
      }),
      makeUserMsg(),
      makeAssistantMsg([
        {
          id: editId,
          name: "edit",
          arguments: { path: "src/foo.ts", old_string: "x", new_string: "y" },
        },
      ]),
      makeToolResultMsg({ toolCallId: editId, toolName: "edit", text: "ok" }),
    ];
    const hook = makeContextHook(supersededDisabledConfig());
    const result = hook({ type: "context", messages } as any, fakeCtxWithCwd);
    const readResult = result.messages!.find(
      (m: any) => m.toolCallId === readId,
    ) as any;
    expect(readResult.content[0].text).toBe("content");
  });

  it("edit before read, then another edit after read → read IS stubbed", () => {
    const editId1 = "edit-pre";
    const readId = "read-mid";
    const editId2 = "edit-post";
    const messages: any[] = [
      makeUserMsg(),
      makeAssistantMsg([
        {
          id: editId1,
          name: "edit",
          arguments: { path: "src/foo.ts", old_string: "a", new_string: "b" },
        },
      ]),
      makeToolResultMsg({ toolCallId: editId1, toolName: "edit", text: "ok" }),
      makeUserMsg(),
      makeAssistantMsg([
        { id: readId, name: "read", arguments: { path: "src/foo.ts" } },
      ]),
      makeToolResultMsg({
        toolCallId: readId,
        toolName: "read",
        text: "intermediate content",
      }),
      makeUserMsg(),
      makeAssistantMsg([
        {
          id: editId2,
          name: "edit",
          arguments: { path: "src/foo.ts", old_string: "b", new_string: "c" },
        },
      ]),
      makeToolResultMsg({ toolCallId: editId2, toolName: "edit", text: "ok" }),
    ];
    const hook = makeContextHook(supersededConfig());
    const result = hook({ type: "context", messages } as any, fakeCtxWithCwd);
    const readResult = result.messages!.find(
      (m: any) => m.toolCallId === readId,
    ) as any;
    expect(readResult.content[0].text).toMatch(
      /superseded by later edit\/write/,
    );
  });

  it("edit of same path BEFORE the read does NOT supersede it", () => {
    const editId = "edit-before";
    const readId = "read-after-edit";
    const messages: any[] = [
      makeUserMsg(),
      makeAssistantMsg([
        {
          id: editId,
          name: "edit",
          arguments: { path: "src/foo.ts", old_string: "x", new_string: "y" },
        },
      ]),
      makeToolResultMsg({ toolCallId: editId, toolName: "edit", text: "ok" }),
      makeUserMsg(),
      makeAssistantMsg([
        { id: readId, name: "read", arguments: { path: "src/foo.ts" } },
      ]),
      makeToolResultMsg({
        toolCallId: readId,
        toolName: "read",
        text: "fresh content",
      }),
    ];
    const hook = makeContextHook(supersededConfig());
    const result = hook({ type: "context", messages } as any, fakeCtxWithCwd);
    const readResult = result.messages!.find(
      (m: any) => m.toolCallId === readId,
    ) as any;
    expect(readResult.content[0].text).toBe("fresh content");
  });

  it("read with no path field in tool input → NOT considered for superseded rule", () => {
    const readId = "read-nopath";
    const editId = "edit-some";
    const messages: any[] = [
      makeUserMsg(),
      makeAssistantMsg([{ id: readId, name: "read", arguments: {} }]),
      makeToolResultMsg({
        toolCallId: readId,
        toolName: "read",
        text: "content",
      }),
      makeUserMsg(),
      makeAssistantMsg([
        {
          id: editId,
          name: "edit",
          arguments: { path: "src/foo.ts", old_string: "x", new_string: "y" },
        },
      ]),
      makeToolResultMsg({ toolCallId: editId, toolName: "edit", text: "ok" }),
    ];
    const hook = makeContextHook(supersededConfig());
    const result = hook({ type: "context", messages } as any, fakeCtxWithCwd);
    const readResult = result.messages!.find(
      (m: any) => m.toolCallId === readId,
    ) as any;
    expect(readResult.content[0].text).toBe("content");
  });

  it("read that is BOTH superseded AND generic-stale eligible → superseded stub format wins", () => {
    const readId = "read-both";
    const editId = "edit-both";
    const bigText = "x".repeat(BIG);
    const messages: any[] = [makeUserMsg()];
    messages.push(
      makeAssistantMsg([
        { id: readId, name: "read", arguments: { path: "src/foo.ts" } },
      ]),
    );
    messages.push(
      makeToolResultMsg({
        toolCallId: readId,
        toolName: "read",
        text: bigText,
      }),
    );
    for (let k = 0; k < DEFAULTS.staleTurns; k++) {
      messages.push(makeUserMsg());
    }
    messages.push(
      makeAssistantMsg([
        {
          id: editId,
          name: "edit",
          arguments: { path: "src/foo.ts", old_string: "x", new_string: "y" },
        },
      ]),
    );
    messages.push(
      makeToolResultMsg({ toolCallId: editId, toolName: "edit", text: "ok" }),
    );
    const hook = makeContextHook(supersededConfig());
    const result = hook({ type: "context", messages } as any, fakeCtxWithCwd);
    const readResult = result.messages!.find(
      (m: any) => m.toolCallId === readId,
    ) as any;
    expect(readResult.content[0].text).toMatch(
      /superseded by later edit\/write/,
    );
    expect(readResult.content[0].text).not.toMatch(/^\[read result elided:/i);
  });

  it("image-only read result with a later edit → stubbed but stub has no Preview segment", () => {
    const readId = "read-img";
    const editId = "edit-img";
    const messages: any[] = [
      makeUserMsg(),
      makeAssistantMsg([
        { id: readId, name: "read", arguments: { path: "src/foo.ts" } },
      ]),
      makeToolResultMsg({
        toolCallId: readId,
        toolName: "read",
        imageOnly: true,
      }),
      makeUserMsg(),
      makeAssistantMsg([
        {
          id: editId,
          name: "edit",
          arguments: { path: "src/foo.ts", old_string: "x", new_string: "y" },
        },
      ]),
      makeToolResultMsg({ toolCallId: editId, toolName: "edit", text: "ok" }),
    ];
    const hook = makeContextHook(supersededConfig());
    const result = hook({ type: "context", messages } as any, fakeCtxWithCwd);
    const readResult = result.messages!.find(
      (m: any) => m.toolCallId === readId,
    ) as any;
    expect(readResult.content[0].text).toMatch(
      /superseded by later edit\/write/,
    );
    expect(readResult.content[0].text).not.toContain("Preview:");
  });
});

describe("formatDuplicateStub", () => {
  it("formats stub with correct prefix and turn reference", () => {
    const result = formatDuplicateStub({
      toolName: "read",
      normalizedPath: "/cwd/src/foo.ts",
      keptUserTurnIndex: 3,
      tokenCount: 125,
      toolCallId: "read-1",
    });
    expect(result).toBe(
      '[read result elided (superseded by later read of /cwd/src/foo.ts at turn 3): 125 tokens. Call context_recall("read-1") to retrieve.]',
    );
  });

  it("includes Preview segment when preview is provided", () => {
    const result = formatDuplicateStub({
      toolName: "read",
      normalizedPath: "/cwd/src/foo.ts",
      keptUserTurnIndex: 2,
      tokenCount: 256,
      toolCallId: "read-2",
      preview: "hello world",
    });
    expect(result).toContain(' Preview: "hello world".');
  });

  it("omits Preview segment when preview is null", () => {
    const result = formatDuplicateStub({
      toolName: "read",
      normalizedPath: "/cwd/src/foo.ts",
      keptUserTurnIndex: 2,
      tokenCount: 256,
      toolCallId: "read-3",
      preview: null,
    });
    expect(result).not.toContain("Preview:");
  });
});

// ---- Helpers for duplicate-read detection tests ----

function duplicateConfig() {
  return {
    ...defaultConfig(),
    duplicateReadsEnabled: true,
    supersededReadsEnabled: false,
  };
}

function duplicateDisabledConfig() {
  return {
    ...defaultConfig(),
    duplicateReadsEnabled: false,
    supersededReadsEnabled: false,
  };
}

function bothRulesConfig() {
  return {
    ...defaultConfig(),
    duplicateReadsEnabled: true,
    supersededReadsEnabled: true,
  };
}

describe("duplicate-read detection", () => {
  it("two successful reads of same path → first stubbed, second intact", () => {
    const readId1 = "dup-read-1";
    const readId2 = "dup-read-2";
    const messages: any[] = [
      makeUserMsg(),
      makeAssistantMsg([
        { id: readId1, name: "read", arguments: { path: "src/foo.ts" } },
      ]),
      makeToolResultMsg({
        toolCallId: readId1,
        toolName: "read",
        text: "first content",
      }),
      makeUserMsg(),
      makeAssistantMsg([
        { id: readId2, name: "read", arguments: { path: "src/foo.ts" } },
      ]),
      makeToolResultMsg({
        toolCallId: readId2,
        toolName: "read",
        text: "second content",
      }),
    ];
    const hook = makeContextHook(duplicateConfig());
    const result = hook({ type: "context", messages } as any, fakeCtxWithCwd);
    const read1 = result.messages!.find(
      (m: any) => m.toolCallId === readId1,
    ) as any;
    const read2 = result.messages!.find(
      (m: any) => m.toolCallId === readId2,
    ) as any;
    expect(read1.content[0].text).toMatch(
      /^\[read result elided \(superseded by later read of/,
    );
    expect(read2.content[0].text).toBe("second content");
  });

  it("three successful reads of same path → first two stubbed, third intact", () => {
    const readId1 = "tri-read-1";
    const readId2 = "tri-read-2";
    const readId3 = "tri-read-3";
    const messages: any[] = [
      makeUserMsg(),
      makeAssistantMsg([
        { id: readId1, name: "read", arguments: { path: "src/foo.ts" } },
      ]),
      makeToolResultMsg({
        toolCallId: readId1,
        toolName: "read",
        text: "first",
      }),
      makeUserMsg(),
      makeAssistantMsg([
        { id: readId2, name: "read", arguments: { path: "src/foo.ts" } },
      ]),
      makeToolResultMsg({
        toolCallId: readId2,
        toolName: "read",
        text: "second",
      }),
      makeUserMsg(),
      makeAssistantMsg([
        { id: readId3, name: "read", arguments: { path: "src/foo.ts" } },
      ]),
      makeToolResultMsg({
        toolCallId: readId3,
        toolName: "read",
        text: "third",
      }),
    ];
    const hook = makeContextHook(duplicateConfig());
    const result = hook({ type: "context", messages } as any, fakeCtxWithCwd);
    const read1 = result.messages!.find(
      (m: any) => m.toolCallId === readId1,
    ) as any;
    const read2 = result.messages!.find(
      (m: any) => m.toolCallId === readId2,
    ) as any;
    const read3 = result.messages!.find(
      (m: any) => m.toolCallId === readId3,
    ) as any;
    expect(read1.content[0].text).toMatch(
      /^\[read result elided \(superseded by later read of/,
    );
    expect(read2.content[0].text).toMatch(
      /^\[read result elided \(superseded by later read of/,
    );
    expect(read3.content[0].text).toBe("third");
  });

  it("reads of src/foo.ts and src/bar.ts → neither is stubbed (different paths)", () => {
    const readId1 = "diff-read-1";
    const readId2 = "diff-read-2";
    const messages: any[] = [
      makeUserMsg(),
      makeAssistantMsg([
        { id: readId1, name: "read", arguments: { path: "src/foo.ts" } },
      ]),
      makeToolResultMsg({
        toolCallId: readId1,
        toolName: "read",
        text: "foo content",
      }),
      makeUserMsg(),
      makeAssistantMsg([
        { id: readId2, name: "read", arguments: { path: "src/bar.ts" } },
      ]),
      makeToolResultMsg({
        toolCallId: readId2,
        toolName: "read",
        text: "bar content",
      }),
    ];
    const hook = makeContextHook(duplicateConfig());
    const result = hook({ type: "context", messages } as any, fakeCtxWithCwd);
    const read1 = result.messages!.find(
      (m: any) => m.toolCallId === readId1,
    ) as any;
    const read2 = result.messages!.find(
      (m: any) => m.toolCallId === readId2,
    ) as any;
    expect(read1.content[0].text).toBe("foo content");
    expect(read2.content[0].text).toBe("bar content");
  });

  it("one successful + one failed read of same path → neither stubbed by duplicate rule", () => {
    const readId1 = "ok-read-1";
    const readId2 = "err-read-2";
    const messages: any[] = [
      makeUserMsg(),
      makeAssistantMsg([
        { id: readId1, name: "read", arguments: { path: "src/foo.ts" } },
      ]),
      makeToolResultMsg({
        toolCallId: readId1,
        toolName: "read",
        text: "ok content",
      }),
      makeUserMsg(),
      makeAssistantMsg([
        { id: readId2, name: "read", arguments: { path: "src/foo.ts" } },
      ]),
      makeToolResultMsg({
        toolCallId: readId2,
        toolName: "read",
        text: "error",
        isError: true,
      }),
    ];
    const hook = makeContextHook(duplicateConfig());
    const result = hook({ type: "context", messages } as any, fakeCtxWithCwd);
    const read1 = result.messages!.find(
      (m: any) => m.toolCallId === readId1,
    ) as any;
    const read2 = result.messages!.find(
      (m: any) => m.toolCallId === readId2,
    ) as any;
    expect(read1.content[0].text).toBe("ok content");
    expect(read2.content[0].text).toBe("error");
  });

  it("two successful + one failed read interleaved → first successful stubbed, last successful intact, failed intact", () => {
    const readId1 = "interleave-ok-1";
    const readId2 = "interleave-err";
    const readId3 = "interleave-ok-2";
    const messages: any[] = [
      makeUserMsg(),
      makeAssistantMsg([
        { id: readId1, name: "read", arguments: { path: "src/foo.ts" } },
      ]),
      makeToolResultMsg({
        toolCallId: readId1,
        toolName: "read",
        text: "first ok",
      }),
      makeUserMsg(),
      makeAssistantMsg([
        { id: readId2, name: "read", arguments: { path: "src/foo.ts" } },
      ]),
      makeToolResultMsg({
        toolCallId: readId2,
        toolName: "read",
        text: "failed",
        isError: true,
      }),
      makeUserMsg(),
      makeAssistantMsg([
        { id: readId3, name: "read", arguments: { path: "src/foo.ts" } },
      ]),
      makeToolResultMsg({
        toolCallId: readId3,
        toolName: "read",
        text: "last ok",
      }),
    ];
    const hook = makeContextHook(duplicateConfig());
    const result = hook({ type: "context", messages } as any, fakeCtxWithCwd);
    const read1 = result.messages!.find(
      (m: any) => m.toolCallId === readId1,
    ) as any;
    const read2 = result.messages!.find(
      (m: any) => m.toolCallId === readId2,
    ) as any;
    const read3 = result.messages!.find(
      (m: any) => m.toolCallId === readId3,
    ) as any;
    expect(read1.content[0].text).toMatch(
      /^\[read result elided \(superseded by later read of/,
    );
    expect(read2.content[0].text).toBe("failed");
    expect(read3.content[0].text).toBe("last ok");
  });

  it("read of ./src/foo.ts and later read of /cwd/src/foo.ts (same normalized path) → first stubbed", () => {
    const readId1 = "rel-read-1";
    const readId2 = "abs-read-2";
    const messages: any[] = [
      makeUserMsg(),
      makeAssistantMsg([
        { id: readId1, name: "read", arguments: { path: "./src/foo.ts" } },
      ]),
      makeToolResultMsg({
        toolCallId: readId1,
        toolName: "read",
        text: "relative content",
      }),
      makeUserMsg(),
      makeAssistantMsg([
        { id: readId2, name: "read", arguments: { path: "/cwd/src/foo.ts" } },
      ]),
      makeToolResultMsg({
        toolCallId: readId2,
        toolName: "read",
        text: "absolute content",
      }),
    ];
    const hook = makeContextHook(duplicateConfig());
    const result = hook({ type: "context", messages } as any, fakeCtxWithCwd);
    const read1 = result.messages!.find(
      (m: any) => m.toolCallId === readId1,
    ) as any;
    const read2 = result.messages!.find(
      (m: any) => m.toolCallId === readId2,
    ) as any;
    expect(read1.content[0].text).toMatch(
      /^\[read result elided \(superseded by later read of/,
    );
    expect(read2.content[0].text).toBe("absolute content");
  });

  it("read that is both duplicated and superseded-by-edit → gets superseded-by-edit stub", () => {
    const readId1 = "both-read-1";
    const readId2 = "both-read-2";
    const editId = "both-edit";
    const messages: any[] = [
      makeUserMsg(),
      makeAssistantMsg([
        { id: readId1, name: "read", arguments: { path: "src/foo.ts" } },
      ]),
      makeToolResultMsg({
        toolCallId: readId1,
        toolName: "read",
        text: "first read",
      }),
      makeUserMsg(),
      makeAssistantMsg([
        { id: readId2, name: "read", arguments: { path: "src/foo.ts" } },
      ]),
      makeToolResultMsg({
        toolCallId: readId2,
        toolName: "read",
        text: "second read",
      }),
      makeUserMsg(),
      makeAssistantMsg([
        {
          id: editId,
          name: "edit",
          arguments: { path: "src/foo.ts", old_string: "x", new_string: "y" },
        },
      ]),
      makeToolResultMsg({ toolCallId: editId, toolName: "edit", text: "ok" }),
    ];
    const hook = makeContextHook(bothRulesConfig());
    const result = hook({ type: "context", messages } as any, fakeCtxWithCwd);
    const read1 = result.messages!.find(
      (m: any) => m.toolCallId === readId1,
    ) as any;
    expect(read1.content[0].text).toMatch(/superseded by later edit\/write/);
    expect(read1.content[0].text).not.toMatch(/superseded by later read/);
  });

  it("duplicate rule disabled via config → no read stubbed by duplicate rule", () => {
    const readId1 = "dis-read-1";
    const readId2 = "dis-read-2";
    const messages: any[] = [
      makeUserMsg(),
      makeAssistantMsg([
        { id: readId1, name: "read", arguments: { path: "src/foo.ts" } },
      ]),
      makeToolResultMsg({
        toolCallId: readId1,
        toolName: "read",
        text: "first",
      }),
      makeUserMsg(),
      makeAssistantMsg([
        { id: readId2, name: "read", arguments: { path: "src/foo.ts" } },
      ]),
      makeToolResultMsg({
        toolCallId: readId2,
        toolName: "read",
        text: "second",
      }),
    ];
    const hook = makeContextHook(duplicateDisabledConfig());
    const result = hook({ type: "context", messages } as any, fakeCtxWithCwd);
    const read1 = result.messages!.find(
      (m: any) => m.toolCallId === readId1,
    ) as any;
    const read2 = result.messages!.find(
      (m: any) => m.toolCallId === readId2,
    ) as any;
    expect(read1.content[0].text).toBe("first");
    expect(read2.content[0].text).toBe("second");
  });

  it("earliest read in a group of 4 is still stubbed (not just second-to-last)", () => {
    const ids = ["quad-1", "quad-2", "quad-3", "quad-4"];
    const messages: any[] = [makeUserMsg()];
    for (const id of ids) {
      messages.push(
        makeAssistantMsg([
          { id, name: "read", arguments: { path: "src/foo.ts" } },
        ]),
      );
      messages.push(
        makeToolResultMsg({
          toolCallId: id,
          toolName: "read",
          text: `content-${id}`,
        }),
      );
      messages.push(makeUserMsg());
    }
    const hook = makeContextHook(duplicateConfig());
    const result = hook({ type: "context", messages } as any, fakeCtxWithCwd);
    for (const id of ids.slice(0, 3)) {
      const read = result.messages!.find(
        (m: any) => m.toolCallId === id,
      ) as any;
      expect(read.content[0].text).toMatch(
        /^\[read result elided \(superseded by later read of/,
      );
    }
    const last = result.messages!.find(
      (m: any) => m.toolCallId === "quad-4",
    ) as any;
    expect(last.content[0].text).toBe("content-quad-4");
  });

  it("small read (< DEFAULTS.minTokens * 4) that is duplicated still gets stubbed (size threshold doesn't apply)", () => {
    const readId1 = "small-dup-1";
    const readId2 = "small-dup-2";
    const messages: any[] = [
      makeUserMsg(),
      makeAssistantMsg([
        { id: readId1, name: "read", arguments: { path: "src/foo.ts" } },
      ]),
      makeToolResultMsg({
        toolCallId: readId1,
        toolName: "read",
        text: "tiny",
      }),
      makeUserMsg(),
      makeAssistantMsg([
        { id: readId2, name: "read", arguments: { path: "src/foo.ts" } },
      ]),
      makeToolResultMsg({
        toolCallId: readId2,
        toolName: "read",
        text: "also tiny",
      }),
    ];
    const hook = makeContextHook(duplicateConfig());
    const result = hook({ type: "context", messages } as any, fakeCtxWithCwd);
    const read1 = result.messages!.find(
      (m: any) => m.toolCallId === readId1,
    ) as any;
    expect(read1.content[0].text).toMatch(
      /^\[read result elided \(superseded by later read of/,
    );
  });

  it("single read of a file is never stubbed by duplicate rule", () => {
    const readId = "single-read";
    const messages: any[] = [
      makeUserMsg(),
      makeAssistantMsg([
        { id: readId, name: "read", arguments: { path: "src/foo.ts" } },
      ]),
      makeToolResultMsg({
        toolCallId: readId,
        toolName: "read",
        text: "only read",
      }),
    ];
    const hook = makeContextHook(duplicateConfig());
    const result = hook({ type: "context", messages } as any, fakeCtxWithCwd);
    const read = result.messages!.find(
      (m: any) => m.toolCallId === readId,
    ) as any;
    expect(read.content[0].text).toBe("only read");
  });
});

function makeTextMsg(role: string, text: string): any {
  return {
    role,
    content: [{ type: "text", text }],
    timestamp: Date.now(),
  };
}

function makeToolResultMsg2(toolCallId: string, text: string): any {
  return {
    role: "toolResult",
    toolCallId,
    toolName: "read",
    content: [{ type: "text", text }],
    isError: false,
    timestamp: Date.now(),
  };
}

describe("estimateSuffixTokens", () => {
  it("counts user and assistant text blocks", () => {
    const messages = [
      makeTextMsg("user", "hello"),
      makeTextMsg("assistant", "world"),
    ];
    expect(estimateSuffixTokens(messages, -1)).toBe(
      Math.ceil(("hello".length + "world".length) / 4),
    );
  });

  it("counts toolResult text blocks", () => {
    const messages = [
      makeToolResultMsg2("call-1", "alpha"),
      makeToolResultMsg2("call-2", "beta"),
    ];
    expect(estimateSuffixTokens(messages, -1)).toBe(
      Math.ceil(("alpha".length + "beta".length) / 4),
    );
  });

  it("ignores messages at or before afterIndex", () => {
    const messages = [
      makeTextMsg("user", "first"),
      makeTextMsg("user", "second"),
      makeTextMsg("user", "third"),
    ];
    expect(estimateSuffixTokens(messages, 1)).toBe(
      Math.ceil("third".length / 4),
    );
  });

  it("ignores non-text blocks within toolResult content", () => {
    const messages = [
      {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "read",
        content: [{ type: "image", data: "ignored" }],
        isError: false,
        timestamp: Date.now(),
      },
      makeTextMsg("user", "after"),
    ];
    expect(estimateSuffixTokens(messages, -1)).toBe(
      Math.ceil("after".length / 4),
    );
  });

  it("returns 0 when afterIndex is the last message", () => {
    const messages = [makeTextMsg("user", "only")];
    expect(estimateSuffixTokens(messages, 0)).toBe(0);
  });

  it("includes mixed user, assistant, and toolResult blocks", () => {
    const messages = [
      makeTextMsg("user", "a"),
      makeToolResultMsg2("c1", "bb"),
      makeTextMsg("assistant", "ccc"),
      makeToolResultMsg2("c2", "dddd"),
    ];
    expect(estimateSuffixTokens(messages, 1)).toBe(
      Math.ceil(("ccc".length + "dddd".length) / 4),
    );
  });
});

describe("young-or-batch read pruning", () => {
  const largeSource = "s".repeat(180_000);
  const largeSuffix = makeTextMsg("user", "tail".repeat(40_000));

  it("does not immediately stub an old superseded read when suffix cost exceeds its profile budget", () => {
    const readId = "task3-sup-old";
    const editId = "task3-sup-edit";
    const messages: any[] = [
      makeUserMsg(),
      makeAssistantMsg([
        { id: readId, name: "read", arguments: { path: "src/old.ts" } },
      ]),
      makeToolResultMsg({
        toolCallId: readId,
        toolName: "read",
        text: largeSource,
      }),
      largeSuffix,
      makeAssistantMsg([
        {
          id: editId,
          name: "edit",
          arguments: { path: "src/old.ts", old_string: "a", new_string: "b" },
        },
      ]),
      makeToolResultMsg({ toolCallId: editId, toolName: "edit", text: "ok" }),
    ];

    const result = makeContextHook(supersededConfig())(
      { type: "context", messages } as any,
      fakeCtxWithCwd,
    );
    const read = result.messages!.find(
      (m: any) => m.toolCallId === readId,
    ) as any;
    expect(read.content[0].text).toBe(largeSource);
  });

  it("does not immediately stub an old duplicate read when suffix cost exceeds its profile budget", () => {
    const readId1 = "task3-dup-old-1";
    const readId2 = "task3-dup-old-2";
    const messages: any[] = [
      makeUserMsg(),
      makeAssistantMsg([
        { id: readId1, name: "read", arguments: { path: "src/dup.ts" } },
      ]),
      makeToolResultMsg({
        toolCallId: readId1,
        toolName: "read",
        text: largeSource,
      }),
      largeSuffix,
      makeAssistantMsg([
        { id: readId2, name: "read", arguments: { path: "src/dup.ts" } },
      ]),
      makeToolResultMsg({
        toolCallId: readId2,
        toolName: "read",
        text: "latest",
      }),
    ];

    const result = makeContextHook(duplicateConfig())(
      { type: "context", messages } as any,
      fakeCtxWithCwd,
    );
    const read = result.messages!.find(
      (m: any) => m.toolCallId === readId1,
    ) as any;
    expect(read.content[0].text).toBe(largeSource);
  });

  it("does not batch-prune ordinary source reads merely because they are large", () => {
    const ids = ["task3-source-1", "task3-source-2"];
    const messages: any[] = [makeUserMsg()];
    for (const id of ids) {
      messages.push(
        makeAssistantMsg([
          { id, name: "read", arguments: { path: `src/${id}.ts` } },
        ]),
        makeToolResultMsg({
          toolCallId: id,
          toolName: "read",
          text: largeSource,
        }),
        makeUserMsg(),
        makeUserMsg(),
        makeUserMsg(),
        makeUserMsg(),
      );
    }

    const result = makeContextHook({
      ...defaultConfig(),
      batchMinSavedTokens: 1,
      batchMinNetValue: 0,
    })({ type: "context", messages } as any, fakeCtxWithCwd);

    for (const id of ids) {
      const read = result.messages!.find(
        (m: any) => m.toolCallId === id,
      ) as any;
      expect(read.content[0].text).toBe(largeSource);
    }
  });

  it("uses emergency-pressure only over the hard context reserve", () => {
    const id = "task3-emergency-read";
    const passes: any[] = [];
    const messages: any[] = [
      makeUserMsg(),
      makeAssistantMsg([
        { id, name: "read", arguments: { path: "src/emergency.ts" } },
      ]),
      makeToolResultMsg({
        toolCallId: id,
        toolName: "read",
        text: largeSource,
      }),
      ...Array.from({ length: DEFAULTS.staleTurns + 1 }, () => makeUserMsg()),
    ];

    const result = makeContextHook(defaultConfig(), (p) => passes.push(p))(
      { type: "context", messages } as any,
      {
        ...fakeCtxWithCwd,
        getContextUsage: () => ({ tokens: 90_000, contextWindow: 100_000 }),
      } as any,
    );
    const read = result.messages!.find((m: any) => m.toolCallId === id) as any;
    expect(read.content[0].text).toMatch(/emergency context pressure/);
    expect(passes[0].entries[0].reason).toBe("emergency-pressure");
  });

  it("batch selection honors priority when the cap excludes lower-priority candidates", () => {
    const bashId = "task3-bash";
    const dup1 = "task3-priority-dup-1";
    const dup2 = "task3-priority-dup-2";
    const sup = "task3-priority-sup";
    const editId = "task3-priority-edit";
    const passes: any[] = [];
    const messages: any[] = [
      makeUserMsg(),
      makeAssistantMsg([
        { id: bashId, name: "bash", arguments: { command: "echo ok" } },
      ]),
      makeToolResultMsg({
        toolCallId: bashId,
        toolName: "bash",
        text: "ok\n".repeat(60_000),
      }),
      { role: "assistant", content: [{ type: "text", text: "consumed" }] },
      makeUserMsg(),
      makeAssistantMsg([
        { id: dup1, name: "read", arguments: { path: "src/dup-priority.ts" } },
      ]),
      makeToolResultMsg({
        toolCallId: dup1,
        toolName: "read",
        text: largeSource,
      }),
      makeUserMsg(),
      makeAssistantMsg([
        { id: sup, name: "read", arguments: { path: "src/sup-priority.ts" } },
      ]),
      makeToolResultMsg({
        toolCallId: sup,
        toolName: "read",
        text: largeSource,
      }),
      largeSuffix,
      makeAssistantMsg([
        { id: dup2, name: "read", arguments: { path: "src/dup-priority.ts" } },
      ]),
      makeToolResultMsg({ toolCallId: dup2, toolName: "read", text: "latest" }),
      makeAssistantMsg([
        {
          id: editId,
          name: "edit",
          arguments: {
            path: "src/sup-priority.ts",
            old_string: "a",
            new_string: "b",
          },
        },
      ]),
      makeToolResultMsg({ toolCallId: editId, toolName: "edit", text: "ok" }),
    ];

    const result = makeContextHook(
      {
        ...defaultConfig(),
        batchMaxCandidates: 2,
        batchMinSavedTokens: 1,
        batchMinNetValue: 0,
      },
      (p) => passes.push(p),
    )({ type: "context", messages } as any, fakeCtxWithCwd);

    const bash = result.messages!.find(
      (m: any) => m.toolCallId === bashId,
    ) as any;
    const dup = result.messages!.find((m: any) => m.toolCallId === dup1) as any;
    const superseded = result.messages!.find(
      (m: any) => m.toolCallId === sup,
    ) as any;
    expect(bash.content[0].text).toMatch(
      /compacted by cache-aware batch pruning/,
    );
    expect(dup.content[0].text).toMatch(
      /compacted by cache-aware batch pruning/,
    );
    expect(superseded.content[0].text).toBe(largeSource);
    expect(passes[0].entries.map((e: any) => e.toolCallId)).toEqual([
      bashId,
      dup1,
    ]);
    expect(passes[0].entries.map((e: any) => e.reason)).toEqual([
      "batch-pressure",
      "batch-pressure",
    ]);
  });

  it("compacts a young superseded read with reason superseded-read-young", () => {
    const readId = "young-sup-read";
    const editId = "young-sup-edit";
    const passes: any[] = [];
    const messages: any[] = [
      makeUserMsg(),
      makeAssistantMsg([
        { id: readId, name: "read", arguments: { path: "src/young.ts" } },
      ]),
      makeToolResultMsg({
        toolCallId: readId,
        toolName: "read",
        text: "s".repeat(HUGE),
      }),
      makeUserMsg(),
      makeAssistantMsg([
        {
          id: editId,
          name: "edit",
          arguments: { path: "src/young.ts", old_string: "a", new_string: "b" },
        },
      ]),
      makeToolResultMsg({ toolCallId: editId, toolName: "edit", text: "ok" }),
    ];

    const result = makeContextHook(supersededConfig(), (p) => passes.push(p))(
      { type: "context", messages } as any,
      fakeCtxWithCwd,
    );
    const read = result.messages!.find(
      (m: any) => m.toolCallId === readId,
    ) as any;
    expect(read.content[0].text).toMatch(/superseded by later edit\/write/);
    expect(passes[0].entries[0].reason).toBe("superseded-read-young");
  });

  it("compacts a young duplicate read with reason duplicate-read-young", () => {
    const readId1 = "young-dup-1";
    const readId2 = "young-dup-2";
    const passes: any[] = [];
    const messages: any[] = [
      makeUserMsg(),
      makeAssistantMsg([
        { id: readId1, name: "read", arguments: { path: "src/dup.ts" } },
      ]),
      makeToolResultMsg({
        toolCallId: readId1,
        toolName: "read",
        text: "s".repeat(HUGE),
      }),
      makeUserMsg(),
      makeAssistantMsg([
        { id: readId2, name: "read", arguments: { path: "src/dup.ts" } },
      ]),
      makeToolResultMsg({
        toolCallId: readId2,
        toolName: "read",
        text: "latest",
      }),
    ];

    const result = makeContextHook(duplicateConfig(), (p) => passes.push(p))(
      { type: "context", messages } as any,
      fakeCtxWithCwd,
    );
    const read = result.messages!.find(
      (m: any) => m.toolCallId === readId1,
    ) as any;
    expect(read.content[0].text).toMatch(/superseded by later read/);
    expect(passes[0].entries[0].reason).toBe("duplicate-read-young");
  });

  it("superseded-read stub takes precedence over duplicate-read when both match and young-elided", () => {
    const readId1 = "both-young-1";
    const readId2 = "both-young-2";
    const editId = "both-young-edit";
    const passes: any[] = [];
    const messages: any[] = [
      makeUserMsg(),
      makeAssistantMsg([
        { id: readId1, name: "read", arguments: { path: "src/both.ts" } },
      ]),
      makeToolResultMsg({
        toolCallId: readId1,
        toolName: "read",
        text: "s".repeat(HUGE),
      }),
      makeUserMsg(),
      makeAssistantMsg([
        { id: readId2, name: "read", arguments: { path: "src/both.ts" } },
      ]),
      makeToolResultMsg({
        toolCallId: readId2,
        toolName: "read",
        text: "latest",
      }),
      makeUserMsg(),
      makeAssistantMsg([
        {
          id: editId,
          name: "edit",
          arguments: { path: "src/both.ts", old_string: "a", new_string: "b" },
        },
      ]),
      makeToolResultMsg({ toolCallId: editId, toolName: "edit", text: "ok" }),
    ];

    const result = makeContextHook(bothRulesConfig(), (p) => passes.push(p))(
      { type: "context", messages } as any,
      fakeCtxWithCwd,
    );
    const read = result.messages!.find(
      (m: any) => m.toolCallId === readId1,
    ) as any;
    expect(read.content[0].text).toMatch(/superseded by later edit\/write/);
    expect(read.content[0].text).not.toMatch(/superseded by later read/);
    expect(passes[0].entries[0].reason).toBe("superseded-read-young");
  });

  it("does not batch-prune a single old stale candidate when batch score is not positive", () => {
    const id = "single-stale";
    const hugeSuffix = makeTextMsg("user", "t".repeat(400_000));
    const passes: any[] = [];
    const messages: any[] = [
      makeUserMsg(),
      makeAssistantMsg([{ id, name: "grep", arguments: { pattern: "foo" } }]),
      makeToolResultMsg({
        toolCallId: id,
        toolName: "grep",
        text: "s".repeat(HUGE),
      }),
      ...Array.from({ length: DEFAULTS.staleTurns }, () => makeUserMsg()),
      hugeSuffix,
    ];

    const result = makeContextHook(defaultConfig(), (p) => passes.push(p))(
      { type: "context", messages } as any,
      fakeCtxWithCwd,
    );
    const found = result.messages!.find((m: any) => m.toolCallId === id) as any;
    expect(found.content[0].text).toBe("s".repeat(HUGE));
    expect(passes[0].entries.length).toBe(0);
  });

  it("batch-prunes multiple old candidates in one pass when aggregate value justifies cost", () => {
    const ids = ["batch-1", "batch-2", "batch-3"];
    const XLARGE = 300_000;
    const hugeSuffix = makeTextMsg("user", "t".repeat(400_000));
    const passes: any[] = [];
    const messages: any[] = [makeUserMsg()];
    for (const id of ids) {
      messages.push(
        makeAssistantMsg([{ id, name: "grep", arguments: { pattern: "foo" } }]),
        makeToolResultMsg({
          toolCallId: id,
          toolName: "grep",
          text: "s".repeat(XLARGE),
        }),
        makeUserMsg(),
      );
    }
    messages.push(
      ...Array.from({ length: DEFAULTS.staleTurns - 1 }, () => makeUserMsg()),
      hugeSuffix,
    );

    const result = makeContextHook(defaultConfig(), (p) => passes.push(p))(
      { type: "context", messages } as any,
      fakeCtxWithCwd,
    );
    for (const id of ids) {
      const found = result.messages!.find(
        (m: any) => m.toolCallId === id,
      ) as any;
      expect(found.content[0].text).toMatch(
        /compacted by cache-aware batch pruning/,
      );
    }
    expect(passes[0].entries.length).toBe(3);
    expect(
      passes[0].entries.every((e: any) => e.reason === "batch-pressure"),
    ).toBe(true);
  });

  it("enforces old-history batch cooldown and lets emergency pressure bypass it", () => {
    const config = {
      ...defaultConfig(),
      staleTurns: 0,
      batchCooldownTurns: 5,
      batchMinSavedTokens: 1,
      batchMinNetValue: 0,
    };
    const state = createPruningState();
    const passes: any[] = [];
    const hook = makeContextHook(config, (p) => passes.push(p), state);
    const firstIds = ["batch-cooldown-1", "batch-cooldown-2"];
    const secondIds = ["batch-cooldown-3", "batch-cooldown-4"];
    const makeBatchCandidate = (id: string) => [
      makeAssistantMsg([{ id, name: "grep", arguments: { pattern: id } }]),
      makeToolResultMsg({
        toolCallId: id,
        toolName: "grep",
        text: "s".repeat(300_000),
      }),
    ];
    const firstMessages: any[] = [
      makeUserMsg(),
      ...firstIds.flatMap(makeBatchCandidate),
      makeTextMsg("user", "t".repeat(400_000)),
    ];
    const secondMessages: any[] = [
      ...firstMessages,
      ...secondIds.flatMap(makeBatchCandidate),
      makeTextMsg("user", "u".repeat(400_000)),
    ];

    hook({ type: "context", messages: firstMessages } as any, fakeCtxWithCwd);
    const cooledDown = hook(
      { type: "context", messages: secondMessages } as any,
      fakeCtxWithCwd,
    );

    for (const id of secondIds) {
      const found = cooledDown.messages!.find(
        (m: any) => m.toolCallId === id,
      ) as any;
      expect(found.content[0].text).toBe("s".repeat(300_000));
    }
    expect(passes[1].entries.map((e: any) => e.toolCallId)).not.toEqual(
      expect.arrayContaining(secondIds),
    );

    const emergency = hook(
      { type: "context", messages: secondMessages } as any,
      {
        ...fakeCtxWithCwd,
        getContextUsage: () => ({ tokens: 90_000, contextWindow: 100_000 }),
      } as any,
    );

    for (const id of secondIds) {
      const found = emergency.messages!.find(
        (m: any) => m.toolCallId === id,
      ) as any;
      expect(found.content[0].text).toMatch(/emergency context pressure/);
    }
    expect(passes[2].entries.map((e: any) => e.toolCallId)).toEqual(
      expect.arrayContaining(secondIds),
    );
  });
});

describe("formatSupersededStub", () => {
  it("includes normalized path, original wording, and context_recall", () => {
    const stub = formatSupersededStub({
      toolName: "read",
      normalizedPath: "src/foo.ts",
      tokenCount: 3400,
      toolCallId: "sup-id",
      preview: "some preview",
    });
    expect(stub).toContain("superseded by later edit/write of src/foo.ts");
    expect(stub).toContain("3.4K tokens");
    expect(stub).toContain(
      'Call context_recall("sup-id") to retrieve original.',
    );
    expect(stub).toContain('Preview: "some preview".');
  });
});

describe("formatAfterConsumptionBashStub", () => {
  it("includes command, status, token count, and context_recall", () => {
    const stub = formatAfterConsumptionBashStub({
      tokenCount: 1200,
      toolCallId: "bash-id",
      command: "pnpm test",
      preview: "ok\\nok\\n",
    });
    expect(stub).toContain("bash output compacted after assistant consumption");
    expect(stub).toContain("Command: pnpm test.");
    expect(stub).toContain("Status: success.");
    expect(stub).toContain("1.2K tokens");
    expect(stub).toContain(
      'Call context_recall("bash-id") to retrieve full output.',
    );
    expect(stub).toContain('Preview: "ok\\nok\\n".');
  });

  it("escapes and truncates command text", () => {
    const stub = formatAfterConsumptionBashStub({
      tokenCount: 1200,
      toolCallId: "bash-id-long",
      command: `cat <<'EOF'\n${"x".repeat(200)}\nEOF`,
    });
    const commandSegment = stub.match(/Command: (.*)\. Status:/)?.[1] ?? "";
    expect(commandSegment).toContain("\\n");
    expect(commandSegment).not.toContain("\n");
    expect(commandSegment).toHaveLength(120);
    expect(commandSegment.endsWith("…")).toBe(true);
  });

  it("omits command segment when command is missing", () => {
    const stub = formatAfterConsumptionBashStub({
      tokenCount: 800,
      toolCallId: "bash-id2",
    });
    expect(stub).not.toContain("Command:");
    expect(stub).toContain("bash output compacted");
  });
});

describe("formatBatchPressureStub", () => {
  it("includes batch pruning wording and context_recall", () => {
    const stub = formatBatchPressureStub({
      toolName: "bash",
      tokenCount: 5000,
      toolCallId: "batch-id",
      preview: "build output",
    });
    expect(stub).toContain("compacted by cache-aware batch pruning");
    expect(stub).toContain("5K tokens");
    expect(stub).toContain('Call context_recall("batch-id") to retrieve.');
    expect(stub).toContain('Preview: "build output".');
  });
});

describe("formatEmergencyPressureStub", () => {
  it("includes emergency wording and context_recall", () => {
    const stub = formatEmergencyPressureStub({
      toolName: "read",
      tokenCount: 2100,
      toolCallId: "em-id",
    });
    expect(stub).toContain("emergency context pressure");
    expect(stub).toContain("2.1K tokens");
    expect(stub).toContain('Call context_recall("em-id") to retrieve.');
    expect(stub).not.toContain("Preview:");
  });
});
