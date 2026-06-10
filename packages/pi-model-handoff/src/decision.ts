import { estimateTokens } from "@earendil-works/pi-coding-agent";
import type { CompactionPreparation } from "./compaction";

export type { CompactionPreparation } from "./compaction";

export type ModelSelectEvent = {
  type: "model_select";
  model: { provider: string; id: string };
  previousModel?: { provider: string; id: string };
  source: "set" | "cycle" | "restore";
};

export type ModelRef = {
  provider: string;
  id: string;
  name?: string;
  inputCostPerMillion?: number;
  outputCostPerMillion?: number;
  subscription?: boolean;
};

export type HandoffEstimate = {
  currentTokens: number;
  summarizedTokens: number;
  keptTokens: number;
  estimatedSummaryTokens: number;
  estimatedHandoffTokens: number;
  estimatedSavingsTokens: number;
  targetFullContextInputCost?: number;
  estimatedHandoffCost?: number;
  estimatedSavingsCost?: number;
};

export const FULL_CONTEXT_HANDOFF_COST_THRESHOLD_NZD = 0.5;
export const FULL_CONTEXT_HANDOFF_COST_THRESHOLD_USD = 0.5;
export const FULL_CONTEXT_HANDOFF_TOKEN_THRESHOLD = 50_000;

export type HandoffDecision =
  | { kind: "skip"; reason: string }
  | { kind: "offer"; estimate: HandoffEstimate };

export type HandoffDecisionOptions = {
  convertFullContextCostToNzd?: (usd: number) => number | undefined;
  fullContextCostThresholdNzd?: number;
  fullContextTokenThreshold?: number;
};

export function getSwitchSkipReason(
  event: ModelSelectEvent,
  mode: "tui" | "rpc" | "json" | "print",
): string | undefined {
  if (event.source === "restore") {
    return "Model restored";
  }
  if (!event.previousModel) {
    return "No previous model";
  }
  if (mode !== "tui") {
    return "Not running in TUI";
  }
  if (
    event.previousModel.provider === event.model.provider &&
    event.previousModel.id === event.model.id
  ) {
    return "Same model";
  }
  return undefined;
}

export function isEligibleSwitch(
  event: ModelSelectEvent,
  mode: "tui" | "rpc" | "json" | "print",
): boolean {
  return getSwitchSkipReason(event, mode) === undefined;
}

export function buildModelRef(
  model: {
    provider: string;
    id: string;
    name: string;
    cost: { input: number; output: number };
  },
  isOAuth: boolean,
): ModelRef {
  const inputCost =
    !isOAuth && Number.isFinite(model.cost.input)
      ? model.cost.input
      : undefined;
  const outputCost =
    !isOAuth && Number.isFinite(model.cost.output)
      ? model.cost.output
      : undefined;
  return {
    provider: model.provider,
    id: model.id,
    name: model.name,
    inputCostPerMillion: inputCost,
    outputCostPerMillion: outputCost,
    subscription: isOAuth,
  };
}

export function computeHandoffEstimate(
  preparation: CompactionPreparation,
  targetRef: ModelRef,
): HandoffEstimate {
  const allMessages = [
    ...preparation.messagesToSummarize,
    ...preparation.turnPrefixMessages,
  ];
  const summarizedTokens = allMessages.reduce(
    (sum, msg) => sum + estimateTokens(msg as never),
    0,
  );

  const estimatedSummaryTokens = Math.ceil(summarizedTokens * 0.03);

  // Compute savings fraction on the naive scale, then project onto real usage-aware total
  const naiveTotal = Math.max(
    preparation.naiveContextTokens,
    summarizedTokens,
    1,
  );
  const savingsFraction = Math.min(
    Math.max((summarizedTokens - estimatedSummaryTokens) / naiveTotal, 0),
    1,
  );

  const projectedSavingsTokens = Math.round(
    preparation.tokensBefore * savingsFraction,
  );
  const estimatedHandoffTokens = Math.max(
    preparation.tokensBefore - projectedSavingsTokens,
    estimatedSummaryTokens,
  );
  const estimatedSavingsTokens = Math.max(
    preparation.tokensBefore - estimatedHandoffTokens,
    0,
  );
  const keptTokens = estimatedHandoffTokens - estimatedSummaryTokens;

  const estimate: HandoffEstimate = {
    currentTokens: preparation.tokensBefore,
    summarizedTokens,
    keptTokens,
    estimatedSummaryTokens,
    estimatedHandoffTokens,
    estimatedSavingsTokens,
  };

  if (targetRef.inputCostPerMillion !== undefined) {
    estimate.targetFullContextInputCost =
      (preparation.tokensBefore / 1_000_000) * targetRef.inputCostPerMillion;
    estimate.estimatedHandoffCost =
      (estimatedHandoffTokens / 1_000_000) * targetRef.inputCostPerMillion;
    estimate.estimatedSavingsCost =
      estimate.targetFullContextInputCost - estimate.estimatedHandoffCost;
  }

  return estimate;
}

export function makeHandoffDecision(
  preparation: CompactionPreparation | undefined,
  targetRef: ModelRef,
  options: HandoffDecisionOptions = {},
): HandoffDecision {
  if (!preparation) {
    return { kind: "skip", reason: "No compaction preparation available" };
  }

  const allMessages = [
    ...preparation.messagesToSummarize,
    ...preparation.turnPrefixMessages,
  ];
  if (allMessages.length === 0) {
    return { kind: "skip", reason: "No messages to summarize" };
  }

  const estimate = computeHandoffEstimate(preparation, targetRef);

  // Compute savings fraction for the gate (same scale as the computation)
  const naiveTotal = Math.max(
    preparation.naiveContextTokens,
    estimate.summarizedTokens,
    1,
  );
  const savingsFraction = Math.min(
    Math.max(
      (estimate.summarizedTokens - estimate.estimatedSummaryTokens) /
        naiveTotal,
      0,
    ),
    1,
  );

  if (savingsFraction < 0.2) {
    return {
      kind: "skip",
      reason: "Estimated context savings are below 20%",
    };
  }

  if (estimate.targetFullContextInputCost === undefined) {
    const thresholdTokens =
      options.fullContextTokenThreshold ?? FULL_CONTEXT_HANDOFF_TOKEN_THRESHOLD;
    if (estimate.currentTokens <= thresholdTokens) {
      return {
        kind: "skip",
        reason: "Full context tokens are below handoff warning threshold",
      };
    }
    return { kind: "offer", estimate };
  }

  const thresholdNzd =
    options.fullContextCostThresholdNzd ??
    FULL_CONTEXT_HANDOFF_COST_THRESHOLD_NZD;

  const fullContextCostNzd = options.convertFullContextCostToNzd?.(
    estimate.targetFullContextInputCost,
  );
  if (fullContextCostNzd !== undefined) {
    if (fullContextCostNzd <= thresholdNzd) {
      return {
        kind: "skip",
        reason: "Full context cost is below handoff warning threshold",
      };
    }
    return { kind: "offer", estimate };
  }

  // Fallback: same numeric threshold applied directly to USD
  if (
    estimate.targetFullContextInputCost <=
    FULL_CONTEXT_HANDOFF_COST_THRESHOLD_USD
  ) {
    return {
      kind: "skip",
      reason:
        "Full context cost is below handoff warning threshold (USD fallback)",
    };
  }
  return { kind: "offer", estimate };
}
