import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  getProfileForReason,
  type ElisionReason,
  type PolicyProfile,
  type PruningState,
} from "./policy.ts";

export type CacheSample = {
  provider?: string;
  model?: string;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  cacheHit: number;
};

export type EffectiveProfile = {
  suffixBudget: number;
  minSavedTokens: number;
};

const REASONS: ElisionReason[] = [
  "standard-stale",
  "after-consumption-bash",
  "duplicate-read-young",
  "superseded-read-young",
  "batch-pressure",
  "emergency-pressure",
];

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function latestSample(state: PruningState): CacheSample | undefined {
  return state.recentCacheSamples[state.recentCacheSamples.length - 1];
}

function sameProviderModel(
  a: { provider?: string; model?: string },
  b: { provider?: string; model?: string },
): boolean {
  return a.provider === b.provider && a.model === b.model;
}

function matchingSamples(
  samples: CacheSample[],
  provider?: string,
  model?: string,
): CacheSample[] {
  return samples.filter((s) => s.provider === provider && s.model === model);
}

function hasEnoughRelevantSamples(state: PruningState): boolean {
  const current = latestSample(state);
  if (!current) {
    return false;
  }
  return (
    matchingSamples(state.recentCacheSamples, current.provider, current.model)
      .length >= 2
  );
}

function diagnosticProfileForReason(reason: ElisionReason): PolicyProfile {
  if (reason === "standard-stale" || reason === "emergency-pressure") {
    return getProfileForReason("batch-pressure");
  }
  return getProfileForReason(reason);
}

function baselineAggressiveness(profile: PolicyProfile): number {
  const range = profile.maxSuffixBudget - profile.minSuffixBudget;
  if (range <= 0) {
    return 0.5;
  }
  return clamp(
    (profile.baselineSuffixBudget - profile.minSuffixBudget) / range,
    0,
    1,
  );
}

export function computeRecentCacheHit(
  samples: CacheSample[],
  currentProvider?: string,
  currentModel?: string,
): number {
  const relevant = matchingSamples(samples, currentProvider, currentModel);
  if (relevant.length < 2) {
    return 0.5;
  }
  const recent = relevant.slice(-5);
  let total = 0;
  for (const s of recent) {
    const denom = s.input + s.cacheRead + s.cacheWrite;
    total += denom > 0 ? s.cacheRead / denom : 0;
  }
  return total / recent.length;
}

export function captureContextUsage(
  state: PruningState | undefined,
  ctx: ExtensionContext,
): ReturnType<NonNullable<ExtensionContext["getContextUsage"]>> | undefined {
  const usage = ctx.getContextUsage?.();
  if (!state) {
    return usage;
  }
  if (!usage) {
    state.contextUsage = undefined;
    return usage;
  }
  state.contextUsage = {
    tokens: usage.tokens,
    contextWindow: usage.contextWindow,
    percent: usage.percent,
  };
  return usage;
}

function makeUsageKey(msg: {
  timestamp?: number;
  provider?: string;
  model?: string;
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
}): string {
  const u = msg.usage;
  return [
    msg.timestamp ?? "",
    msg.provider ?? "",
    msg.model ?? "",
    u?.input ?? "",
    u?.output ?? "",
    u?.cacheRead ?? "",
    u?.cacheWrite ?? "",
  ].join("|");
}

export function ingestAssistantUsage(
  state: PruningState,
  msg: {
    role?: string;
    provider?: string;
    model?: string;
    timestamp?: number;
    usage?: {
      input?: number;
      output?: number;
      cacheRead?: number;
      cacheWrite?: number;
    };
  },
  adaptiveEnabled = true,
): boolean {
  if (msg.role !== undefined && msg.role !== "assistant") {
    return false;
  }
  if (!msg.usage) {
    return false;
  }
  const key = makeUsageKey(msg);
  if (state.seenUsageKeys.has(key)) {
    return false;
  }
  state.seenUsageKeys.add(key);

  const previous = latestSample(state);
  if (previous && !sameProviderModel(previous, msg)) {
    state.aggressivenessByReason.clear();
    state.nonEmergencyBatchSinceLastUsage = false;
    state.batchCooldownExtraTurns = 0;
  }

  const input = msg.usage.input ?? 0;
  const cacheRead = msg.usage.cacheRead ?? 0;
  const cacheWrite = msg.usage.cacheWrite ?? 0;
  const denom = input + cacheRead + cacheWrite;
  const cacheHit = denom > 0 ? cacheRead / denom : 0;

  const prevAvg = computeRecentCacheHit(
    state.recentCacheSamples,
    msg.provider,
    msg.model,
  );

  state.recentCacheSamples.push({
    provider: msg.provider,
    model: msg.model,
    input,
    cacheRead,
    cacheWrite,
    cacheHit,
  });

  const newAvg = computeRecentCacheHit(
    state.recentCacheSamples,
    msg.provider,
    msg.model,
  );

  if (adaptiveEnabled) {
    updateAdaptivePolicy(state, prevAvg, newAvg);
  } else {
    state.nonEmergencyBatchSinceLastUsage = false;
  }

  return true;
}

