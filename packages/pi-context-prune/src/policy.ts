export type ElisionReason =
  | "standard-stale"
  | "after-consumption-bash"
  | "duplicate-read-young"
  | "superseded-read-young"
  | "batch-pressure"
  | "emergency-pressure";

export type LatchedElision = {
  toolCallId: string;
  reason: ElisionReason;
  toolName: string;
  originalTokens: number;
  stubTokens?: number;
  firstElidedTurnIndex?: number;
  // Populated for superseded/duplicate stubs so the exact stub text is latched.
  normalizedPath?: string;
  keptUserTurnIndex?: number;
  // Populated for after-consumption-bash stubs.
  command?: string;
};

export type PolicyProfile = {
  minSavedTokens: number;
  baselineSuffixBudget: number;
  minSuffixBudget: number;
  maxSuffixBudget: number;
  semanticRisk: number;
};

// Guardrail ranges prevent noisy telemetry from causing extreme behavior.
const MIN_MIN_SAVED_TOKENS = 0;
const MAX_MIN_SAVED_TOKENS = 1024;
const MIN_BASELINE_SUFFIX_BUDGET = 0;
const MAX_BASELINE_SUFFIX_BUDGET = 16384;
const MIN_SUFFIX_BUDGET = 0;
const MAX_SUFFIX_BUDGET = 32768;
const MIN_SEMANTIC_RISK = 0;
const MAX_SEMANTIC_RISK = 1;

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

export function clampProfile(profile: PolicyProfile): PolicyProfile {
  const minSavedTokens = clamp(
    profile.minSavedTokens,
    MIN_MIN_SAVED_TOKENS,
    MAX_MIN_SAVED_TOKENS,
  );
  const baselineSuffixBudget = clamp(
    profile.baselineSuffixBudget,
    MIN_BASELINE_SUFFIX_BUDGET,
    MAX_BASELINE_SUFFIX_BUDGET,
  );
  const minSuffixBudget = clamp(
    profile.minSuffixBudget,
    MIN_SUFFIX_BUDGET,
    MAX_SUFFIX_BUDGET,
  );
  const maxSuffixBudget = clamp(
    profile.maxSuffixBudget,
    minSuffixBudget,
    MAX_SUFFIX_BUDGET,
  );
  const semanticRisk = clamp(
    profile.semanticRisk,
    MIN_SEMANTIC_RISK,
    MAX_SEMANTIC_RISK,
  );
  return {
    minSavedTokens,
    baselineSuffixBudget,
    minSuffixBudget,
    maxSuffixBudget,
    semanticRisk,
  };
}

export const DEFAULT_PROFILE: PolicyProfile = clampProfile({
  minSavedTokens: 64,
  baselineSuffixBudget: 2048,
  minSuffixBudget: 512,
  maxSuffixBudget: 8192,
  semanticRisk: 0.2,
});

export const CONSERVATIVE_PROFILE: PolicyProfile = clampProfile({
  minSavedTokens: 256,
  baselineSuffixBudget: 4096,
  minSuffixBudget: 1024,
  maxSuffixBudget: 16384,
  semanticRisk: 0.05,
});

export const AGGRESSIVE_PROFILE: PolicyProfile = clampProfile({
  minSavedTokens: 0,
  baselineSuffixBudget: 1024,
  minSuffixBudget: 0,
  maxSuffixBudget: 4096,
  semanticRisk: 0.5,
});

export type PruningState = {
  latched: Map<string, LatchedElision>;
  recallsByToolCallId: Set<string>;
  recallCountByReason: Map<ElisionReason, number>;
  elisionCountByReason: Map<ElisionReason, number>;
  activeProfile: PolicyProfile;
};

export function createPruningState(): PruningState {
  return {
    latched: new Map(),
    recallsByToolCallId: new Set(),
    recallCountByReason: new Map(),
    elisionCountByReason: new Map(),
    activeProfile: { ...DEFAULT_PROFILE },
  };
}

export function getLatchedElision(
  state: PruningState,
  toolCallId: string,
): LatchedElision | undefined {
  return state.latched.get(toolCallId);
}

export function recordElision(
  state: PruningState,
  elision: LatchedElision,
): void {
  state.latched.set(elision.toolCallId, elision);
  state.elisionCountByReason.set(
    elision.reason,
    (state.elisionCountByReason.get(elision.reason) ?? 0) + 1,
  );
}

export function recordRecall(
  state: PruningState,
  toolCallId: string,
  reason: ElisionReason,
): void {
  if (!state.recallsByToolCallId.has(toolCallId)) {
    state.recallsByToolCallId.add(toolCallId);
    state.recallCountByReason.set(
      reason,
      (state.recallCountByReason.get(reason) ?? 0) + 1,
    );
  }
}

export function resetPruningState(state: PruningState): void {
  state.latched.clear();
  state.recallsByToolCallId.clear();
  state.recallCountByReason.clear();
  state.elisionCountByReason.clear();
  state.activeProfile = { ...DEFAULT_PROFILE };
}

export function setActiveProfile(
  state: PruningState,
  profile: PolicyProfile,
): void {
  state.activeProfile = clampProfile(profile);
}
