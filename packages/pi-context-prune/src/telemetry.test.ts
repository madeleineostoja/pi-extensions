import { describe, it, expect } from "vitest";
import {
  type CacheSample,
  computeRecentCacheHit,
  captureContextUsage,
  ingestAssistantUsage,
  getEffectiveProfile,
  formatTelemetryDiagnostics,
} from "./telemetry.ts";
import {
  createPruningState,
  getProfileForReason,
  recordElision,
} from "./policy.ts";
import { registerRecallTool } from "./recall.ts";
import type { PolicyProfile } from "./policy.ts";

function makeState() {
  return createPruningState();
}

function makeSessionEntry(toolCallId: string, toolName: string, text: string) {
  return {
    type: "message" as const,
    id: `entry-${toolCallId}`,
    parentId: null,
    timestamp: new Date().toISOString(),
    message: {
      role: "toolResult" as const,
      toolCallId,
      toolName,
      content: [{ type: "text" as const, text }],
      isError: false,
      timestamp: Date.now(),
    },
  };
}

function sample(
  opts: Partial<CacheSample> & {
    input: number;
    cacheRead: number;
    cacheWrite: number;
  },
): CacheSample {
  const denom = opts.input + opts.cacheRead + opts.cacheWrite;
  return {
    provider: opts.provider ?? "p",
    model: opts.model ?? "m",
    input: opts.input,
    cacheRead: opts.cacheRead,
    cacheWrite: opts.cacheWrite,
    cacheHit: denom > 0 ? opts.cacheRead / denom : 0,
  };
}

describe("computeRecentCacheHit", () => {
  it("returns 0.5 when fewer than 2 samples exist", () => {
    const s: CacheSample[] = [
      sample({ input: 100, cacheRead: 50, cacheWrite: 10 }),
    ];
    expect(computeRecentCacheHit(s, "p", "m")).toBe(0.5);
  });

  it("returns 0.5 when no samples match provider+model", () => {
    const s: CacheSample[] = [
      sample({ input: 100, cacheRead: 50, cacheWrite: 10, provider: "other" }),
      sample({ input: 100, cacheRead: 50, cacheWrite: 10, model: "other" }),
    ];
    expect(computeRecentCacheHit(s, "p", "m")).toBe(0.5);
  });

  it("computes rolling average over latest 5 matching samples", () => {
    const s: CacheSample[] = [
      sample({ input: 0, cacheRead: 100, cacheWrite: 0 }),
      sample({ input: 0, cacheRead: 100, cacheWrite: 0 }),
      sample({ input: 0, cacheRead: 100, cacheWrite: 0 }),
      sample({ input: 0, cacheRead: 100, cacheWrite: 0 }),
      sample({ input: 0, cacheRead: 100, cacheWrite: 0 }),
      sample({ input: 100, cacheRead: 0, cacheWrite: 0 }),
    ];
    const hit = computeRecentCacheHit(s, "p", "m");
    expect(hit).toBeCloseTo(0.8, 2);
  });

  it("guards against zero denominator", () => {
    const s: CacheSample[] = [
      sample({ input: 0, cacheRead: 0, cacheWrite: 0 }),
      sample({ input: 0, cacheRead: 0, cacheWrite: 0 }),
    ];
    expect(computeRecentCacheHit(s, "p", "m")).toBe(0);
  });
});

describe("captureContextUsage", () => {
  it("records usage when available", () => {
    const state = makeState();
    const ctx = {
      getContextUsage: () => ({
        tokens: 5000,
        contextWindow: 100000,
        percent: 5,
      }),
    } as any;
    captureContextUsage(state, ctx);
    expect(state.contextUsage).toEqual({
      tokens: 5000,
      contextWindow: 100000,
      percent: 5,
    });
  });

  it("ignores safely when getContextUsage is missing", () => {
    const state = makeState();
    const ctx = {} as any;
    captureContextUsage(state, ctx);
    expect(state.contextUsage).toBeUndefined();
  });

  it("clears stale usage when getContextUsage becomes unavailable", () => {
    const state = makeState();
    state.contextUsage = { tokens: 99, contextWindow: 100, percent: 99 };
    captureContextUsage(state, {} as any);
    expect(state.contextUsage).toBeUndefined();
  });

  it("ignores safely when tokens is null", () => {
    const state = makeState();
    const ctx = {
      getContextUsage: () => ({
        tokens: null,
        contextWindow: 100000,
        percent: null,
      }),
    } as any;
    captureContextUsage(state, ctx);
    expect(state.contextUsage).toEqual({
      tokens: null,
      contextWindow: 100000,
      percent: null,
    });
  });

  it("does nothing when state is undefined", () => {
    captureContextUsage(undefined, {
      getContextUsage: () => ({ tokens: 1, contextWindow: 2, percent: 3 }),
    } as any);
  });
});

