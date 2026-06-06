import { describe, it, expect } from "vitest";
import {
  formatHandoffPrompt,
  HANDOFF_INSTRUCTIONS,
  OPTION_CREATE_HANDOFF,
  OPTION_CONTINUE_FULL_CONTEXT,
} from "./prompt";
import type { HandoffEstimate, ModelRef } from "./decision";

function makeRef(overrides: Partial<ModelRef> = {}): ModelRef {
  return {
    provider: "openai",
    id: "gpt-4o",
    name: "GPT-4o",
    inputCostPerMillion: 5,
    outputCostPerMillion: 10,
    subscription: false,
    ...overrides,
  };
}

function makeEstimate(
  overrides: Partial<HandoffEstimate> = {},
): HandoffEstimate {
  return {
    currentTokens: 10000,
    summarizedTokens: 7000,
    keptTokens: 3000,
    estimatedSummaryTokens: 210,
    estimatedHandoffTokens: 3210,
    estimatedSavingsTokens: 6790,
    ...overrides,
  };
}

describe("HANDOFF_INSTRUCTIONS", () => {
  it("contains implementation-focused guidance", () => {
    expect(HANDOFF_INSTRUCTIONS).toContain("goal");
    expect(HANDOFF_INSTRUCTIONS).toContain("file paths");
    expect(HANDOFF_INSTRUCTIONS).toContain("next steps");
  });
});

describe("option labels", () => {
  it("are stable strings", () => {
    expect(OPTION_CREATE_HANDOFF).toBe("Create handoff");
    expect(OPTION_CONTINUE_FULL_CONTEXT).toBe("Continue full context");
  });
});

describe("formatHandoffPrompt", () => {
  it("includes source and target model names", () => {
    const prompt = formatHandoffPrompt(
      makeRef({ name: "Claude 3 Opus" }),
      makeRef({ name: "GPT-4o Mini" }),
      makeEstimate(),
    );
    expect(prompt).toContain("Claude 3 Opus");
    expect(prompt).toContain("GPT-4o Mini");
    expect(prompt).toContain("->");
  });

  it("falls back to provider/id when name is absent", () => {
    const prompt = formatHandoffPrompt(
      makeRef({ name: undefined, provider: "anthropic", id: "claude-opus" }),
      makeRef({ name: undefined, provider: "openai", id: "gpt-4o" }),
      makeEstimate(),
    );
    expect(prompt).toContain("anthropic/claude-opus");
    expect(prompt).toContain("openai/gpt-4o");
  });

  it("shows rounded token estimates", () => {
    const prompt = formatHandoffPrompt(makeRef(), makeRef(), makeEstimate());
    expect(prompt).toContain("10k");
    expect(prompt).toContain("3.2k");
    expect(prompt).toContain("6.8k");
  });

  it("shows cost estimates when available", () => {
    const prompt = formatHandoffPrompt(
      makeRef(),
      makeRef(),
      makeEstimate({
        targetFullContextInputCost: 0.05,
        estimatedHandoffCost: 0.016,
        estimatedSavingsCost: 0.034,
      }),
    );
    expect(prompt).toContain("$0.0500");
    expect(prompt).toContain("$0.0160");
    expect(prompt).toContain("$0.0340");
  });

  it("omits costs when unavailable", () => {
    const prompt = formatHandoffPrompt(
      makeRef(),
      makeRef(),
      makeEstimate({
        targetFullContextInputCost: undefined,
        estimatedHandoffCost: undefined,
        estimatedSavingsCost: undefined,
      }),
    );
    expect(prompt).not.toContain("$");
  });

  it("does not mention break-even turns or ROI", () => {
    const prompt = formatHandoffPrompt(makeRef(), makeRef(), makeEstimate());
    expect(prompt).not.toMatch(/break.?even/i);
    expect(prompt).not.toMatch(/ROI/i);
    expect(prompt).not.toMatch(/future turn/i);
  });

  it("labels costs as estimates", () => {
    const prompt = formatHandoffPrompt(
      makeRef(),
      makeRef(),
      makeEstimate({ targetFullContextInputCost: 0.1 }),
    );
    expect(prompt).toMatch(/\(~\$.*\)/);
  });
});
