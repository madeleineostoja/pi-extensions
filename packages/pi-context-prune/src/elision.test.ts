import { describe, it, expect } from "vitest";
import {
  isEligibleForElision,
  formatTokenCount,
  formatStub,
  formatDuplicateStub,
  extractPreview,
  estimateContentTokens,
  userTurnsAfterEachPosition,
  makeContextHook,
} from "./elision.ts";
import { defaultConfig, DEFAULTS } from "./config.ts";

// Helpers so tests stay robust to threshold changes in DEFAULTS.
// BIG: a char count guaranteed to produce tokenCount > DEFAULTS.minTokens
// SMALL: a char count guaranteed to produce tokenCount < DEFAULTS.minTokens
const BIG = DEFAULTS.minTokens * 4 + 1;
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

describe("formatTokenCount", () => {
  it("formats 0 tokens", () => {
    expect(formatTokenCount(0)).toBe("0 tokens");
  });

  it("formats 1 token", () => {
    expect(formatTokenCount(1)).toBe("1 tokens");
  });

  it("formats 999 tokens", () => {
    expect(formatTokenCount(999)).toBe("999 tokens");
  });

  it("formats 1000 tokens as 1K tokens", () => {
    expect(formatTokenCount(1000)).toBe("1K tokens");
  });

  it("formats 1200 tokens as 1.2K tokens", () => {
    expect(formatTokenCount(1200)).toBe("1.2K tokens");
  });

  it("formats 1500 tokens as 1.5K tokens", () => {
    expect(formatTokenCount(1500)).toBe("1.5K tokens");
  });

  it("formats 10000 tokens as 10K tokens (whole number, no decimal)", () => {
    expect(formatTokenCount(10000)).toBe("10K tokens");
  });

  it("formats 34000 tokens as 34K tokens", () => {
    expect(formatTokenCount(34000)).toBe("34K tokens");
  });

  it("formats 256 tokens as 256 tokens", () => {
    expect(formatTokenCount(256)).toBe("256 tokens");
  });
});

