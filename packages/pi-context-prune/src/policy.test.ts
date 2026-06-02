import { describe, it, expect } from "vitest";
import {
  createPruningState,
  getLatchedElision,
  recordElision,
  recordRecall,
  resetPruningState,
  clampProfile,
  DEFAULT_PROFILE,
  CONSERVATIVE_PROFILE,
  AGGRESSIVE_PROFILE,
  setActiveProfile,
} from "./policy.ts";

describe("createPruningState", () => {
  it("starts empty", () => {
    const state = createPruningState();
    expect(state.latched.size).toBe(0);
    expect(state.recallsByToolCallId.size).toBe(0);
    expect(state.recallCountByReason.size).toBe(0);
    expect(state.elisionCountByReason.size).toBe(0);
    expect(state.activeProfile).toEqual(DEFAULT_PROFILE);
  });

  it("records an elision with reason", () => {
    const state = createPruningState();
    recordElision(state, {
      toolCallId: "call-1",
      reason: "standard-stale",
      toolName: "read",
      originalTokens: 100,
      stubTokens: 10,
    });
    const latched = getLatchedElision(state, "call-1");
    expect(latched).toBeDefined();
    expect(latched!.reason).toBe("standard-stale");
    expect(latched!.toolName).toBe("read");
    expect(latched!.originalTokens).toBe(100);
  });

  it("records recalls by reason", () => {
    const state = createPruningState();
    recordRecall(state, "call-1", "standard-stale");
    recordRecall(state, "call-2", "duplicate-read-young");
    recordRecall(state, "call-1", "standard-stale"); // dedup
    expect(state.recallCountByReason.get("standard-stale")).toBe(1);
    expect(state.recallCountByReason.get("duplicate-read-young")).toBe(1);
  });

  it("counts elisions by reason", () => {
    const state = createPruningState();
    recordElision(state, {
      toolCallId: "call-1",
      reason: "standard-stale",
      toolName: "read",
      originalTokens: 100,
    });
    recordElision(state, {
      toolCallId: "call-2",
      reason: "duplicate-read-young",
      toolName: "read",
      originalTokens: 50,
    });
    recordElision(state, {
      toolCallId: "call-3",
      reason: "superseded-read-young",
      toolName: "read",
      originalTokens: 75,
    });
    expect(state.elisionCountByReason.get("standard-stale")).toBe(1);
    expect(state.elisionCountByReason.get("duplicate-read-young")).toBe(1);
    expect(state.elisionCountByReason.get("superseded-read-young")).toBe(1);
  });
});

describe("resetPruningState", () => {
  it("clears latched elisions and adaptive counters and resets activeProfile", () => {
    const state = createPruningState();
    setActiveProfile(state, AGGRESSIVE_PROFILE);
    recordElision(state, {
      toolCallId: "call-1",
      reason: "standard-stale",
      toolName: "read",
      originalTokens: 100,
    });
    recordRecall(state, "call-1", "standard-stale");
    resetPruningState(state);
    expect(state.latched.size).toBe(0);
    expect(state.recallsByToolCallId.size).toBe(0);
    expect(state.recallCountByReason.size).toBe(0);
    expect(state.elisionCountByReason.size).toBe(0);
    expect(state.activeProfile).toEqual(DEFAULT_PROFILE);
  });
});