function smoothedRecallRate(
  state: PruningState,
  reason: ElisionReason,
): number {
  const elisions = state.elisionCountByReason.get(reason) ?? 0;
  const recalls = state.recallCountByReason.get(reason) ?? 0;
  return (recalls + 1) / (elisions + 5);
}

function updateAdaptivePolicy(
  state: PruningState,
  prevAvg: number,
  newAvg: number,
): void {
  const current = latestSample(state);
  const recentCacheHit = computeRecentCacheHit(
    state.recentCacheSamples,
    current?.provider,
    current?.model,
  );

  for (const reason of REASONS) {
    const startAgg =
      state.aggressivenessByReason.get(reason) ??
      baselineAggressiveness(diagnosticProfileForReason(reason));
    let agg = startAgg;

    if (smoothedRecallRate(state, reason) > 0.25) {
      agg -= 0.05;
    } else {
      const elisions = state.elisionCountByReason.get(reason) ?? 0;
      const recalls = state.recallCountByReason.get(reason) ?? 0;
      if (elisions >= 5 && recalls === 0) {
        agg += 0.02;
      }
    }

    if (
      (reason === "batch-pressure" ||
        reason === "standard-stale" ||
        reason === "emergency-pressure") &&
      recentCacheHit > 0.7 &&
      (state.lastRotPressure ?? 0) < 0.25
    ) {
      agg -= 0.03;
    }

    if (recentCacheHit < 0.3 || (state.lastRotPressure ?? 0) > 0.4) {
      agg += 0.03;
    }

    const delta = agg - startAgg;
    const clampedDelta = Math.max(-0.05, Math.min(0.05, delta));
    state.aggressivenessByReason.set(
      reason,
      clamp(startAgg + clampedDelta, 0, 1),
    );
  }

  if (state.nonEmergencyBatchSinceLastUsage) {
    if (prevAvg - newAvg >= 0.25) {
      state.batchCooldownExtraTurns = Math.min(
        5,
        state.batchCooldownExtraTurns + 1,
      );
    }
    state.nonEmergencyBatchSinceLastUsage = false;
  }
}

export function getEffectiveProfile(
  state: PruningState | undefined,
  reason: ElisionReason,
  baseProfile: PolicyProfile,
  adaptiveEnabled: boolean,
): EffectiveProfile {
  if (!adaptiveEnabled || !state || !hasEnoughRelevantSamples(state)) {
    return {
      suffixBudget: Math.max(
        baseProfile.minSuffixBudget,
        Math.min(baseProfile.maxSuffixBudget, baseProfile.baselineSuffixBudget),
      ),
      minSavedTokens: baseProfile.minSavedTokens,
    };
  }

  const agg =
    state.aggressivenessByReason.get(reason) ??
    baselineAggressiveness(baseProfile);
  const suffixBudget = lerp(
    baseProfile.minSuffixBudget,
    baseProfile.maxSuffixBudget,
    agg,
  );
  const baselineAgg = baselineAggressiveness(baseProfile);
  const minSavedTokens = clamp(
    baseProfile.minSavedTokens * (1 - 0.5 * (agg - baselineAgg)),
    baseProfile.minSavedTokens * 0.5,
    baseProfile.minSavedTokens * 1.5,
  );

  return {
    suffixBudget: Math.round(suffixBudget),
    minSavedTokens: Math.round(minSavedTokens),
  };
}

export function formatTelemetryDiagnostics(
  state: PruningState,
  adaptiveEnabled = true,
): string {
  const lines: string[] = [];
  const current = latestSample(state);
  const recentCacheHit = computeRecentCacheHit(
    state.recentCacheSamples,
    current?.provider,
    current?.model,
  );

  lines.push(`recent cache hit: ${(recentCacheHit * 100).toFixed(1)}%`);

  if (state.contextUsage) {
    const { tokens, contextWindow, percent } = state.contextUsage;
    if (tokens !== null) {
      lines.push(
        `context usage: ${tokens.toLocaleString()} / ${contextWindow.toLocaleString()} tokens (${((percent ?? 0) * 100).toFixed(1)}%)`,
      );
    } else {
      lines.push(
        `context usage: unknown / ${contextWindow.toLocaleString()} tokens`,
      );
    }
  }

  lines.push("elisions by reason:");
  for (const reason of REASONS) {
    const count = state.elisionCountByReason.get(reason) ?? 0;
    lines.push(`  ${reason}: ${count}`);
  }

  lines.push("recalls by reason:");
  for (const reason of REASONS) {
    const count = state.recallCountByReason.get(reason) ?? 0;
    lines.push(`  ${reason}: ${count}`);
  }

  lines.push("effective profiles:");
  for (const reason of REASONS) {
    const profile = diagnosticProfileForReason(reason);
    const agg =
      state.aggressivenessByReason.get(reason) ??
      baselineAggressiveness(profile);
    const effective = getEffectiveProfile(
      state,
      reason,
      profile,
      adaptiveEnabled,
    );
    lines.push(
      `  ${reason}: aggressiveness=${agg.toFixed(2)}, suffixBudget=${effective.suffixBudget.toLocaleString()}, minSavedTokens=${effective.minSavedTokens.toLocaleString()}`,
    );
  }

  return lines.join("\n");
}
