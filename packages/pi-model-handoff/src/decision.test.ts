import { describe, it, expect } from "vitest";
import {
  isEligibleSwitch,
  buildModelRef,
  computeHandoffEstimate,
  makeHandoffDecision,
  type ModelSelectEvent,
} from "./decision";

function makeModel(
  provider: string,
  id: string,
  costInput: number,
  isOAuth = false,
) {
  return {
    provider,
    id,
    name: `${provider}-${id}`,
    cost: { input: costInput, output: costInput * 2 },
    contextWindow: 200000,
    maxTokens: 16384,
    isOAuth,
  };
}

function makeEvent(overrides: {
  source?: "set" | "cycle" | "restore";
  previousModel?: ReturnType<typeof makeModel>;
  model?: ReturnType<typeof makeModel>;
}): ModelSelectEvent {
  return {
    type: "model_select",
    model: (overrides.model ?? makeModel("openai", "gpt-4o", 5)) as never,
    previousModel: overrides.previousModel
      ? (overrides.previousModel as never)
      : undefined,
    source: overrides.source ?? "set",
  };
}

function makePreparation(opts: {
  tokensBefore: number;
  messagesToSummarize: { role: string; content: string }[];
  turnPrefixMessages?: { role: string; content: string }[];
}) {
  return {
    firstKeptEntryId: "keep-1",
    messagesToSummarize: opts.messagesToSummarize as never,
    turnPrefixMessages: (opts.turnPrefixMessages ?? []) as never,
    isSplitTurn: false,
    tokensBefore: opts.tokensBefore,
    fileOps: {} as never,
    settings: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 },
  };
}

describe("isEligibleSwitch", () => {
  it("ignores restore source", () => {
    const event = makeEvent({
      source: "restore",
      previousModel: makeModel("anthropic", "claude-3-opus", 15),
    });
    expect(isEligibleSwitch(event, true)).toBe(false);
  });

  it("ignores missing previousModel", () => {
    const event = makeEvent({ previousModel: undefined });
    expect(isEligibleSwitch(event, true)).toBe(false);
  });

  it("ignores when hasUI is false", () => {
    const event = makeEvent({
      previousModel: makeModel("anthropic", "claude-3-opus", 15),
    });
    expect(isEligibleSwitch(event, false)).toBe(false);
  });

  it("ignores same model", () => {
    const model = makeModel("openai", "gpt-4o", 5);
    const event = makeEvent({ previousModel: model, model });
    expect(isEligibleSwitch(event, true)).toBe(false);
  });

  it("allows different models with UI", () => {
    const event = makeEvent({
      previousModel: makeModel("anthropic", "claude-3-opus", 15),
      model: makeModel("openai", "gpt-4o", 5),
    });
    expect(isEligibleSwitch(event, true)).toBe(true);
  });
});

describe("buildModelRef", () => {
  it("copies provider, id, name, and costs", () => {
    const model = makeModel("openai", "gpt-4o", 5);
    const ref = buildModelRef(model, false);
    expect(ref.provider).toBe("openai");
    expect(ref.id).toBe("gpt-4o");
    expect(ref.name).toBe("openai-gpt-4o");
    expect(ref.inputCostPerMillion).toBe(5);
    expect(ref.outputCostPerMillion).toBe(10);
    expect(ref.subscription).toBe(false);
  });

  it("marks subscription when OAuth", () => {
    const ref = buildModelRef(makeModel("google", "gemini-pro", 0, true), true);
    expect(ref.subscription).toBe(true);
  });

  it("omits costs when OAuth even if model has finite costs", () => {
    const model = makeModel("google", "gemini-pro", 5);
    const ref = buildModelRef(model, true);
    expect(ref.inputCostPerMillion).toBeUndefined();
    expect(ref.outputCostPerMillion).toBeUndefined();
    expect(ref.subscription).toBe(true);
  });

  it("omits cost when non-finite", () => {
    const model = {
      ...makeModel("x", "y", 1),
      cost: { input: NaN, output: Infinity },
    };
    const ref = buildModelRef(model, false);
    expect(ref.inputCostPerMillion).toBeUndefined();
    expect(ref.outputCostPerMillion).toBeUndefined();
  });
});

describe("computeHandoffEstimate", () => {
  it("computes tokens and costs correctly", () => {
    const preparation = makePreparation({
      tokensBefore: 10000,
      messagesToSummarize: [
        { role: "user", content: "a".repeat(400) },
        { role: "assistant", content: "b".repeat(400) },
      ],
    });
    const sourceRef = buildModelRef(makeModel("anthropic", "opus", 15), false);
    const targetRef = buildModelRef(makeModel("openai", "gpt-4o", 5), false);

    const estimate = computeHandoffEstimate(preparation, sourceRef, targetRef);

    expect(estimate.currentTokens).toBe(10000);
    expect(estimate.summarizedTokens).toBeGreaterThan(0);
    expect(estimate.keptTokens).toBe(
      Math.max(10000 - estimate.summarizedTokens, 0),
    );
    expect(estimate.sourceInputCost).toBeCloseTo((10000 / 1_000_000) * 15, 6);
    expect(estimate.targetFullContextInputCost).toBeCloseTo(
      (10000 / 1_000_000) * 5,
      6,
    );
    expect(estimate.targetKeptContextInputCost).toBeCloseTo(
      (estimate.keptTokens / 1_000_000) * 5,
      6,
    );
  });

  it("omits costs when pricing unavailable", () => {
    const preparation = makePreparation({
      tokensBefore: 10000,
      messagesToSummarize: [{ role: "user", content: "hello" }],
    });
    const sourceRef = buildModelRef(
      { ...makeModel("a", "b", 1), cost: { input: NaN, output: NaN } },
      false,
    );
    const targetRef = buildModelRef(
      { ...makeModel("c", "d", 1), cost: { input: NaN, output: NaN } },
      false,
    );

    const estimate = computeHandoffEstimate(preparation, sourceRef, targetRef);
    expect(estimate.sourceInputCost).toBeUndefined();
    expect(estimate.targetFullContextInputCost).toBeUndefined();
    expect(estimate.targetKeptContextInputCost).toBeUndefined();
  });
});

