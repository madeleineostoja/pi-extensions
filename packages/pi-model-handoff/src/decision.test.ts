import { describe, it, expect } from "vitest";
import {
  isEligibleSwitch,
  buildModelRef,
  computeHandoffEstimate,
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
  naiveContextTokens?: number;
}) {
  return {
    firstKeptEntryId: "keep-1",
    messagesToSummarize: opts.messagesToSummarize as never,
    turnPrefixMessages: (opts.turnPrefixMessages ?? []) as never,
    isSplitTurn: false,
    tokensBefore: opts.tokensBefore,
    naiveContextTokens: opts.naiveContextTokens ?? opts.tokensBefore,
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
    expect(isEligibleSwitch(event, "tui")).toBe(false);
  });

  it("ignores missing previousModel", () => {
    const event = makeEvent({ previousModel: undefined });
    expect(isEligibleSwitch(event, "tui")).toBe(false);
  });

  it("ignores when mode is not tui", () => {
    const event = makeEvent({
      previousModel: makeModel("anthropic", "claude-3-opus", 15),
    });
    expect(isEligibleSwitch(event, "rpc")).toBe(false);
  });

  it("ignores same model", () => {
    const model = makeModel("openai", "gpt-4o", 5);
    const event = makeEvent({ previousModel: model, model });
    expect(isEligibleSwitch(event, "tui")).toBe(false);
  });

  it("allows different models with UI", () => {
    const event = makeEvent({
      previousModel: makeModel("anthropic", "claude-3-opus", 15),
      model: makeModel("openai", "gpt-4o", 5),
    });
    expect(isEligibleSwitch(event, "tui")).toBe(true);
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
    const targetRef = buildModelRef(makeModel("openai", "gpt-4o", 5), false);

    const estimate = computeHandoffEstimate(preparation, targetRef);

    expect(estimate.currentTokens).toBe(10000);
    expect(estimate.summarizedTokens).toBeGreaterThan(0);
    expect(estimate.estimatedSummaryTokens).toBe(
      Math.ceil(estimate.summarizedTokens * 0.03),
    );
    // Savings are projected from naive fraction onto real usage-aware total
    expect(estimate.estimatedSavingsTokens).toBeGreaterThanOrEqual(0);
    expect(estimate.estimatedHandoffTokens).toBe(
      estimate.currentTokens - estimate.estimatedSavingsTokens,
    );
    expect(estimate.keptTokens).toBe(
      estimate.estimatedHandoffTokens - estimate.estimatedSummaryTokens,
    );
    expect(estimate.targetFullContextInputCost).toBeCloseTo(
      (10000 / 1_000_000) * 5,
      6,
    );
    expect(estimate.estimatedHandoffCost).toBeCloseTo(
      (estimate.estimatedHandoffTokens / 1_000_000) * 5,
      6,
    );
    expect(estimate.estimatedSavingsCost).toBeCloseTo(
      estimate.targetFullContextInputCost! - estimate.estimatedHandoffCost!,
      6,
    );
  });

  it("omits costs when pricing unavailable", () => {
    const preparation = makePreparation({
      tokensBefore: 10000,
      messagesToSummarize: [{ role: "user", content: "hello" }],
    });
    const targetRef = buildModelRef(
      { ...makeModel("c", "d", 1), cost: { input: NaN, output: NaN } },
      false,
    );

    const estimate = computeHandoffEstimate(preparation, targetRef);
    expect(estimate.targetFullContextInputCost).toBeUndefined();
    expect(estimate.estimatedHandoffCost).toBeUndefined();
    expect(estimate.estimatedSavingsCost).toBeUndefined();
  });
});
