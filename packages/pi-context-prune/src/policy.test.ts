import { describe, it, expect } from "vitest";
import {
  createPruningState,
  getLatchedElision,
  recordElision,
  recordRecall,
  resetPruningState,
  pruneLatchedElisions,
  clampProfile,
  DEFAULT_PROFILE,
  CONSERVATIVE_PROFILE,
  AGGRESSIVE_PROFILE,
  setActiveProfile,
  DEFAULT_POLICY_PROFILES,
} from "./policy.ts";

describe("createPruningState", () => {
  it("tracks elisions and recalls by reason", () => {
    const state = createPruningState();

    recordElision(state, {
      toolCallId: "call-1",
      reason: "standard-stale",
      toolName: "read",
      originalTokens: 100,
      stubTokens: 10,
    });
    recordElision(state, {
      toolCallId: "call-2",
      reason: "duplicate-read-young",
      toolName: "read",
      originalTokens: 50,
    });
    recordRecall(state, "call-1", "standard-stale");
    recordRecall(state, "call-1", "standard-stale");

    const latched = getLatchedElision(state, "call-1");
    expect(latched?.reason).toBe("standard-stale");
    expect(latched?.toolName).toBe("read");
    expect(latched?.originalTokens).toBe(100);
    expect(state.elisionCountByReason.get("standard-stale")).toBe(1);
    expect(state.elisionCountByReason.get("duplicate-read-young")).toBe(1);
    expect(state.recallCountByReason.get("standard-stale")).toBe(1);
  });
});

describe("pruneLatchedElisions", () => {
  it("drops latched and recalled ids that are no longer active", () => {
    const state = createPruningState();
    recordElision(state, {
      toolCallId: "keep",
      reason: "standard-stale",
      toolName: "read",
      originalTokens: 100,
    });
    recordElision(state, {
      toolCallId: "drop",
      reason: "standard-stale",
      toolName: "read",
      originalTokens: 100,
    });
    recordRecall(state, "keep", "standard-stale");
    recordRecall(state, "drop", "standard-stale");

    pruneLatchedElisions(state, new Set(["keep"]));

    expect(state.latched.has("keep")).toBe(true);
    expect(state.latched.has("drop")).toBe(false);
    expect(state.recallsByToolCallId.has("keep")).toBe(true);
    expect(state.recallsByToolCallId.has("drop")).toBe(false);
  });
});

describe("resetPruningState", () => {
  it("clears latched elisions and adaptive counters", () => {
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
  it("preserves valid profiles", () => {
    const profile = {
      minSavedTokens: 128,
      baselineSuffixBudget: 2048,
      minSuffixBudget: 512,
      maxSuffixBudget: 4096,
      semanticRisk: 0.3,
    };

    expect(clampProfile(profile)).toEqual(profile);
  });

  it("clamps out-of-range values", () => {
    const profile = clampProfile({
      minSavedTokens: -1,
      baselineSuffixBudget: 200_000,
      minSuffixBudget: -5,
      maxSuffixBudget: 500,
      semanticRisk: 1.5,
    });

    expect(profile).toEqual({
      minSavedTokens: 0,
      baselineSuffixBudget: 100_000,
      minSuffixBudget: 0,
      maxSuffixBudget: 500,
      semanticRisk: 1,
    });
  });

  it("does not allow maxSuffixBudget below minSuffixBudget", () => {
    const profile = clampProfile({
      ...DEFAULT_PROFILE,
      minSuffixBudget: 1000,
      maxSuffixBudget: 500,
    });

    expect(profile.maxSuffixBudget).toBe(1000);
  });
});

describe("setActiveProfile", () => {
  it("stores a clamped active profile", () => {
    const state = createPruningState();
    setActiveProfile(state, CONSERVATIVE_PROFILE);
    expect(state.activeProfile).toEqual(CONSERVATIVE_PROFILE);

    setActiveProfile(state, {
      ...DEFAULT_PROFILE,
      semanticRisk: 99,
      minSavedTokens: -50,
    });
    expect(state.activeProfile.semanticRisk).toBe(1);
    expect(state.activeProfile.minSavedTokens).toBe(0);
  });
});

describe("DEFAULT_POLICY_PROFILES", () => {
  it("after-consumption-bash minSavedTokens is 512", () => {
    expect(
      DEFAULT_POLICY_PROFILES["after-consumption-bash"].minSavedTokens,
    ).toBe(512);
  });
});
