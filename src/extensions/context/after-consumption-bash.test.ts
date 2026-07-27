import { describe, it, expect } from "vitest";
import { makeContextHook } from "./elision.ts";
import { defaultConfig } from "./config.ts";
import { createPruningState } from "./policy.ts";
import { registerRecallTool } from "./recall.ts";

const BIG = 8_000;

function makeUserMsg(text = "hello"): any {
  return {
    role: "user",
    content: [{ type: "text", text }],
    timestamp: Date.now(),
  };
}

function makeAssistantMsg(
  toolCalls: Array<{
    id: string;
    name: string;
    arguments: Record<string, unknown>;
  }>,
): any {
  return {
    role: "assistant",
    content: toolCalls.map((tc) => ({
      type: "toolCall",
      id: tc.id,
      name: tc.name,
      arguments: tc.arguments,
    })),
    timestamp: Date.now(),
  };
}

function makeBashResult(
  toolCallId: string,
  text: string,
  isError = false,
): any {
  return {
    role: "toolResult",
    toolCallId,
    toolName: "bash",
    content: [{ type: "text", text }],
    isError,
    timestamp: Date.now(),
  };
}

function makeReadResult(toolCallId: string, text: string): any {
  return {
    role: "toolResult",
    toolCallId,
    toolName: "read",
    content: [{ type: "text", text }],
    isError: false,
    timestamp: Date.now(),
  };
}

function bashConfig() {
  return {
    ...defaultConfig(),
    afterConsumptionBashEnabled: true,
    supersededReadsEnabled: false,
    duplicateReadsEnabled: false,
  };
}

function bashDisabledConfig() {
  return {
    ...defaultConfig(),
    afterConsumptionBashEnabled: false,
    supersededReadsEnabled: false,
    duplicateReadsEnabled: false,
  };
}