describe("makeHandoffDecision", () => {
  it("skips when preparation is undefined", () => {
    const decision = makeHandoffDecision(
      undefined,
      buildModelRef(makeModel("a", "b", 1), false),
      buildModelRef(makeModel("c", "d", 1), false),
    );
    expect(decision.kind).toBe("skip");
    expect((decision as { reason: string }).reason).toContain("preparation");
  });

  it("skips when no messages to summarize", () => {
    const preparation = makePreparation({
      tokensBefore: 1000,
      messagesToSummarize: [],
    });
    const decision = makeHandoffDecision(
      preparation,
      buildModelRef(makeModel("a", "b", 1), false),
      buildModelRef(makeModel("c", "d", 1), false),
    );
    expect(decision.kind).toBe("skip");
    expect((decision as { reason: string }).reason).toContain("No messages");
  });

  it("skips when summarizedTokens <= keptTokens", () => {
    const preparation = makePreparation({
      tokensBefore: 100,
      messagesToSummarize: [{ role: "user", content: "short" }],
    });
    const decision = makeHandoffDecision(
      preparation,
      buildModelRef(makeModel("a", "b", 1), false),
      buildModelRef(makeModel("c", "d", 1), false),
    );
    expect(decision.kind).toBe("skip");
    expect((decision as { reason: string }).reason).toContain("kept");
  });

  it("offers when summarizedTokens > keptTokens and no pricing", () => {
    const preparation = makePreparation({
      tokensBefore: 500,
      messagesToSummarize: [{ role: "user", content: "a".repeat(8000) }],
    });
    const sourceRef = buildModelRef(
      { ...makeModel("a", "b", 1), cost: { input: NaN, output: NaN } },
      false,
    );
    const targetRef = buildModelRef(
      { ...makeModel("c", "d", 1), cost: { input: NaN, output: NaN } },
      false,
    );
    const decision = makeHandoffDecision(preparation, sourceRef, targetRef);
    expect(decision.kind).toBe("offer");
  });

  it("offers when source is subscription and token reduction is large", () => {
    const preparation = makePreparation({
      tokensBefore: 1000,
      messagesToSummarize: [{ role: "user", content: "a".repeat(8000) }],
    });
    const sourceRef = buildModelRef(makeModel("anthropic", "pro", 20), true);
    const targetRef = buildModelRef(makeModel("openai", "gpt-4o", 5), false);
    const decision = makeHandoffDecision(preparation, sourceRef, targetRef);
    expect(decision.kind).toBe("offer");
  });

  it("skips downshift check when source is subscription but uses token gate", () => {
    const preparation = makePreparation({
      tokensBefore: 100,
      messagesToSummarize: [{ role: "user", content: "short" }],
    });
    const sourceRef = buildModelRef(makeModel("anthropic", "pro", 20), true);
    const targetRef = buildModelRef(makeModel("openai", "gpt-4o", 5), false);
    const decision = makeHandoffDecision(preparation, sourceRef, targetRef);
    expect(decision.kind).toBe("skip");
    expect((decision as { reason: string }).reason).toContain("kept");
  });

  it("skips when target is not cheaper and both have pricing", () => {
    const preparation = makePreparation({
      tokensBefore: 1000,
      messagesToSummarize: [{ role: "user", content: "a".repeat(8000) }],
    });
    const sourceRef = buildModelRef(makeModel("openai", "cheap", 1), false);
    const targetRef = buildModelRef(
      makeModel("openai", "expensive", 10),
      false,
    );
    const decision = makeHandoffDecision(preparation, sourceRef, targetRef);
    expect(decision.kind).toBe("skip");
    expect((decision as { reason: string }).reason).toContain("not cheaper");
  });

  it("offers when target is cheaper and both have pricing", () => {
    const preparation = makePreparation({
      tokensBefore: 1000,
      messagesToSummarize: [{ role: "user", content: "a".repeat(8000) }],
    });
    const sourceRef = buildModelRef(
      makeModel("openai", "expensive", 10),
      false,
    );
    const targetRef = buildModelRef(makeModel("openai", "cheap", 1), false);
    const decision = makeHandoffDecision(preparation, sourceRef, targetRef);
    expect(decision.kind).toBe("offer");
  });

  it("includes turnPrefixMessages in summarized tokens", () => {
    const preparation = makePreparation({
      tokensBefore: 500,
      messagesToSummarize: [{ role: "user", content: "a".repeat(4000) }],
      turnPrefixMessages: [{ role: "user", content: "b".repeat(4000) }],
    });
    const sourceRef = buildModelRef(makeModel("a", "b", 5), false);
    const targetRef = buildModelRef(makeModel("c", "d", 1), false);
    const decision = makeHandoffDecision(preparation, sourceRef, targetRef);
    expect(decision.kind).toBe("offer");
  });
});
