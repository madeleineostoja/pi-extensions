import { beforeEach, describe, expect, it, vi } from "vitest";
import { formatSwitchNotification, HANDOFF_INSTRUCTIONS } from "./prompt";
import type { HandoffEstimate, ModelRef } from "./decision";

const convertCurrencyMock = vi.hoisted(() => vi.fn());

vi.mock("@pi-extensions/lib", () => {
  return {
    convertCurrency: convertCurrencyMock,
    refreshCurrencyRate: vi.fn(),
  };
});

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

describe("formatSwitchNotification", () => {
  beforeEach(() => {
    convertCurrencyMock.mockReset();
  });

  it("includes target model name and context size", () => {
    const msg = formatSwitchNotification(
      makeRef({ name: "Kimi K2.6" }),
      makeEstimate({ currentTokens: 200_000, estimatedHandoffTokens: 6000 }),
    );
    expect(msg).toContain("Switched to Kimi K2.6");
    expect(msg).toContain("200k context");
    expect(msg).toContain("/handoff (~6.0k)");
  });

  it("falls back to provider/id when name is absent", () => {
    const msg = formatSwitchNotification(
      makeRef({ name: undefined, provider: "anthropic", id: "claude-opus" }),
      makeEstimate(),
    );
    expect(msg).toContain("anthropic/claude-opus");
  });

  it("shows converted cost when a rate is available", () => {
    convertCurrencyMock.mockImplementation(({ amount }) => amount * 1.7);
    const msg = formatSwitchNotification(
      makeRef(),
      makeEstimate({ targetFullContextInputCost: 0.12 }),
    );
    expect(msg).toContain("(~$0.20)");
  });

  it("omits cost parenthetical when pricing is unavailable", () => {
    const msg = formatSwitchNotification(
      makeRef({ inputCostPerMillion: undefined }),
      makeEstimate({ targetFullContextInputCost: undefined }),
    );
    expect(msg).not.toContain("(~$");
    expect(msg).toContain("· /handoff");
  });

  it("omits cost when no converted rate is available", () => {
    convertCurrencyMock.mockReturnValue(undefined);
    const msg = formatSwitchNotification(
      makeRef(),
      makeEstimate({ targetFullContextInputCost: 0.12 }),
    );
    expect(msg).not.toContain("(~$");
  });

  it("does not mention break-even turns or ROI", () => {
    const msg = formatSwitchNotification(makeRef(), makeEstimate());
    expect(msg).not.toMatch(/break.?even/i);
    expect(msg).not.toMatch(/ROI/i);
    expect(msg).not.toMatch(/future turn/i);
  });
});
