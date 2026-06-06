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

export type HandoffDecision =
  | { kind: "skip"; reason: string }
  | { kind: "offer"; estimate: HandoffEstimate };

export type HandoffDecisionOptions = {
  convertFullContextCostToNzd?: (usd: number) => number | undefined;
  fullContextCostThresholdNzd?: number;
};

export function isEligibleSwitch(
  event: ModelSelectEvent,
  hasUI: boolean,
): boolean {
  if (event.source === "restore") {
    return false;
  }
  if (!event.previousModel) {
    return false;
  }
  if (!hasUI) {
    return false;
  }
  if (
    event.previousModel.provider === event.model.provider &&
    event.previousModel.id === event.model.id
  ) {
    return false;
  }
  return true;
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
  _sourceRef: ModelRef,
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
  const keptTokens = Math.max(preparation.tokensBefore - summarizedTokens, 0);
  const estimatedSummaryTokens = Math.ceil(summarizedTokens * 0.03);
  const estimatedHandoffTokens = keptTokens + estimatedSummaryTokens;
  const estimatedSavingsTokens = Math.max(
    preparation.tokensBefore - estimatedHandoffTokens,
    0,
  );

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
  sourceRef: ModelRef,
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

  const summarizedTokens = allMessages.reduce(
    (sum, msg) => sum + estimateTokens(msg as never),
    0,
  );
  const keptTokens = Math.max(preparation.tokensBefore - summarizedTokens, 0);

  if (summarizedTokens <= keptTokens) {
    return {
      kind: "skip",
      reason: "Summarized tokens do not exceed kept tokens",
    };
  }

  const pricingAvailable =
    sourceRef.inputCostPerMillion !== undefined &&
    targetRef.inputCostPerMillion !== undefined;
  const neitherSubscription =
    !sourceRef.subscription && !targetRef.subscription;

  if (pricingAvailable && neitherSubscription) {
    if (targetRef.inputCostPerMillion! >= sourceRef.inputCostPerMillion!) {
      return {
        kind: "skip",
        reason: "Target model is not cheaper than source model",
      };
    }
  }

  const estimate = computeHandoffEstimate(preparation, sourceRef, targetRef);
  const fullContextCostNzd =
    estimate.targetFullContextInputCost === undefined
      ? undefined
      : options.convertFullContextCostToNzd?.(
          estimate.targetFullContextInputCost,
        );
  const thresholdNzd =
    options.fullContextCostThresholdNzd ??
    FULL_CONTEXT_HANDOFF_COST_THRESHOLD_NZD;

  if (fullContextCostNzd !== undefined && fullContextCostNzd <= thresholdNzd) {
    return {
      kind: "skip",
      reason: "Full context cost is below handoff warning threshold",
    };
  }

  return { kind: "offer", estimate };
}
