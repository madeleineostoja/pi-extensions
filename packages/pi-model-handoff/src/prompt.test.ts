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
  it("contains continuation-focused guidance", () => {
    expect(HANDOFF_INSTRUCTIONS).toContain("goal");
    expect(HANDOFF_INSTRUCTIONS).toContain("file paths");
    expect(HANDOFF_INSTRUCTIONS).toContain("open questions");
    expect(HANDOFF_INSTRUCTIONS).toContain("remaining work");
  });
});

describe("formatSwitchNotification", () => {
  beforeEach(() => {
    convertCurrencyMock.mockReset();
  });

  it("renders the full notification for a billable target", () => {
    convertCurrencyMock.mockImplementation(({ amount }) => amount * 1.7);
    const notification = formatSwitchNotification(
      makeRef({ name: "Kimi K2.6" }),
      makeEstimate({
        currentTokens: 200_000,
        estimatedHandoffTokens: 6000,
        targetFullContextInputCost: 0.05,
      }),
    );
    expect(notification).toBe(
      "Switched to Kimi K2.6 · 200k context (~$0.09) · /handoff (~6.0k)",
    );
  });

  it("omits the cost parenthetical when no rate is available", () => {
    convertCurrencyMock.mockReturnValue(undefined);
    const notification = formatSwitchNotification(
      makeRef({ name: "GPT-4o" }),
      makeEstimate({
        currentTokens: 200_000,
        estimatedHandoffTokens: 6000,
        targetFullContextInputCost: 0.05,
      }),
    );
    expect(notification).toBe(
      "Switched to GPT-4o · 200k context · /handoff (~6.0k)",
    );
  });

  it("omits the cost parenthetical when pricing is unavailable", () => {
    const notification = formatSwitchNotification(
      makeRef(),
      makeEstimate({ targetFullContextInputCost: undefined }),
    );
    expect(notification).not.toContain("(~$");
    expect(notification).toContain("· /handoff");
  });

  it("falls back to provider/id when name is absent", () => {
    const notification = formatSwitchNotification(
      makeRef({ name: undefined, provider: "openai", id: "gpt-4o" }),
      makeEstimate(),
    );
    expect(notification).toContain("openai/gpt-4o");
  });

  it("does not mention break-even turns or ROI", () => {
    const msg = formatSwitchNotification(makeRef(), makeEstimate());
    expect(msg).not.toMatch(/break.?even/i);
    expect(msg).not.toMatch(/ROI/i);
    expect(msg).not.toMatch(/future turn/i);
  });
});
