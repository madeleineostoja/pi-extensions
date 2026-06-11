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