describe("after-consumption bash compaction", () => {
  it("compacts a large successful bash result when there is a later assistant", () => {
    const hook = makeContextHook(bashConfig());
    const text = "ok\n".repeat(BIG);
    const messages: any[] = [
      makeUserMsg(),
      makeAssistantMsg([
        { id: "bash-1", name: "bash", arguments: { command: "pnpm test" } },
      ]),
      makeBashResult("bash-1", text),
      makeUserMsg(),
      makeAssistantMsg([]),
    ];
    const result = hook({ type: "context", messages } as any, {} as any);
    const bash = result.messages!.find(
      (m: any) => m.toolCallId === "bash-1",
    ) as any;
    expect(bash.content[0].text).toMatch(
      /bash output compacted after assistant consumption/,
    );
    expect(bash.content[0].text).toMatch(/Command: pnpm test/);
    expect(bash.content[0].text).toMatch(/Status: success/);
    expect(bash.content[0].text).toMatch(
      /Call context_recall\("bash-1"\) to retrieve full output/,
    );
  });

  it("does NOT compact a bash result without a later assistant message", () => {
    const hook = makeContextHook(bashConfig());
    const text = "ok\n".repeat(BIG);
    const messages: any[] = [
      makeUserMsg(),
      makeAssistantMsg([
        { id: "bash-1", name: "bash", arguments: { command: "pnpm test" } },
      ]),
      makeBashResult("bash-1", text),
      makeUserMsg(),
    ];
    const result = hook({ type: "context", messages } as any, {} as any);
    const bash = result.messages!.find(
      (m: any) => m.toolCallId === "bash-1",
    ) as any;
    expect(bash.content[0].text).toBe(text);
  });

  it("does NOT compact bash results with isError: true", () => {
    const hook = makeContextHook(bashConfig());
    const text = "error\n".repeat(BIG);
    const messages: any[] = [
      makeUserMsg(),
      makeAssistantMsg([
        { id: "bash-err", name: "bash", arguments: { command: "exit 1" } },
      ]),
      makeBashResult("bash-err", text, true),
      makeUserMsg(),
      makeAssistantMsg([]),
    ];
    const result = hook({ type: "context", messages } as any, {} as any);
    const bash = result.messages!.find(
      (m: any) => m.toolCallId === "bash-err",
    ) as any;
    expect(bash.content[0].text).toBe(text);
  });

  it("does not require a hardcoded command list; eligibility is content/status/shape based", () => {
    const hook = makeContextHook(bashConfig());
    const text = "line\n".repeat(BIG);
    const messages: any[] = [
      makeUserMsg(),
      makeAssistantMsg([
        { id: "bash-2", name: "bash", arguments: { command: "xyzzy --magic" } },
      ]),
      makeBashResult("bash-2", text),
      makeUserMsg(),
      makeAssistantMsg([]),
    ];
    const result = hook({ type: "context", messages } as any, {} as any);
    const bash = result.messages!.find(
      (m: any) => m.toolCallId === "bash-2",
    ) as any;
    expect(bash.content[0].text).toMatch(/bash output compacted/);
  });

  it("rejects successful-looking output containing Traceback", () => {
    const hook = makeContextHook(bashConfig());
    const text =
      "ok\n".repeat(200) +
      "Traceback (most recent call last):\n" +
      "ok\n".repeat(200);
    const messages: any[] = [
      makeUserMsg(),
      makeAssistantMsg([
        { id: "bash-3", name: "bash", arguments: { command: "python run.py" } },
      ]),
      makeBashResult("bash-3", text),
      makeUserMsg(),
      makeAssistantMsg([]),
    ];
    const result = hook({ type: "context", messages } as any, {} as any);
    const bash = result.messages!.find(
      (m: any) => m.toolCallId === "bash-3",
    ) as any;
    expect(bash.content[0].text).toBe(text);
  });

  it("rejects successful-looking output containing FAILED", () => {
    const hook = makeContextHook(bashConfig());
    const text = "ok\n".repeat(200) + "FAILED\n" + "ok\n".repeat(200);
    const messages: any[] = [
      makeUserMsg(),
      makeAssistantMsg([
        { id: "bash-4", name: "bash", arguments: { command: "pytest" } },
      ]),
      makeBashResult("bash-4", text),
      makeUserMsg(),
      makeAssistantMsg([]),
    ];
    const result = hook({ type: "context", messages } as any, {} as any);
    const bash = result.messages!.find(
      (m: any) => m.toolCallId === "bash-4",
    ) as any;
    expect(bash.content[0].text).toBe(text);
  });

  it("rejects successful-looking output containing panic:", () => {
    const hook = makeContextHook(bashConfig());
    const text =
      "ok\n".repeat(200) + "panic: runtime error\n" + "ok\n".repeat(200);
    const messages: any[] = [
      makeUserMsg(),
      makeAssistantMsg([
        { id: "bash-5", name: "bash", arguments: { command: "go run ." } },
      ]),
      makeBashResult("bash-5", text),
      makeUserMsg(),
      makeAssistantMsg([]),
    ];
    const result = hook({ type: "context", messages } as any, {} as any);
    const bash = result.messages!.find(
      (m: any) => m.toolCallId === "bash-5",
    ) as any;
    expect(bash.content[0].text).toBe(text);
  });

  it("accepts large repetitive log-like successful output with no failure markers", () => {
    const hook = makeContextHook(bashConfig());
    const text = Array.from(
      { length: 240 },
      (_, i) => `Building step ${i + 1}...`,
    ).join("\n");
    const messages: any[] = [
      makeUserMsg(),
      makeAssistantMsg([
        { id: "bash-6", name: "bash", arguments: { command: "npm run build" } },
      ]),
      makeBashResult("bash-6", text),
      makeUserMsg(),
      makeAssistantMsg([]),
    ];
    const result = hook({ type: "context", messages } as any, {} as any);
    const bash = result.messages!.find(
      (m: any) => m.toolCallId === "bash-6",
    ) as any;
    expect(bash.content[0].text).toMatch(/bash output compacted/);
  });

  it("leaves tiny bash outputs raw (below minSavedTokens)", () => {
    const hook = makeContextHook(bashConfig());
    const text = "tiny output\n"; // far below minTokens
    const messages: any[] = [
      makeUserMsg(),
      makeAssistantMsg([
        { id: "bash-7", name: "bash", arguments: { command: "echo hi" } },
      ]),
      makeBashResult("bash-7", text),
      makeUserMsg(),
      makeAssistantMsg([]),
    ];
    const result = hook({ type: "context", messages } as any, {} as any);
    const bash = result.messages!.find(
      (m: any) => m.toolCallId === "bash-7",
    ) as any;
    expect(bash.content[0].text).toBe(text);
  });

  it("stub includes command text when recoverable", () => {
    const hook = makeContextHook(bashConfig());
    const text = "ok\n".repeat(BIG);
    const messages: any[] = [
      makeUserMsg(),
      makeAssistantMsg([
        {
          id: "bash-8",
          name: "bash",
          arguments: { command: "ls -la /tmp" },
        },
      ]),
      makeBashResult("bash-8", text),
      makeUserMsg(),
      makeAssistantMsg([]),
    ];
    const result = hook({ type: "context", messages } as any, {} as any);
    const bash = result.messages!.find(
      (m: any) => m.toolCallId === "bash-8",
    ) as any;
    expect(bash.content[0].text).toContain("Command: ls -la /tmp");
  });

  it("stub omits command segment when command is not recoverable", () => {
    const hook = makeContextHook(bashConfig());
    const text = "ok\n".repeat(BIG);
    const messages: any[] = [
      makeUserMsg(),
      makeAssistantMsg([{ id: "bash-9", name: "bash", arguments: {} }]),
      makeBashResult("bash-9", text),
      makeUserMsg(),
      makeAssistantMsg([]),
    ];
    const result = hook({ type: "context", messages } as any, {} as any);
    const bash = result.messages!.find(
      (m: any) => m.toolCallId === "bash-9",
    ) as any;
    expect(bash.content[0].text).not.toContain("Command:");
    expect(bash.content[0].text).toMatch(/bash output compacted/);
  });

  it("stub includes success wording", () => {
    const hook = makeContextHook(bashConfig());
    const text = "ok\n".repeat(BIG);
    const messages: any[] = [
      makeUserMsg(),
      makeAssistantMsg([
        { id: "bash-10", name: "bash", arguments: { command: "echo hi" } },
      ]),
      makeBashResult("bash-10", text),
      makeUserMsg(),
      makeAssistantMsg([]),
    ];
    const result = hook({ type: "context", messages } as any, {} as any);
    const bash = result.messages!.find(
      (m: any) => m.toolCallId === "bash-10",
    ) as any;
    expect(bash.content[0].text).toContain("Status: success");
  });

  it("stub includes token count", () => {
    const hook = makeContextHook(bashConfig());
    const text = "ok\n".repeat(BIG);
    const messages: any[] = [
      makeUserMsg(),
      makeAssistantMsg([
        { id: "bash-11", name: "bash", arguments: { command: "echo hi" } },
      ]),
      makeBashResult("bash-11", text),
      makeUserMsg(),
      makeAssistantMsg([]),
    ];
    const result = hook({ type: "context", messages } as any, {} as any);
    const bash = result.messages!.find(
      (m: any) => m.toolCallId === "bash-11",
    ) as any;
    expect(bash.content[0].text).toMatch(/\d+K? tokens/);
  });

  it("stub includes preview of original content", () => {
    const hook = makeContextHook(bashConfig());
    const text = "PREFIX " + "ok\n".repeat(BIG);
    const messages: any[] = [
      makeUserMsg(),
      makeAssistantMsg([
        { id: "bash-12", name: "bash", arguments: { command: "echo hi" } },
      ]),
      makeBashResult("bash-12", text),
      makeUserMsg(),
      makeAssistantMsg([]),
    ];
    const result = hook({ type: "context", messages } as any, {} as any);
    const bash = result.messages!.find(
      (m: any) => m.toolCallId === "bash-12",
    ) as any;
    expect(bash.content[0].text).toContain("Preview:");
  });

  it("does not compact when the stub would not save tokens", () => {
    const hook = makeContextHook({ ...bashConfig(), minTokens: 1 });
    const text = "ok\n".repeat(50);
    const messages: any[] = [
      makeUserMsg(),
      makeAssistantMsg([
        { id: "bash-no-save", name: "bash", arguments: { command: "echo hi" } },
      ]),
      makeBashResult("bash-no-save", text),
      makeUserMsg(),
      makeAssistantMsg([]),
    ];
    const result = hook({ type: "context", messages } as any, {} as any);
    const bash = result.messages!.find(
      (m: any) => m.toolCallId === "bash-no-save",
    ) as any;
    expect(bash.content[0].text).toBe(text);
  });

  it("raw output remains recallable via context_recall", () => {
    const hook = makeContextHook(bashConfig());
    const originalText = "recallable content here\n".repeat(BIG);
    const messages: any[] = [
      makeUserMsg(),
      makeAssistantMsg([
        { id: "bash-13", name: "bash", arguments: { command: "echo hi" } },
      ]),
      makeBashResult("bash-13", originalText),
      makeUserMsg(),
      makeAssistantMsg([]),
    ];
    const result = hook({ type: "context", messages } as any, {} as any);
    const bash = result.messages!.find(
      (m: any) => m.toolCallId === "bash-13",
    ) as any;
    expect(bash.content[0].text).toMatch(/context_recall\("bash-13"\)/);

    // The session entry mock is not available in this unit test,
    // but the stub explicitly advertises the correct toolCallId for recall.
    expect(bash.toolCallId).toBe("bash-13");
  });

  it("recalls original raw bash content after after-consumption compaction", async () => {
    const hook = makeContextHook(bashConfig());
    const originalText = "original bash output\n".repeat(BIG);
    const messages: any[] = [
      makeUserMsg(),
      makeAssistantMsg([
        {
          id: "bash-recall",
          name: "bash",
          arguments: { command: "echo hi" },
        },
      ]),
      makeBashResult("bash-recall", originalText),
      makeUserMsg(),
      makeAssistantMsg([]),
    ];
    const result = hook({ type: "context", messages } as any, {} as any);
    const bash = result.messages!.find(
      (m: any) => m.toolCallId === "bash-recall",
    ) as any;
    expect(bash.content[0].text).toMatch(/bash output compacted/);

    const entries = [
      {
        type: "message" as const,
        id: "entry-bash-recall",
        parentId: null,
        timestamp: new Date().toISOString(),
        message: {
          role: "toolResult",
          toolCallId: "bash-recall",
          toolName: "bash",
          content: [{ type: "text", text: originalText }],
          isError: false,
          timestamp: Date.now(),
        },
      },
    ];

    let capturedDef: any = null;
    const fakePI = {
      registerTool(def: any) {
        capturedDef = def;
      },
    };

    registerRecallTool(fakePI as any);

    const recallResult = await capturedDef.execute(
      "recall-id",
      { id: "bash-recall" },
      undefined,
      undefined,
      {
        sessionManager: {
          getEntries: () => entries,
        },
      },
    );

    expect(recallResult.isError).toBeFalsy();
    expect(recallResult.content).toEqual([
      { type: "text", text: originalText },
    ]);
  });

  it("latches after-consumption-bash reason and preserves it across passes", () => {
    const state = createPruningState();
    const hook = makeContextHook(bashConfig(), undefined, state);
    const text = "ok\n".repeat(BIG);
    const messages: any[] = [
      makeUserMsg(),
      makeAssistantMsg([
        { id: "bash-14", name: "bash", arguments: { command: "echo hi" } },
      ]),
      makeBashResult("bash-14", text),
      makeUserMsg(),
      makeAssistantMsg([]),
    ];

    const r1 = hook({ type: "context", messages } as any, {} as any);
    expect(state.latched.get("bash-14")?.reason).toBe("after-consumption-bash");

    const r2 = hook({ type: "context", messages } as any, {} as any);
    expect(r1).toEqual(r2);
  });

  it("does not compact bash when afterConsumptionBashEnabled is false", () => {
    const hook = makeContextHook(bashDisabledConfig());
    const text = "ok\n".repeat(BIG);
    const messages: any[] = [
      makeUserMsg(),
      makeAssistantMsg([
        { id: "bash-15", name: "bash", arguments: { command: "echo hi" } },
      ]),
      makeBashResult("bash-15", text),
      makeUserMsg(),
      makeAssistantMsg([]),
    ];
    const result = hook({ type: "context", messages } as any, {} as any);
    const bash = result.messages!.find(
      (m: any) => m.toolCallId === "bash-15",
    ) as any;
    expect(bash.content[0].text).toBe(text);
  });

  it("does not compact read tool results via after-consumption rule", () => {
    const hook = makeContextHook(bashConfig());
    const text = "ok\n".repeat(BIG);
    const messages: any[] = [
      makeUserMsg(),
      makeAssistantMsg([
        { id: "read-1", name: "read", arguments: { path: "/tmp/foo.txt" } },
      ]),
      makeReadResult("read-1", text),
      makeUserMsg(),
      makeAssistantMsg([]),
    ];
    const result = hook({ type: "context", messages } as any, {} as any);
    const read = result.messages!.find(
      (m: any) => m.toolCallId === "read-1",
    ) as any;
    expect(read.content[0].text).toBe(text);
  });

  it("rejects output that looks source-like (>30% source-like lines)", () => {
    const hook = makeContextHook(bashConfig());
    // 60 lines, ~40 are source-like => ~66% ratio
    const lines: string[] = [];
    for (let i = 0; i < 20; i++) {
      lines.push(`log line ${i}`);
    }
    for (let i = 0; i < 40; i++) {
      lines.push(`import { foo${i} } from "bar";`);
    }
    const text = lines.join("\n");
    const messages: any[] = [
      makeUserMsg(),
      makeAssistantMsg([
        { id: "bash-src", name: "bash", arguments: { command: "cat src" } },
      ]),
      makeBashResult("bash-src", text),
      makeUserMsg(),
      makeAssistantMsg([]),
    ];
    const result = hook({ type: "context", messages } as any, {} as any);
    const bash = result.messages!.find(
      (m: any) => m.toolCallId === "bash-src",
    ) as any;
    expect(bash.content[0].text).toBe(text);
  });

  it("accepts output with prefix repetition signal", () => {
    const hook = makeContextHook(bashConfig());
    const lines = Array.from(
      { length: 240 },
      (_, i) => `  [step ${i + 1}] building...`,
    );
    const text = lines.join("\n");
    const messages: any[] = [
      makeUserMsg(),
      makeAssistantMsg([
        {
          id: "bash-rep",
          name: "bash",
          arguments: { command: "npm run build" },
        },
      ]),
      makeBashResult("bash-rep", text),
      makeUserMsg(),
      makeAssistantMsg([]),
    ];
    const result = hook({ type: "context", messages } as any, {} as any);
    const bash = result.messages!.find(
      (m: any) => m.toolCallId === "bash-rep",
    ) as any;
    expect(bash.content[0].text).toMatch(/bash output compacted/);
  });

  it("rejects output without any positive log/noise signal", () => {
    const hook = makeContextHook(bashConfig());
    // 20 unique nonblank lines, no repetition, < 5000 tokens
    const lines = Array.from(
      { length: 20 },
      (_, i) => `unique line ${i + 1} ${"x".repeat(10)}`,
    );
    const text = lines.join("\n");
    const messages: any[] = [
      makeUserMsg(),
      makeAssistantMsg([
        { id: "bash-quiet", name: "bash", arguments: { command: "echo hi" } },
      ]),
      makeBashResult("bash-quiet", text),
      makeUserMsg(),
      makeAssistantMsg([]),
    ];
    const result = hook({ type: "context", messages } as any, {} as any);
    const bash = result.messages!.find(
      (m: any) => m.toolCallId === "bash-quiet",
    ) as any;
    expect(bash.content[0].text).toBe(text);
  });

  it("reports after-consumption-bash in elision pass stats", () => {
    const passes: any[] = [];
    const hook = makeContextHook(bashConfig(), (result) => passes.push(result));
    const text = "ok\n".repeat(BIG);
    const messages: any[] = [
      makeUserMsg(),
      makeAssistantMsg([
        { id: "bash-stat", name: "bash", arguments: { command: "echo hi" } },
      ]),
      makeBashResult("bash-stat", text),
      makeUserMsg(),
      makeAssistantMsg([]),
    ];
    hook({ type: "context", messages } as any, {} as any);
    expect(passes).toHaveLength(1);
    const entry = passes[0].entries.find(
      (e: any) => e.toolCallId === "bash-stat",
    );
    expect(entry).toBeDefined();
    expect(entry.reason).toBe("after-consumption-bash");
    expect(entry.savedTokens).toBeGreaterThan(0);
  });

  it("compacts a consumed successful bash output around 600 estimated tokens", () => {
    const hook = makeContextHook(bashConfig());
    // 800 * 3 = 2400 chars => 600 tokens, above the 512 threshold
    const text = "ok\n".repeat(800);
    const messages: any[] = [
      makeUserMsg(),
      makeAssistantMsg([
        { id: "bash-600", name: "bash", arguments: { command: "echo hi" } },
      ]),
      makeBashResult("bash-600", text),
      makeUserMsg(),
      makeAssistantMsg([]),
    ];
    const result = hook({ type: "context", messages } as any, {} as any);
    const bash = result.messages!.find(
      (m: any) => m.toolCallId === "bash-600",
    ) as any;
    expect(bash.content[0].text).toMatch(/bash output compacted/);
  });

  it("does not compact a consumed bash output below 512 estimated tokens", () => {
    const hook = makeContextHook(bashConfig());
    // 400 * 3 = 1200 chars => 300 tokens, below the 512 threshold
    const text = "ok\n".repeat(400);
    const messages: any[] = [
      makeUserMsg(),
      makeAssistantMsg([
        { id: "bash-300", name: "bash", arguments: { command: "echo hi" } },
      ]),
      makeBashResult("bash-300", text),
      makeUserMsg(),
      makeAssistantMsg([]),
    ];
    const result = hook({ type: "context", messages } as any, {} as any);
    const bash = result.messages!.find(
      (m: any) => m.toolCallId === "bash-300",
    ) as any;
    expect(bash.content[0].text).toBe(text);
  });

  it("rejects source-like bash output above 512 estimated tokens", () => {
    const hook = makeContextHook(bashConfig());
    // Mix log and source lines to exceed 512 tokens while keeping >30% source-like
    const lines: string[] = [];
    for (let i = 0; i < 100; i++) {
      lines.push(`log line ${i}`);
    }
    for (let i = 0; i < 250; i++) {
      lines.push(`import { foo${i} } from "bar";`);
    }
    const text = lines.join("\n");
    const messages: any[] = [
      makeUserMsg(),
      makeAssistantMsg([
        { id: "bash-src-big", name: "bash", arguments: { command: "cat src" } },
      ]),
      makeBashResult("bash-src-big", text),
      makeUserMsg(),
      makeAssistantMsg([]),
    ];
    const result = hook({ type: "context", messages } as any, {} as any);
    const bash = result.messages!.find(
      (m: any) => m.toolCallId === "bash-src-big",
    ) as any;
    expect(bash.content[0].text).toBe(text);
  });
});