describe("formatStub", () => {
  it("formats stub with sub-1K tokens", () => {
    const result = formatStub({
      toolName: "read",
      tokenCount: 500,
      toolCallId: "abc-123",
    });
    expect(result).toBe(
      '[read result elided: 500 tokens. Call ctx_recall("abc-123") to retrieve.]',
    );
  });

  it("formats stub with K tokens", () => {
    const result = formatStub({
      toolName: "bash",
      tokenCount: 1000,
      toolCallId: "xyz-789",
    });
    expect(result).toBe(
      '[bash result elided: 1K tokens. Call ctx_recall("xyz-789") to retrieve.]',
    );
  });

  it("formats stub with fractional K tokens", () => {
    const result = formatStub({
      toolName: "grep",
      tokenCount: 1500,
      toolCallId: "id-1",
    });
    expect(result).toBe(
      '[grep result elided: 1.5K tokens. Call ctx_recall("id-1") to retrieve.]',
    );
  });

  it("matches the stub regex pattern", () => {
    const result = formatStub({
      toolName: "read",
      tokenCount: 300,
      toolCallId: "tool-call-id-abc",
    });
    expect(result).toMatch(
      /^\[\w+ result elided: (\d+(\.\d+)?K? tokens)\. Call ctx_recall\("[^"]+"\) to retrieve\.\]$/,
    );
  });

  it("includes Preview segment when preview is provided", () => {
    const result = formatStub({
      toolName: "read",
      tokenCount: 300,
      toolCallId: "id-prev",
      preview: "hello world",
    });
    expect(result).toBe(
      '[read result elided: 300 tokens. Preview: "hello world". Call ctx_recall("id-prev") to retrieve.]',
    );
  });

  it("omits Preview segment when preview is null", () => {
    const result = formatStub({
      toolName: "read",
      tokenCount: 300,
      toolCallId: "id-null",
      preview: null,
    });
    expect(result).toBe(
      '[read result elided: 300 tokens. Call ctx_recall("id-null") to retrieve.]',
    );
  });

  it("stub with preview starts with token count and ends with retrieve", () => {
    const result = formatStub({
      toolName: "read",
      tokenCount: 300,
      toolCallId: "id-300",
      preview: "some preview…",
    });
    expect(result).toMatch(
      /^\[read result elided: 300 tokens\. Preview: ".*"\. Call ctx_recall\("id-300"\) to retrieve\.\]$/,
    );
  });
});

describe("extractPreview", () => {
  it("returns null for empty content array", () => {
    expect(extractPreview([])).toBeNull();
  });

  it("returns null for content with only image blocks", () => {
    const content = [
      { type: "image" } as unknown as {
        type: "image";
        data: string;
        mimeType: string;
      },
    ];
    expect(extractPreview(content)).toBeNull();
  });

  it("returns full text when shorter than 100 chars, no ellipsis", () => {
    const content = [{ type: "text" as const, text: "hello world" }];
    expect(extractPreview(content)).toBe("hello world");
  });

  it("returns text with ellipsis when exactly 100 chars (truncated at 100)", () => {
    const text = "a".repeat(101);
    const content = [{ type: "text" as const, text }];
    const result = extractPreview(content);
    expect(result).toBe("a".repeat(100) + "…");
  });

  it("returns full text without ellipsis when exactly 100 chars", () => {
    const text = "a".repeat(100);
    const content = [{ type: "text" as const, text }];
    const result = extractPreview(content);
    expect(result).toBe("a".repeat(100));
  });

  it("joins multiple text blocks with newline before slicing", () => {
    const content = [
      { type: "text" as const, text: "foo" },
      { type: "text" as const, text: "bar" },
    ];
    expect(extractPreview(content)).toBe("foo\\nbar");
  });

  it("escapes newlines as \\n", () => {
    const content = [{ type: "text" as const, text: "line1\nline2" }];
    expect(extractPreview(content)).toBe("line1\\nline2");
  });

  it('escapes double quotes as \\"', () => {
    const content = [{ type: "text" as const, text: 'say "hello"' }];
    expect(extractPreview(content)).toBe('say \\"hello\\"');
  });

  it("escapes backslashes as \\\\", () => {
    const content = [{ type: "text" as const, text: "path\\to\\file" }];
    expect(extractPreview(content)).toBe("path\\\\to\\\\file");
  });

  it("escapes tabs as \\t", () => {
    const content = [{ type: "text" as const, text: "col1\tcol2" }];
    expect(extractPreview(content)).toBe("col1\\tcol2");
  });

  it("escapes backslashes before other characters (order matters)", () => {
    const content = [{ type: "text" as const, text: '\\"' }];
    expect(extractPreview(content)).toBe('\\\\\\"');
  });

  it("slices to 100 raw chars before escaping (escaping may expand length)", () => {
    const text = "\n".repeat(101);
    const content = [{ type: "text" as const, text }];
    const result = extractPreview(content);
    expect(result).toBe("\\n".repeat(100) + "…");
  });
});

describe("estimateContentTokens", () => {
  it("returns 0 for empty content", () => {
    expect(estimateContentTokens([])).toBe(0);
  });

  it("estimates tokens for a single text block (ceil(chars/4))", () => {
    const content = [{ type: "text" as const, text: "hello" }];
    expect(estimateContentTokens(content)).toBe(Math.ceil("hello".length / 4));
  });

  it("sums chars across multiple text blocks", () => {
    const content = [
      { type: "text" as const, text: "hello" },
      { type: "text" as const, text: " world" },
    ];
    expect(estimateContentTokens(content)).toBe(Math.ceil(11 / 4));
  });

  it("counts image blocks as zero tokens", () => {
    const content = [
      { type: "image" } as unknown as {
        type: "image";
        data: string;
        mimeType: string;
      },
    ];
    expect(estimateContentTokens(content)).toBe(0);
  });

  it("handles mixed text and image blocks", () => {
    const content = [
      { type: "text" as const, text: "abc" },
      { type: "image" } as unknown as {
        type: "image";
        data: string;
        mimeType: string;
      },
    ];
    expect(estimateContentTokens(content)).toBe(Math.ceil(3 / 4));
  });

  it("counts multibyte chars as char units, not byte units", () => {
    const text = "こんにちは"; // 5 chars, 15 UTF-8 bytes
    const content = [{ type: "text" as const, text }];
    expect(estimateContentTokens(content)).toBe(Math.ceil(5 / 4));
  });

  it("returns a value large enough to exceed minTokens when chars >> 4*minTokens", () => {
    const text = "x".repeat(DEFAULTS.minTokens * 4 + 4);
    const content = [{ type: "text" as const, text }];
    expect(estimateContentTokens(content)).toBeGreaterThan(DEFAULTS.minTokens);
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

  it("elides a large, old tool result", () => {
    const toolResult = makeToolResult({
      toolCallId: "call-abc",
      toolName: "read",
      text: "x",
      repeat: BIG,
    });
    const messages = makeMessages(DEFAULTS.staleTurns + 1, toolResult);
    const result = hook({ type: "context", messages } as any, fakeCtx);
    const elided = result.messages!.find(
      (m: any) => m.role === "toolResult",
    ) as any;
    expect(elided.content[0].text).toMatch(/^\[read result elided:/);
    expect(elided.content[0].text).toMatch(
      /Call ctx_recall\("call-abc"\) to retrieve\.\]$/,
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
      repeat: BIG,
    });
    const messages = makeMessages(DEFAULTS.staleTurns - 1, toolResult);
    const result = hook({ type: "context", messages } as any, fakeCtx);
    const found = result.messages!.find(
      (m: any) => m.role === "toolResult",
    ) as any;
    expect(found.content[0].text).toBe("x".repeat(BIG));
  });

  it("does not elide a tool result with isError: true even when large and old", () => {
    const toolResult = makeToolResult({
      toolCallId: "call-err",
      toolName: "bash",
      text: "x",
      repeat: BIG,
      isError: true,
    });
    const messages = makeMessages(DEFAULTS.staleTurns + 5, toolResult);
    const result = hook({ type: "context", messages } as any, fakeCtx);
    const found = result.messages!.find(
      (m: any) => m.role === "toolResult",
    ) as any;
    expect(found.content[0].text).toBe("x".repeat(BIG));
  });

  it("is deterministic: two calls on identical input produce identical output", () => {
    const toolResult = makeToolResult({
      toolCallId: "call-det",
      toolName: "bash",
      text: "y",
      repeat: BIG,
    });
    const messages = makeMessages(DEFAULTS.staleTurns + 2, toolResult);
    const r1 = hook({ type: "context", messages } as any, fakeCtx);
    const r2 = hook({ type: "context", messages } as any, fakeCtx);
    expect(r1).toEqual(r2);
  });

  it("does not mutate the input messages array", () => {
    const toolResult = makeToolResult({
      toolCallId: "call-mut",
      toolName: "read",
      text: "z",
      repeat: BIG,
    });
    const messages = makeMessages(DEFAULTS.staleTurns + 1, toolResult);
    const originalContent = JSON.stringify(messages);
    hook({ type: "context", messages } as any, fakeCtx);
    expect(JSON.stringify(messages)).toBe(originalContent);
  });

  it("non-elided messages are the same object references as the input messages", () => {
    const elidedToolResult = makeToolResult({
      toolCallId: "call-elided-ref",
      toolName: "read",
      text: "x",
      repeat: BIG,
    });
    const keptToolResult = makeToolResult({
      toolCallId: "call-kept-ref",
      toolName: "read",
      text: "small",
    });
    const messages: any[] = [
      makeUserMsg(),
      elidedToolResult,
      makeUserMsg(),
      makeUserMsg(),
      makeUserMsg(),
      makeUserMsg(),
      keptToolResult,
      makeUserMsg(),
    ];
    const result = hook({ type: "context", messages } as any, fakeCtx);
    for (let i = 0; i < result.messages!.length; i++) {
      const out = result.messages![i] as any;
      if (out.role === "toolResult" && out.toolCallId === "call-elided-ref") {
        continue;
      }
      expect(result.messages![i]).toBe(messages[i]);
    }
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

  it("passes through non-tool-result messages unchanged", () => {
    const toolResult = makeToolResult({
      toolCallId: "call-pass",
      toolName: "read",
      text: "a",
      repeat: BIG,
    });
    const messages = makeMessages(DEFAULTS.staleTurns + 1, toolResult);
    const result = hook({ type: "context", messages } as any, fakeCtx);
    const userMsgs = result.messages!.filter((m: any) => m.role === "user");
    expect(userMsgs.length).toBe(DEFAULTS.staleTurns + 1);
  });

  it("uses 'unknown' toolName when toolName is missing", () => {
    const toolResult: any = {
      role: "toolResult",
      toolCallId: "call-no-name",
      toolName: undefined,
      content: [{ type: "text", text: "x".repeat(BIG) }],
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

  it("stub text matches spec regex", () => {
    const toolResult = makeToolResult({
      toolCallId: "call-regex",
      toolName: "read",
      text: "x",
      repeat: BIG,
    });
    const messages = makeMessages(DEFAULTS.staleTurns + 1, toolResult);
    const result = hook({ type: "context", messages } as any, fakeCtx);
    const elided = result.messages!.find(
      (m: any) => m.role === "toolResult",
    ) as any;
    expect(elided.content[0].text).toMatch(
      /^\[\w+ result elided: (\d+(\.\d+)?K? tokens)\. Preview: "[^"]*"\. Call ctx_recall\("[^"]+"\) to retrieve\.\]$/,
    );
  });

  it("elided message does not carry forward details from the source", () => {
    const toolResult: any = {
      role: "toolResult",
      toolCallId: "call-details",
      toolName: "read",
      content: [{ type: "text", text: "x".repeat(BIG) }],
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

  it("stub includes Preview segment for text content", () => {
    const toolResult = makeToolResult({
      toolCallId: "call-preview",
      toolName: "read",
      text: "x",
      repeat: BIG,
    });
    const messages = makeMessages(DEFAULTS.staleTurns + 1, toolResult);
    const result = hook({ type: "context", messages } as any, fakeCtx);
    const elided = result.messages!.find(
      (m: any) => m.role === "toolResult",
    ) as any;
    expect(elided.content[0].text).toContain(' Preview: "');
  });

  it("stub preview is truncated to 100 chars with ellipsis", () => {
    const toolResult = makeToolResult({
      toolCallId: "call-preview-trunc",
      toolName: "read",
      text: "y",
      repeat: BIG,
    });
    const messages = makeMessages(DEFAULTS.staleTurns + 1, toolResult);
    const result = hook({ type: "context", messages } as any, fakeCtx);
    const elided = result.messages!.find(
      (m: any) => m.role === "toolResult",
    ) as any;
    expect(elided.content[0].text).toContain('"' + "y".repeat(100) + "…" + '"');
  });

  it("stub preview escapes special characters", () => {
    const specialText = 'line1\nline2\t"quoted"\\back';
    const padding = "p".repeat(DEFAULTS.minTokens * 4);
    const toolResult: any = {
      role: "toolResult",
      toolCallId: "call-escape",
      toolName: "read",
      content: [{ type: "text", text: specialText + padding }],
      isError: false,
      timestamp: Date.now(),
    };
    const messages = makeMessages(DEFAULTS.staleTurns + 1, toolResult);
    const result = hook({ type: "context", messages } as any, fakeCtx);
    const elided = result.messages!.find(
      (m: any) => m.role === "toolResult",
    ) as any;
    const stub: string = elided.content[0].text;
    expect(stub).toContain("\\n");
    expect(stub).toContain("\\t");
    expect(stub).toContain('\\"');
    expect(stub).toContain("\\\\");
  });

  it("elided message has exactly the canonical keys", () => {
    const toolResult = makeToolResult({
      toolCallId: "call-keys",
      toolName: "read",
      text: "x",
      repeat: BIG,
    });
    const messages = makeMessages(DEFAULTS.staleTurns + 1, toolResult);
    const result = hook({ type: "context", messages } as any, fakeCtx);
    const elided = result.messages!.find(
      (m: any) => m.role === "toolResult",
    ) as any;
    expect(Object.keys(elided).sort()).toEqual([
      "content",
      "isError",
      "role",
      "timestamp",
      "toolCallId",
      "toolName",
    ]);
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
      /Call ctx_recall\("read-1"\) to retrieve original\.\]$/,
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

  it("stub starts with correct prefix and ends with retrieve original suffix", () => {
    const readId = "read-fmt";
    const editId = "edit-fmt";
    const messages: any[] = [
      makeUserMsg(),
      makeAssistantMsg([
        { id: readId, name: "read", arguments: { path: "src/foo.ts" } },
      ]),
      makeToolResultMsg({
        toolCallId: readId,
        toolName: "read",
        text: "content here",
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
    const text: string = readResult.content[0].text;
    expect(text).toMatch(
      /^\[read result elided \(superseded by later edit\/write of \/cwd\/src\/foo\.ts\):/,
    );
    expect(text).toMatch(
      /Call ctx_recall\("read-fmt"\) to retrieve original\.\]$/,
    );
  });

  it("stub includes Preview segment when read had text content", () => {
    const readId = "read-prev";
    const editId = "edit-prev";
    const messages: any[] = [
      makeUserMsg(),
      makeAssistantMsg([
        { id: readId, name: "read", arguments: { path: "src/foo.ts" } },
      ]),
      makeToolResultMsg({
        toolCallId: readId,
        toolName: "read",
        text: "hello world content",
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
    expect(readResult.content[0].text).toContain(
      ' Preview: "hello world content".',
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

  it("is deterministic: two calls on same message list produce identical output", () => {
    const readId = "read-det";
    const editId = "edit-det";
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
    const hook = makeContextHook(supersededConfig());
    const r1 = hook({ type: "context", messages } as any, fakeCtxWithCwd);
    const r2 = hook({ type: "context", messages } as any, fakeCtxWithCwd);
    expect(r1).toEqual(r2);
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
      '[read result elided (superseded by later read of /cwd/src/foo.ts at turn 3): 125 tokens. Call ctx_recall("read-1") to retrieve.]',
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

  it("stub starts with correct prefix including path and turn number", () => {
    const readId1 = "prefix-read-1";
    const readId2 = "prefix-read-2";
    const messages: any[] = [
      makeUserMsg(),
      makeAssistantMsg([
        { id: readId1, name: "read", arguments: { path: "src/foo.ts" } },
      ]),
      makeToolResultMsg({
        toolCallId: readId1,
        toolName: "read",
        text: "content",
      }),
      makeUserMsg(),
      makeAssistantMsg([
        { id: readId2, name: "read", arguments: { path: "src/foo.ts" } },
      ]),
      makeToolResultMsg({
        toolCallId: readId2,
        toolName: "read",
        text: "newer content",
      }),
    ];
    const hook = makeContextHook(duplicateConfig());
    const result = hook({ type: "context", messages } as any, fakeCtxWithCwd);
    const read1 = result.messages!.find(
      (m: any) => m.toolCallId === readId1,
    ) as any;
    expect(read1.content[0].text).toMatch(
      /^\[read result elided \(superseded by later read of \/cwd\/src\/foo\.ts at turn \d+\):/,
    );
  });

  it("stub includes Preview segment when read had text content", () => {
    const readId1 = "prev-read-1";
    const readId2 = "prev-read-2";
    const messages: any[] = [
      makeUserMsg(),
      makeAssistantMsg([
        { id: readId1, name: "read", arguments: { path: "src/foo.ts" } },
      ]),
      makeToolResultMsg({
        toolCallId: readId1,
        toolName: "read",
        text: "hello world content",
      }),
      makeUserMsg(),
      makeAssistantMsg([
        { id: readId2, name: "read", arguments: { path: "src/foo.ts" } },
      ]),
      makeToolResultMsg({
        toolCallId: readId2,
        toolName: "read",
        text: "newer",
      }),
    ];
    const hook = makeContextHook(duplicateConfig());
    const result = hook({ type: "context", messages } as any, fakeCtxWithCwd);
    const read1 = result.messages!.find(
      (m: any) => m.toolCallId === readId1,
    ) as any;
    expect(read1.content[0].text).toContain(' Preview: "hello world content".');
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

  it("the turn-N reference points to the most recent read's user-turn index (1-indexed)", () => {
    const readId1 = "turn-read-1";
    const readId2 = "turn-read-2";
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
    const hook = makeContextHook(duplicateConfig());
    const result = hook({ type: "context", messages } as any, fakeCtxWithCwd);
    const read1 = result.messages!.find(
      (m: any) => m.toolCallId === readId1,
    ) as any;
    // read2's toolResult is at index 6, user msgs at 0,3,4 → userTurnsUpTo(6) = 3
    expect(read1.content[0].text).toMatch(/at turn 3\)/);
  });

  it("is deterministic: two calls on same input produce identical output", () => {
    const readId1 = "det-read-1";
    const readId2 = "det-read-2";
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
    const hook = makeContextHook(duplicateConfig());
    const r1 = hook({ type: "context", messages } as any, fakeCtxWithCwd);
    const r2 = hook({ type: "context", messages } as any, fakeCtxWithCwd);
    expect(r1).toEqual(r2);
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