describe("ingestAssistantUsage", () => {
  it("records usage from assistant message with usage", () => {
    const state = makeState();
    const ingested = ingestAssistantUsage(state, {
      role: "assistant",
      provider: "anthropic",
      model: "claude-3",
      timestamp: 1,
      usage: { input: 100, output: 20, cacheRead: 50, cacheWrite: 10 },
    });
    expect(ingested).toBe(true);
    expect(state.recentCacheSamples.length).toBe(1);
    expect(state.recentCacheSamples[0].cacheRead).toBe(50);
  });

  it("ignores non-assistant messages", () => {
    const state = makeState();
    const ingested = ingestAssistantUsage(state, {
      role: "user",
      usage: { input: 100, cacheRead: 50, cacheWrite: 10 },
    });
    expect(ingested).toBe(false);
    expect(state.recentCacheSamples.length).toBe(0);
  });

  it("ignores assistant messages without usage", () => {
    const state = makeState();
    const ingested = ingestAssistantUsage(state, { role: "assistant" });
    expect(ingested).toBe(false);
  });

  it("records usage from assistant-like session messages without a role field", () => {
    const state = makeState();
    const ingested = ingestAssistantUsage(state, {
      provider: "anthropic",
      model: "claude-3",
      timestamp: 1,
      usage: { input: 100, output: 20, cacheRead: 50, cacheWrite: 10 },
    });
    expect(ingested).toBe(true);
    expect(state.recentCacheSamples).toHaveLength(1);
  });

  it("deduplicates identical assistant messages by usage key", () => {
    const state = makeState();
    const msg = {
      role: "assistant" as const,
      provider: "p",
      model: "m",
      timestamp: 1,
      usage: { input: 100, output: 20, cacheRead: 50, cacheWrite: 10 },
    };
    expect(ingestAssistantUsage(state, msg)).toBe(true);
    expect(ingestAssistantUsage(state, msg)).toBe(false);
    expect(state.recentCacheSamples.length).toBe(1);
  });

  it("updates adaptive policy after ingestion", () => {
    const state = makeState();
    ingestAssistantUsage(state, {
      role: "assistant",
      provider: "p",
      model: "m",
      timestamp: 1,
      usage: { input: 100, cacheRead: 0, cacheWrite: 0 },
    });
    const agg = state.aggressivenessByReason.get("standard-stale");
    expect(agg).not.toBeUndefined();
  });

  it("records telemetry without changing adaptive state when disabled", () => {
    const state = makeState();
    state.nonEmergencyBatchSinceLastUsage = true;
    const ingested = ingestAssistantUsage(
      state,
      {
        role: "assistant",
        provider: "p",
        model: "m",
        timestamp: 1,
        usage: { input: 100, cacheRead: 0, cacheWrite: 0 },
      },
      false,
    );
    expect(ingested).toBe(true);
    expect(state.recentCacheSamples).toHaveLength(1);
    expect(state.aggressivenessByReason.size).toBe(0);
    expect(state.batchCooldownExtraTurns).toBe(0);
    expect(state.nonEmergencyBatchSinceLastUsage).toBe(false);
  });

  it("caps retained telemetry samples and usage dedupe keys", () => {
    const state = makeState();
    for (let i = 0; i < 520; i++) {
      ingestAssistantUsage(state, {
        role: "assistant",
        provider: "p",
        model: "m",
        timestamp: i,
        usage: { input: 100 + i, output: 1, cacheRead: i % 2, cacheWrite: 0 },
      });
    }
    expect(state.recentCacheSamples).toHaveLength(100);
    expect(state.recentCacheSamples[0].input).toBe(520);
    expect(state.seenUsageKeys.size).toBe(500);
  });
});

