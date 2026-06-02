import { describe, expect, it } from "vitest";
import { getFooterCostInfo } from "./cost.js";

function assistantEntry(args: {
  provider?: string;
  model?: string;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cost?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    total?: number;
  };
}) {
  return {
    type: "message",
    message: {
      role: "assistant",
      provider: args.provider ?? "openai",
      model: args.model ?? "gpt-test",
      usage: {
        input: args.input ?? 0,
        output: args.output ?? 0,
        cacheRead: args.cacheRead ?? 0,
        cacheWrite: args.cacheWrite ?? 0,
        cost: args.cost ?? {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0,
        },
      },
    },
  };
}

function registry(options?: { subscriptionProviders?: string[] }) {
  const subscriptionProviders = new Set(options?.subscriptionProviders ?? []);
  return {
    find(provider: string, modelId: string) {
      return {
        provider,
        id: modelId,
        cost: {
          input: provider === "anthropic" ? 3 : 10,
          output: provider === "anthropic" ? 15 : 20,
          cacheRead: provider === "anthropic" ? 0.3 : 1,
          cacheWrite: provider === "anthropic" ? 3.75 : 5,
        },
      };
    },
    isUsingOAuth(model: { provider?: string }) {
      return model.provider ? subscriptionProviders.has(model.provider) : false;
    },
  };
}

describe("getFooterCostInfo", () => {
  it("uses persisted cost components including prompt cache cost", () => {
    const result = getFooterCostInfo(
      [
        assistantEntry({
          input: 1000,
          output: 1000,
          cacheRead: 10_000,
          cacheWrite: 500,
          cost: {
            input: 0.01,
            output: 0.02,
            cacheRead: 0.01,
            cacheWrite: 0.0025,
            total: 999,
          },
        }),
      ],
      registry(),
      undefined,
    );

    expect(result).toEqual({ totalCost: 0.0425, hideCost: false });
  });

  it("estimates from the response model when stored costs are zero", () => {
    const result = getFooterCostInfo(
      [assistantEntry({ input: 1000, output: 1000, cacheRead: 10_000 })],
      registry(),
      undefined,
    );

    expect(result.totalCost).toBeCloseTo(0.04);
    expect(result.hideCost).toBe(false);
  });

  it("only includes the supplied active branch entries", () => {
    const branch = [
      assistantEntry({
        cost: {
          input: 0.01,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0.01,
        },
      }),
    ];

    const result = getFooterCostInfo(branch, registry(), undefined);

    expect(result.totalCost).toBe(0.01);
  });

  it("keeps model-switched costs separate from current subscription state", () => {
    const result = getFooterCostInfo(
      [
        assistantEntry({
          provider: "openai",
          model: "gpt-test",
          cost: {
            input: 0.03,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            total: 0.03,
          },
        }),
        assistantEntry({
          provider: "anthropic",
          model: "claude-test",
          cost: {
            input: 0.5,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            total: 0.5,
          },
        }),
      ],
      registry({ subscriptionProviders: ["anthropic"] }),
      { provider: "anthropic", id: "claude-test" },
    );

    expect(result).toEqual({ totalCost: 0.03, hideCost: false });
  });

  it("hides cost when current usage is subscription-only", () => {
    const result = getFooterCostInfo(
      [assistantEntry({ provider: "anthropic", model: "claude-test" })],
      registry({ subscriptionProviders: ["anthropic"] }),
      { provider: "anthropic", id: "claude-test" },
    );

    expect(result).toEqual({ totalCost: 0, hideCost: true });
  });

  it("hides zero cost before first usage when the current model is subscription auth", () => {
    const result = getFooterCostInfo(
      [],
      registry({ subscriptionProviders: ["anthropic"] }),
      { provider: "anthropic", id: "claude-test" },
    );

    expect(result).toEqual({ totalCost: 0, hideCost: true });
  });

  it("falls back to persisted total for unresolved models", () => {
    const result = getFooterCostInfo(
      [
        assistantEntry({
          provider: "unknown",
          model: "unknown",
          cost: { total: 0.07 },
        }),
      ],
      { find: () => undefined, isUsingOAuth: () => false },
      undefined,
    );

    expect(result).toEqual({ totalCost: 0.07, hideCost: false });
  });
});
