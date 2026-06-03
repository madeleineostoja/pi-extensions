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
  sourceInputCost?: number;
  targetFullContextInputCost?: number;
  targetKeptContextInputCost?: number;
};

export type HandoffDecision =
  | { kind: "skip"; reason: string }
  | { kind: "offer"; estimate: HandoffEstimate };

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
  sourceRef: ModelRef,
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

  const estimate: HandoffEstimate = {
    currentTokens: preparation.tokensBefore,
    summarizedTokens,
    keptTokens,
  };

  if (sourceRef.inputCostPerMillion !== undefined) {
    estimate.sourceInputCost =
      (preparation.tokensBefore / 1_000_000) * sourceRef.inputCostPerMillion;
  }
  if (targetRef.inputCostPerMillion !== undefined) {
    estimate.targetFullContextInputCost =
      (preparation.tokensBefore / 1_000_000) * targetRef.inputCostPerMillion;
    estimate.targetKeptContextInputCost =
      (keptTokens / 1_000_000) * targetRef.inputCostPerMillion;
  }

  return estimate;
}

export function makeHandoffDecision(
  preparation: CompactionPreparation | undefined,
  sourceRef: ModelRef,
  targetRef: ModelRef,
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
  return { kind: "offer", estimate };
}