describe("getEffectiveProfile", () => {
  const baseProfile: PolicyProfile = {
    minSavedTokens: 128,
    baselineSuffixBudget: 2048,
    minSuffixBudget: 512,
    maxSuffixBudget: 4096,
    semanticRisk: 0.3,
  };

  it("returns baseline when adaptive is disabled", () => {
    const eff = getEffectiveProfile(
      makeState(),
      "standard-stale",
      baseProfile,
      false,
    );
    expect(eff.suffixBudget).toBe(baseProfile.baselineSuffixBudget);
    expect(eff.minSavedTokens).toBe(baseProfile.minSavedTokens);
  });

  it("returns baseline when state is undefined", () => {
    const eff = getEffectiveProfile(
      undefined,
      "standard-stale",
      baseProfile,
      true,
    );
    expect(eff.suffixBudget).toBe(baseProfile.baselineSuffixBudget);
  });

  it("keeps the baseline suffix budget before telemetry adjusts aggressiveness", () => {
    const state = makeState();
    state.recentCacheSamples.push(
      sample({ input: 100, cacheRead: 50, cacheWrite: 10 }),
      sample({ input: 100, cacheRead: 50, cacheWrite: 10 }),
    );
    const eff = getEffectiveProfile(state, "standard-stale", baseProfile, true);
    expect(eff.suffixBudget).toBe(baseProfile.baselineSuffixBudget);
    expect(eff.minSavedTokens).toBe(baseProfile.minSavedTokens);
  });

  it("keeps real default profiles at baseline after neutral telemetry", () => {
    const state = makeState();
    ingestAssistantUsage(state, {
      role: "assistant",
      provider: "p",
      model: "m",
      timestamp: 1,
      usage: { input: 100, cacheRead: 50, cacheWrite: 0 },
    });
    ingestAssistantUsage(state, {
      role: "assistant",
      provider: "p",
      model: "m",
      timestamp: 2,
      usage: { input: 100, cacheRead: 50, cacheWrite: 0 },
    });

    const profile = getProfileForReason("batch-pressure");
    const eff = getEffectiveProfile(state, "batch-pressure", profile, true);
    expect(eff.suffixBudget).toBe(profile.baselineSuffixBudget);
    expect(eff.minSavedTokens).toBe(profile.minSavedTokens);
  });

  it("returns baseline after provider/model switch until enough relevant samples exist", () => {
    const state = makeState();
    state.recentCacheSamples.push(
      sample({ input: 100, cacheRead: 100, cacheWrite: 0 }),
      sample({ input: 100, cacheRead: 100, cacheWrite: 0 }),
    );
    state.aggressivenessByReason.set("standard-stale", 1);

    ingestAssistantUsage(state, {
      role: "assistant",
      provider: "other",
      model: "other-model",
      timestamp: 1,
      usage: { input: 100, cacheRead: 0, cacheWrite: 0 },
    });

    const eff = getEffectiveProfile(state, "standard-stale", baseProfile, true);
    expect(eff.suffixBudget).toBe(baseProfile.baselineSuffixBudget);
    expect(eff.minSavedTokens).toBe(baseProfile.minSavedTokens);
  });

  it("clamps minSavedTokens within bounds", () => {
    const state = makeState();
    state.recentCacheSamples.push(
      sample({ input: 100, cacheRead: 50, cacheWrite: 10 }),
      sample({ input: 100, cacheRead: 50, cacheWrite: 10 }),
    );
    state.aggressivenessByReason.set("standard-stale", 1.0);
    const eff = getEffectiveProfile(state, "standard-stale", baseProfile, true);
    const baselineAgg =
      (baseProfile.baselineSuffixBudget - baseProfile.minSuffixBudget) /
      (baseProfile.maxSuffixBudget - baseProfile.minSuffixBudget);
    expect(eff.minSavedTokens).toBe(
      Math.round(baseProfile.minSavedTokens * (1 - 0.5 * (1 - baselineAgg))),
    );
    expect(eff.suffixBudget).toBe(baseProfile.maxSuffixBudget);
  });

  it("clamps minSavedTokens within bounds at aggressiveness 0", () => {
    const state = makeState();
    state.recentCacheSamples.push(
      sample({ input: 100, cacheRead: 50, cacheWrite: 10 }),
      sample({ input: 100, cacheRead: 50, cacheWrite: 10 }),
    );
    state.aggressivenessByReason.set("standard-stale", 0.0);
    const eff = getEffectiveProfile(state, "standard-stale", baseProfile, true);
    const baselineAgg =
      (baseProfile.baselineSuffixBudget - baseProfile.minSuffixBudget) /
      (baseProfile.maxSuffixBudget - baseProfile.minSuffixBudget);
    expect(eff.minSavedTokens).toBe(
      Math.round(baseProfile.minSavedTokens * (1 - 0.5 * (0 - baselineAgg))),
    );
    expect(eff.suffixBudget).toBe(baseProfile.minSuffixBudget);
  });
});