describe("clampProfile", () => {
  it("leaves valid profiles unchanged", () => {
    const p = clampProfile({
      minSavedTokens: 128,
      baselineSuffixBudget: 2048,
      minSuffixBudget: 512,
      maxSuffixBudget: 4096,
      semanticRisk: 0.3,
    });
    expect(p).toEqual({
      minSavedTokens: 128,
      baselineSuffixBudget: 2048,
      minSuffixBudget: 512,
      maxSuffixBudget: 4096,
      semanticRisk: 0.3,
    });
  });

  it("clamps minSavedTokens to [0, 10000]", () => {
    expect(
      clampProfile({ ...DEFAULT_PROFILE, minSavedTokens: -1 }).minSavedTokens,
    ).toBe(0);
    expect(
      clampProfile({ ...DEFAULT_PROFILE, minSavedTokens: 20_000 })
        .minSavedTokens,
    ).toBe(10_000);
  });

  it("clamps baselineSuffixBudget to [0, 100000]", () => {
    expect(
      clampProfile({ ...DEFAULT_PROFILE, baselineSuffixBudget: -10 })
        .baselineSuffixBudget,
    ).toBe(0);
    expect(
      clampProfile({ ...DEFAULT_PROFILE, baselineSuffixBudget: 200_000 })
        .baselineSuffixBudget,
    ).toBe(100_000);
  });

  it("clamps minSuffixBudget to [0, 100000]", () => {
    expect(
      clampProfile({ ...DEFAULT_PROFILE, minSuffixBudget: -5 }).minSuffixBudget,
    ).toBe(0);
    expect(
      clampProfile({ ...DEFAULT_PROFILE, minSuffixBudget: 200_000 })
        .minSuffixBudget,
    ).toBe(100_000);
  });

  it("clamps maxSuffixBudget to [minSuffixBudget, 100000]", () => {
    const p = clampProfile({
      ...DEFAULT_PROFILE,
      minSuffixBudget: 1000,
      maxSuffixBudget: 500,
    });
    expect(p.maxSuffixBudget).toBe(1000);
  });

  it("clamps semanticRisk to [0, 1]", () => {
    expect(
      clampProfile({ ...DEFAULT_PROFILE, semanticRisk: -0.1 }).semanticRisk,
    ).toBe(0);
    expect(
      clampProfile({ ...DEFAULT_PROFILE, semanticRisk: 1.5 }).semanticRisk,
    ).toBe(1);
  });
});

describe("profile constants", () => {
  it("DEFAULT_PROFILE values are clamped and within bounds", () => {
    const p = DEFAULT_PROFILE;
    expect(p.minSavedTokens).toBeGreaterThanOrEqual(0);
    expect(p.minSavedTokens).toBeLessThanOrEqual(10_000);
    expect(p.baselineSuffixBudget).toBeGreaterThanOrEqual(0);
    expect(p.baselineSuffixBudget).toBeLessThanOrEqual(100_000);
    expect(p.minSuffixBudget).toBeLessThanOrEqual(p.maxSuffixBudget);
    expect(p.semanticRisk).toBeGreaterThanOrEqual(0);
    expect(p.semanticRisk).toBeLessThanOrEqual(1);
  });

  it("CONSERVATIVE_PROFILE is more conservative than DEFAULT", () => {
    expect(CONSERVATIVE_PROFILE.minSavedTokens).toBeGreaterThanOrEqual(
      DEFAULT_PROFILE.minSavedTokens,
    );
    expect(CONSERVATIVE_PROFILE.semanticRisk).toBeLessThanOrEqual(
      DEFAULT_PROFILE.semanticRisk,
    );
  });

  it("AGGRESSIVE_PROFILE is more aggressive than DEFAULT", () => {
    expect(AGGRESSIVE_PROFILE.minSavedTokens).toBeLessThanOrEqual(
      DEFAULT_PROFILE.minSavedTokens,
    );
    expect(AGGRESSIVE_PROFILE.semanticRisk).toBeGreaterThanOrEqual(
      DEFAULT_PROFILE.semanticRisk,
    );
  });
});

describe("setActiveProfile", () => {
  it("updates activeProfile in pruning state", () => {
    const state = createPruningState();
    expect(state.activeProfile).toEqual(DEFAULT_PROFILE);
    setActiveProfile(state, CONSERVATIVE_PROFILE);
    expect(state.activeProfile).toEqual(CONSERVATIVE_PROFILE);
  });

  it("clamps the profile before storing", () => {
    const state = createPruningState();
    setActiveProfile(state, {
      ...DEFAULT_PROFILE,
      semanticRisk: 99,
      minSavedTokens: -50,
    });
    expect(state.activeProfile.semanticRisk).toBe(1);
    expect(state.activeProfile.minSavedTokens).toBe(0);
  });
});

describe("ElisionReason type coverage", () => {
  // These reasons exist in the type system even if the current hook
  // does not yet trigger all of them. Future tasks will wire the
  // remaining paths.
  const allReasons = [
    "standard-stale",
    "after-consumption-bash",
    "duplicate-read-young",
    "superseded-read-young",
    "batch-pressure",
    "emergency-pressure",
  ] as const;

  it("every reason can be stored in pruning state", () => {
    const state = createPruningState();
    for (let i = 0; i < allReasons.length; i++) {
      recordElision(state, {
        toolCallId: `call-${i}`,
        reason: allReasons[i],
        toolName: "read",
        originalTokens: 100,
      });
    }
    for (const reason of allReasons) {
      expect(state.elisionCountByReason.get(reason)).toBe(1);
    }
  });
});
