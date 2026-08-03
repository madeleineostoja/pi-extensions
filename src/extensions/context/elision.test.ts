import {
  createReadToolDefinition,
  estimateTokens,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { makeContextHook, restoreEpochs } from "./elision.ts";
import { EPOCH_TYPE, createPruningState } from "./policy.ts";

function toolResult(id: string, text = "x".repeat(4_000), name = "bash") {
  return {
    role: "toolResult" as const,
    toolCallId: id,
    toolName: name,
    content: [{ type: "text" as const, text }],
    isError: false,
    timestamp: 1,
  };
}

function context(
  messages: unknown[],
  entries: unknown[],
  append: (type: string, data: unknown) => void,
) {
  return {
    messages,
    ctx: {
      cwd: "/work",
      model: undefined,
      sessionManager: { getBranch: () => entries },
      ui: { notify: () => {} },
      append,
    },
  };
}

describe("context epochs", () => {
  it("persists a complete tail epoch before changing outgoing copies and restores it after reinstantiation", () => {
    const source = toolResult("source");
    const messages = [
      source,
      { role: "user" as const, content: "one" },
      { role: "user" as const, content: "two" },
      { role: "user" as const, content: "three" },
      { role: "user" as const, content: "four" },
    ];
    const entries: any[] = [];
    const appended: any[] = [];
    const append = (type: string, data: any) => {
      appended.push({ type, data });
      entries.push({ type: "custom", id: "epoch-1", customType: type, data });
    };
    const first = makeContextHook(createPruningState(), append);
    const input = context(messages, entries, append);
    const result = first(
      { type: "context", messages } as any,
      input.ctx as any,
    );

    expect(appended).toEqual([
      expect.objectContaining({
        type: EPOCH_TYPE,
        data: {
          kind: "tail",
          decisions: [
            expect.objectContaining({
              sourceToolCallId: "source",
              reason: "standard-stale",
              estimatedTokensSaved: expect.any(Number),
            }),
          ],
        },
      }),
    ]);
    expect(result.messages[0]).not.toBe(source);
    expect((result.messages[0] as any).content[0].text).toContain(
      'context_recall("source")',
    );
    const decision = appended[0]?.data.decisions[0];
    expect(decision.estimatedTokensSaved).toBe(
      estimateTokens(source) -
        estimateTokens({
          ...source,
          content: [{ type: "text", text: decision.stub }],
        }),
    );
    expect(source.content[0].text).toHaveLength(4_000);

    const reloaded = makeContextHook(createPruningState(), append);
    const restored = reloaded(
      { type: "context", messages } as any,
      input.ctx as any,
    );
    expect((restored.messages[0] as any).content).toEqual(
      (result.messages[0] as any).content,
    );
  });

  it("treats successful Web Fetch results as ordinary standard-stale results", () => {
    const singleContent = `Requested URL: https://example.com/one\n\n${"first result ".repeat(400)}`;
    const batchContent = `# Batch Web Fetch\n\n## Item 1: https://example.com/two\nStatus: succeeded\n\n${"second result ".repeat(400)}`;
    const single = toolResult("web-single", singleContent, "web_fetch");
    const batch = toolResult("web-batch", batchContent, "batch_web_fetch");
    for (const source of [single, batch]) {
      const messages = [
        source,
        { role: "user" as const, content: "one" },
        { role: "user" as const, content: "two" },
        { role: "user" as const, content: "three" },
        { role: "user" as const, content: "four" },
      ];
      const appended: any[] = [];
      const append = (type: string, data: any) => appended.push({ type, data });
      const result = makeContextHook(createPruningState(), append)(
        { type: "context", messages } as any,
        context(messages, [], append).ctx as any,
      );

      expect(appended[0]?.data.decisions).toEqual([
        expect.objectContaining({
          sourceToolCallId: source.toolCallId,
          reason: "standard-stale",
        }),
      ]);
      expect((result.messages[0] as any).content[0].text).toContain(
        `context_recall("${source.toolCallId}")`,
      );
    }
    expect(single.content[0].text).toBe(singleContent);
    expect(batch.content[0].text).toBe(batchContent);
  });

  it("replays a legacy v1 epoch without changing its stored stub", () => {
    const stub =
      '[tool result elided: stale. Call context_recall("source") to retrieve.]';
    const legacy = {
      kind: "tail",
      decisions: [
        {
          sourceToolCallId: "source",
          reason: "standard-stale",
          stub,
        },
      ],
    };
    const messages = [toolResult("source")];
    const result = makeContextHook(createPruningState(), () => {})(
      { type: "context", messages } as any,
      context(
        messages,
        [
          {
            type: "custom",
            id: "legacy",
            customType: EPOCH_TYPE,
            data: legacy,
          },
        ],
        () => {},
      ).ctx as any,
    );

    expect((result.messages[0] as any).content).toEqual([
      { type: "text", text: stub },
    ]);
  });

  it("persists exact savings for known-cold and warm epochs", () => {
    const source = toolResult("source", "x".repeat(150_000));
    const messages = [
      source,
      { role: "user" as const, content: "one" },
      { role: "user" as const, content: "two" },
      { role: "user" as const, content: "three" },
      { role: "user" as const, content: "four" },
    ];
    const knownCold: any[] = [];
    const knownColdContext = context(
      messages,
      [
        { type: "model_change", provider: "other", modelId: "other" },
        { type: "model_change", provider: "test", modelId: "model" },
      ],
      () => {},
    );
    (knownColdContext.ctx as any).model = { provider: "test", id: "model" };
    makeContextHook(createPruningState(), (type, data) =>
      knownCold.push({ type, data }),
    )({ type: "context", messages } as any, knownColdContext.ctx as any);

    const warm: any[] = [];
    makeContextHook(createPruningState(), (type, data) =>
      warm.push({ type, data }),
    )(
      { type: "context", messages } as any,
      context(
        messages,
        Array.from({ length: 8 }, (_, index) => ({
          type: "message",
          message: { role: "user", content: `turn ${index}` },
        })),
        () => {},
      ).ctx as any,
    );

    for (const epoch of [knownCold[0], warm[0]]) {
      const decision = epoch.data.decisions[0];
      expect(epoch.data.kind).toBe(
        epoch === knownCold[0] ? "known-cold" : "warm",
      );
      expect(decision.estimatedTokensSaved).toBe(
        estimateTokens(source) -
          estimateTokens({
            ...source,
            content: [{ type: "text", text: decision.stub }],
          }),
      );
    }
  });

  it("does not latch or transform a proposed epoch when persistence fails", () => {
    const messages = [
      toolResult("source"),
      { role: "user" as const, content: "one" },
      { role: "user" as const, content: "two" },
      { role: "user" as const, content: "three" },
      { role: "user" as const, content: "four" },
    ];
    const state = createPruningState();
    const hook = makeContextHook(state, () => {
      throw new Error("disk unavailable");
    });
    const result = hook(
      { type: "context", messages } as any,
      context(messages, [], () => {}).ctx as any,
    );

    expect(result.messages[0]).toBe(messages[0]);
    expect(state.decisions.size).toBe(0);
  });

  it("does not treat Pi's initial model record as a known-cold transition", () => {
    const messages = [
      toolResult("source", "x".repeat(40_000)),
      { role: "user" as const, content: "one" },
      { role: "user" as const, content: "two" },
      { role: "user" as const, content: "three" },
      { role: "user" as const, content: "four" },
    ];
    const appended: any[] = [];
    const hook = makeContextHook(createPruningState(), (type, data) =>
      appended.push({ type, data }),
    );
    const input = context(
      messages,
      [{ type: "model_change", provider: "test", modelId: "model" }],
      () => {},
    );
    (input.ctx as any).model = { provider: "test", id: "model" };

    hook({ type: "context", messages } as any, input.ctx as any);

    expect(appended).toEqual([]);
  });

  it("rejects an entire repeated epoch while preserving earlier accepted decisions", () => {
    const state = createPruningState();
    const first = {
      kind: "tail",
      decisions: [
        {
          sourceToolCallId: "one",
          reason: "standard-stale",
          stub: '[tool result elided: stale. Call context_recall("one") to retrieve.]',
        },
      ],
    };
    const repeated = {
      kind: "warm",
      decisions: [
        {
          sourceToolCallId: "one",
          reason: "standard-stale",
          stub: '[tool result elided: stale. Call context_recall("one") to retrieve.]',
        },
        {
          sourceToolCallId: "two",
          reason: "standard-stale",
          stub: '[tool result elided: stale. Call context_recall("two") to retrieve.]',
        },
      ],
    };
    const replay = restoreEpochs(state, [
      { type: "custom", id: "one", customType: EPOCH_TYPE, data: first },
      { type: "custom", id: "two", customType: EPOCH_TYPE, data: repeated },
    ]);

    expect(replay.invalid).toBe(true);
    expect([...state.decisions.keys()]).toEqual(["one"]);
  });

  it("rejects byte-limit-inconsistent read metadata for containment", () => {
    const readCall = (id: string) => ({
      role: "assistant" as const,
      content: [
        {
          type: "toolCall" as const,
          id,
          name: "read",
          arguments: { path: "a.ts" },
        },
      ],
    });
    const early = {
      ...toolResult("early", "x".repeat(100), "read"),
      details: {
        truncation: {
          content: "x".repeat(80),
          totalLines: 3,
          totalBytes: 100,
          outputLines: 2,
          outputBytes: 80,
          truncated: true,
          truncatedBy: "lines",
          lastLinePartial: false,
          firstLineExceedsLimit: false,
          maxLines: 2,
          maxBytes: 50_000,
        },
      },
    };
    const late = {
      ...toolResult("late", "x".repeat(20_000), "read"),
      details: {
        truncation: {
          content: "x".repeat(20_000),
          totalLines: 100,
          totalBytes: 40_000,
          outputLines: 100,
          outputBytes: 20_000,
          truncated: true,
          truncatedBy: "bytes",
          lastLinePartial: false,
          firstLineExceedsLimit: false,
          maxLines: 2_000,
          maxBytes: 50_000,
        },
      },
    };
    const messages = [
      readCall("early"),
      early,
      readCall("late"),
      late,
      { role: "assistant" as const, content: [] },
    ];
    const appended: any[] = [];
    const hook = makeContextHook(createPruningState(), (type, data) =>
      appended.push({ type, data }),
    );
    const input = context(
      messages,
      [
        { type: "model_change", provider: "other", modelId: "other" },
        { type: "model_change", provider: "test", modelId: "model" },
      ],
      () => {},
    );
    (input.ctx as any).model = { provider: "test", id: "model" };

    hook({ type: "context", messages } as any, input.ctx as any);

    expect(appended).toEqual([]);
  });

  it("uses Pi's returned read intervals for containment", async () => {
    const definition = createReadToolDefinition("/work", {
      operations: {
        access: async () => {},
        readFile: async () =>
          Buffer.from(
            Array.from(
              { length: 2_001 },
              (_, index) => `a b c d e f g ${index}`,
            ).join("\n"),
          ),
      },
    });
    const result = await definition.execute(
      "read",
      { path: "a.ts" },
      undefined,
      undefined,
      {} as never,
    );
    const readCall = (id: string) => ({
      role: "assistant" as const,
      content: [
        {
          type: "toolCall" as const,
          id,
          name: "read",
          arguments: { path: "a.ts" },
        },
      ],
    });
    const read = (id: string) => ({
      ...toolResult(id, "", "read"),
      content: result.content,
      details: result.details,
    });
    const messages = [
      readCall("early"),
      read("early"),
      readCall("late"),
      read("late"),
      { role: "assistant" as const, content: [] },
    ];
    const appended: any[] = [];
    const hook = makeContextHook(createPruningState(), (type, data) =>
      appended.push({ type, data }),
    );
    const input = context(
      messages,
      [
        { type: "model_change", provider: "other", modelId: "other" },
        { type: "model_change", provider: "test", modelId: "model" },
      ],
      () => {},
    );
    (input.ctx as any).model = { provider: "test", id: "model" };
    hook({ type: "context", messages } as any, input.ctx as any);

    expect(result.details?.truncation).toMatchObject({
      truncated: true,
      truncatedBy: "lines",
      outputLines: 2_000,
    });
    expect(result.content).toHaveLength(1);
    expect(result.content[0]).toMatchObject({ type: "text" });
    expect(appended[0]?.data.decisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceToolCallId: "early",
          reason: "duplicate-read",
        }),
      ]),
    );
  });
});