describe("adaptive policy update rules", () => {
  const baseProfile: PolicyProfile = {
    minSavedTokens: 128,
    baselineSuffixBudget: 2048,
    minSuffixBudget: 512,
    maxSuffixBudget: 4096,
    semanticRisk: 0.3,
  };

  it("does not change latched elisions after policy update", () => {
    const state = makeState();
    recordElision(state, {
      toolCallId: "call-1",
      reason: "standard-stale",
      toolName: "bash",
      originalTokens: 1000,
    });
    expect(state.latched.size).toBe(1);

    const latchedBefore = state.latched.get("call-1");
    ingestAssistantUsage(state, {
      role: "assistant",
      provider: "p",
      model: "m",
      timestamp: 1,
      usage: { input: 100, cacheRead: 0, cacheWrite: 0 },
    });
    const latchedAfter = state.latched.get("call-1");
    expect(latchedAfter).toEqual(latchedBefore);
  });

  it("single extreme cache-hit value changes aggressiveness by no more than step size", () => {
    const state = makeState();
    const before = getEffectiveProfile(
      state,
      "standard-stale",
      baseProfile,
      true,
    ).suffixBudget;

    ingestAssistantUsage(state, {
      role: "assistant",
      provider: "p",
      model: "m",
      timestamp: 1,
      usage: { input: 100, cacheRead: 0, cacheWrite: 0 },
    });

    const after = getEffectiveProfile(
      state,
      "standard-stale",
      baseProfile,
      true,
    ).suffixBudget;
    const maxDelta = baseProfile.maxSuffixBudget - baseProfile.minSuffixBudget;
    const step = 0.05 * maxDelta;
    expect(Math.abs(after - before)).toBeLessThanOrEqual(step + 1);
  });

  it("bounds effective values within min/max clamps even with extreme telemetry", () => {
    const state = makeState();
    for (let i = 0; i < 20; i++) {
      ingestAssistantUsage(state, {
        role: "assistant",
        provider: "p",
        model: "m",
        timestamp: i,
        usage: { input: 0, cacheRead: 0, cacheWrite: 0 },
      });
    }
    const eff = getEffectiveProfile(state, "standard-stale", baseProfile, true);
    expect(eff.suffixBudget).toBeGreaterThanOrEqual(
      baseProfile.minSuffixBudget,
    );
    expect(eff.suffixBudget).toBeLessThanOrEqual(baseProfile.maxSuffixBudget);
    expect(eff.minSavedTokens).toBeGreaterThanOrEqual(
      Math.round(baseProfile.minSavedTokens * 0.5),
    );
    expect(eff.minSavedTokens).toBeLessThanOrEqual(
      Math.round(baseProfile.minSavedTokens * 1.5),
    );
  });

  it("decreases aggressiveness when smoothedRecallRate > 0.25", () => {
    const state = makeState();
    for (let i = 0; i < 5; i++) {
      recordElision(state, {
        toolCallId: `call-${i}`,
        reason: "standard-stale",
        toolName: "bash",
        originalTokens: 1000,
      });
    }
    state.recallCountByReason.set("standard-stale", 2);
    const before = getEffectiveProfile(
      state,
      "standard-stale",
      baseProfile,
      true,
    ).suffixBudget;
    ingestAssistantUsage(state, {
      role: "assistant",
      provider: "p",
      model: "m",
      timestamp: 1,
      usage: { input: 100, cacheRead: 100, cacheWrite: 0 },
    });
    const after = getEffectiveProfile(
      state,
      "standard-stale",
      baseProfile,
      true,
    ).suffixBudget;
    expect(after).toBeLessThanOrEqual(before);
  });

  it("increases aggressiveness when elisions >= 5 and recalls === 0", () => {
    const state = makeState();
    for (let i = 0; i < 5; i++) {
      recordElision(state, {
        toolCallId: `call-${i}`,
        reason: "standard-stale",
        toolName: "bash",
        originalTokens: 1000,
      });
    }
    const before = getEffectiveProfile(
      state,
      "standard-stale",
      baseProfile,
      true,
    ).suffixBudget;
    ingestAssistantUsage(state, {
      role: "assistant",
      provider: "p",
      model: "m",
      timestamp: 1,
      usage: { input: 100, cacheRead: 100, cacheWrite: 0 },
    });
    const after = getEffectiveProfile(
      state,
      "standard-stale",
      baseProfile,
      true,
    ).suffixBudget;
    expect(after).toBeGreaterThanOrEqual(before);
  });

  it("increases batch cooldown after cache-hit drop following non-emergency batch", () => {
    const state = makeState();
    for (let i = 0; i < 2; i++) {
      ingestAssistantUsage(state, {
        role: "assistant",
        provider: "p",
        model: "m",
        timestamp: i,
        usage: { input: 0, cacheRead: 100, cacheWrite: 0 },
      });
    }
    state.nonEmergencyBatchSinceLastUsage = true;
    const before = state.batchCooldownExtraTurns ?? 0;
    ingestAssistantUsage(state, {
      role: "assistant",
      provider: "p",
      model: "m",
      timestamp: 10,
      usage: { input: 100, cacheRead: 0, cacheWrite: 0 },
    });
    expect(state.batchCooldownExtraTurns).toBe(before + 1);
  });

  it("caps batchCooldownExtraTurns at 5", () => {
    const state = makeState();
    state.batchCooldownExtraTurns = 5;
    state.nonEmergencyBatchSinceLastUsage = true;
    ingestAssistantUsage(state, {
      role: "assistant",
      provider: "p",
      model: "m",
      timestamp: 1,
      usage: { input: 100, cacheRead: 0, cacheWrite: 0 },
    });
    expect(state.batchCooldownExtraTurns).toBe(5);
  });
});

