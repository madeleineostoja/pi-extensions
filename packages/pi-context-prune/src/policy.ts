export type ElisionReason =
  | "standard-stale"
  | "after-consumption-bash"
  | "duplicate-read-young"
  | "superseded-read-young"
  | "batch-pressure"
  | "emergency-pressure";

export type ElisionCandidate = {
  index: number;
  toolCallId: string;
  toolName: string;
  originalTokens: number;
  estimatedStubTokens: number;
  savedTokens: number;
  suffixTokens: number;
  possibleReasons: ElisionReason[];
  semanticRisk: number;
  priority: number;
};

export type LatchedElision = {
  toolCallId: string;
  reason: ElisionReason;
  toolName: string;
  originalTokens: number;
  stubTokens?: number;
  firstElidedTurnIndex?: number;
  normalizedPath?: string;
  keptUserTurnIndex?: number;
  command?: string;
  sourceReason?: ElisionReason;
};

export type PolicyProfile = {
  minSavedTokens: number;
  baselineSuffixBudget: number;
  minSuffixBudget: number;
  maxSuffixBudget: number;
  semanticRisk: number;
};

const MIN_MIN_SAVED_TOKENS = 0;
const MAX_MIN_SAVED_TOKENS = 10000;
const MIN_BASELINE_SUFFIX_BUDGET = 0;
const MAX_BASELINE_SUFFIX_BUDGET = 100000;
const MIN_SUFFIX_BUDGET = 0;
const MAX_SUFFIX_BUDGET = 100000;
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

export const DEFAULT_POLICY_PROFILES: Record<
  Exclude<ElisionReason, "emergency-pressure">,
  PolicyProfile
> = {
  "standard-stale": clampProfile({
    minSavedTokens: 1500,
    baselineSuffixBudget: 25000,
    minSuffixBudget: 5000,
    maxSuffixBudget: 80000,
    semanticRisk: 0.4,
  }),
  "after-consumption-bash": clampProfile({
    minSavedTokens: 1000,
    baselineSuffixBudget: 20000,
    minSuffixBudget: 5000,
    maxSuffixBudget: 60000,
    semanticRisk: 0.15,
  }),
  "duplicate-read-young": clampProfile({
    minSavedTokens: 1000,
    baselineSuffixBudget: 10000,
    minSuffixBudget: 2000,
    maxSuffixBudget: 30000,
    semanticRisk: 0.35,
  }),
  "superseded-read-young": clampProfile({
    minSavedTokens: 2000,
    baselineSuffixBudget: 8000,
    minSuffixBudget: 2000,
    maxSuffixBudget: 25000,
    semanticRisk: 0.45,
  }),
  "batch-pressure": clampProfile({
    minSavedTokens: 1500,
    baselineSuffixBudget: 25000,
    minSuffixBudget: 5000,
    maxSuffixBudget: 80000,
    semanticRisk: 0.4,
  }),
};

export const BATCH_PRIORITY: Record<
  Exclude<ElisionReason, "emergency-pressure">,
  number
> = {
  "after-consumption-bash": 1,
  "duplicate-read-young": 2,
  "superseded-read-young": 3,
  "standard-stale": 4,
  "batch-pressure": 5,
};

const STUB_PRECEDENCE: Array<
  Exclude<ElisionReason, "emergency-pressure" | "batch-pressure">
> = [
  "superseded-read-young",
  "duplicate-read-young",
  "after-consumption-bash",
  "standard-stale",
];

export function getPrimaryReason(reasons: ElisionReason[]): ElisionReason {
  for (const r of STUB_PRECEDENCE) {
    if (reasons.includes(r)) {
      return r;
    }
  }
  return reasons[0];
}

export function getProfileForReason(
  reason: Exclude<ElisionReason, "emergency-pressure">,
): PolicyProfile {
  return DEFAULT_POLICY_PROFILES[reason] ?? DEFAULT_PROFILE;
}

export type PruningState = {
  latched: Map<string, LatchedElision>;
  recallsByToolCallId: Set<string>;
  recallCountByReason: Map<ElisionReason, number>;
  elisionCountByReason: Map<ElisionReason, number>;
  activeProfile: PolicyProfile;
  usageHistory: Array<{
    cacheRead: number;
    cacheWrite: number;
    totalTokens: number;
  }>;
  lastBatchUserTurnCount: number;
  recentCacheSamples: import("./telemetry.ts").CacheSample[];
  seenUsageKeys: Set<string>;
  aggressivenessByReason: Map<ElisionReason, number>;
  contextUsage?: {
    tokens: number | null;
    contextWindow: number;
    percent: number | null;
  };
  lastRotPressure?: number;
  nonEmergencyBatchSinceLastUsage: boolean;
  batchCooldownExtraTurns: number;
};

export function createPruningState(): PruningState {
  return {
    latched: new Map(),
    recallsByToolCallId: new Set(),
    recallCountByReason: new Map(),
    elisionCountByReason: new Map(),
    activeProfile: { ...DEFAULT_PROFILE },
    usageHistory: [],
    lastBatchUserTurnCount: -Infinity,
    recentCacheSamples: [],
    seenUsageKeys: new Set(),
    aggressivenessByReason: new Map(),
    nonEmergencyBatchSinceLastUsage: false,
    batchCooldownExtraTurns: 0,
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

export function pruneLatchedElisions(
  state: PruningState,
  activeToolCallIds: Set<string>,
): void {
  for (const toolCallId of state.latched.keys()) {
    if (!activeToolCallIds.has(toolCallId)) {
      state.latched.delete(toolCallId);
      state.recallsByToolCallId.delete(toolCallId);
    }
  }
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
  state.usageHistory = [];
  state.lastBatchUserTurnCount = -Infinity;
  state.recentCacheSamples = [];
  state.seenUsageKeys.clear();
  state.aggressivenessByReason.clear();
  state.contextUsage = undefined;
  state.lastRotPressure = undefined;
  state.nonEmergencyBatchSinceLastUsage = false;
  state.batchCooldownExtraTurns = 0;
}

export function setActiveProfile(
  state: PruningState,
  profile: PolicyProfile,
): void {
  state.activeProfile = clampProfile(profile);
}