describe("formatTelemetryDiagnostics", () => {
  it("includes recent cache hit without duplicate reason sections", () => {
    const state = makeState();
    ingestAssistantUsage(state, {
      role: "assistant",
      provider: "p",
      model: "m",
      timestamp: 1,
      usage: { input: 100, cacheRead: 50, cacheWrite: 10 },
    });
    recordElision(state, {
      toolCallId: "call-1",
      reason: "standard-stale",
      toolName: "bash",
      originalTokens: 1000,
    });
    state.recallCountByReason.set("duplicate-read-young", 1);

    const text = formatTelemetryDiagnostics(state);

    expect(text).toContain("recent cache hit:");
    expect(text).not.toContain("elisions by reason:");
    expect(text).not.toContain("recalls by reason:");
    expect(text).not.toContain("standard-stale: 1");
    expect(text).not.toContain("duplicate-read-young: 1");
    expect(text).not.toContain("effective profiles:");
    expect(text).not.toContain("suffixBudget=");
    expect(text).not.toContain("minSavedTokens=");
  });

  it("includes context usage when available", () => {
    const state = makeState();
    state.contextUsage = {
      tokens: 104517,
      contextWindow: 1050000,
      percent: 9.954,
    };
    const text = formatTelemetryDiagnostics(state);
    expect(text).toContain("context usage:");
    expect(text).toContain("104,517 / 1,050,000 tokens (10.0%)");
  });

  it("handles unknown tokens gracefully", () => {
    const state = makeState();
    state.contextUsage = { tokens: null, contextWindow: 100000, percent: null };
    const text = formatTelemetryDiagnostics(state);
    expect(text).toContain("unknown / 100,000 tokens");
  });
});

describe("recall telemetry attribution", () => {
  it("counts recall by toolCallId, tool name, and elision reason", async () => {
    const state = makeState();
    recordElision(state, {
      toolCallId: "call-1",
      reason: "duplicate-read-young",
      toolName: "read",
      originalTokens: 1000,
    });

    let capturedDef: any = null;
    const recalls: Array<{
      toolName: string;
      toolCallId?: string;
      reason?: string;
    }> = [];
    registerRecallTool(
      {
        registerTool(def: any) {
          capturedDef = def;
        },
      } as any,
      (toolName, toolCallId, reason) => {
        recalls.push({ toolName, toolCallId, reason });
      },
      state,
    );

    const result = await capturedDef.execute(
      "recall-call",
      { id: "call-1" },
      undefined,
      undefined,
      {
        sessionManager: {
          getEntries: () => [makeSessionEntry("call-1", "read", "original")],
        },
      },
    );

    expect(result.isError).toBeFalsy();
    expect(recalls).toEqual([
      {
        toolName: "read",
        toolCallId: "call-1",
        reason: "duplicate-read-young",
      },
    ]);
    expect(state.recallCountByReason.get("duplicate-read-young")).toBe(1);
  });
});

describe("sparse telemetry fallback", () => {
  it("falls back to baseline before any assistant usage data", () => {
    const state = makeState();
    const baseProfile: PolicyProfile = {
      minSavedTokens: 128,
      baselineSuffixBudget: 2048,
      minSuffixBudget: 512,
      maxSuffixBudget: 4096,
      semanticRisk: 0.3,
    };
    const eff = getEffectiveProfile(state, "standard-stale", baseProfile, true);
    expect(eff.suffixBudget).toBe(baseProfile.baselineSuffixBudget);
    expect(eff.minSavedTokens).toBe(baseProfile.minSavedTokens);
  });
});
