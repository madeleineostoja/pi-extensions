type Usage = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cost?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    total?: number;
  };
};

type AssistantLike = {
  role?: string;
  provider?: string;
  model?: string;
  usage?: Usage;
};

type SessionEntryLike = {
  type?: string;
  message?: AssistantLike;
};

type ModelLike = {
  provider?: string;
  id?: string;
  cost?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
};

type ModelRegistryLike = {
  find?(provider: string, modelId: string): ModelLike | undefined;
  isUsingOAuth?(model: ModelLike): boolean;
};

export type FooterCostInfo = {
  totalCost: number;
  hideCost: boolean;
};

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function sumUsageCostComponents(usage: Usage): number | undefined {
  const cost = usage.cost;
  if (!cost) {
    return undefined;
  }

  const input = finiteNumber(cost.input) ?? 0;
  const output = finiteNumber(cost.output) ?? 0;
  const cacheRead = finiteNumber(cost.cacheRead) ?? 0;
  const cacheWrite = finiteNumber(cost.cacheWrite) ?? 0;
  const componentTotal = input + output + cacheRead + cacheWrite;
  if (componentTotal > 0) {
    return componentTotal;
  }

  return finiteNumber(cost.total);
}

function estimateUsageCostFromModel(usage: Usage, model: ModelLike): number {
  const cost = model.cost;
  if (!cost) {
    return 0;
  }

  return (
    ((finiteNumber(cost.input) ?? 0) / 1_000_000) *
      (finiteNumber(usage.input) ?? 0) +
    ((finiteNumber(cost.output) ?? 0) / 1_000_000) *
      (finiteNumber(usage.output) ?? 0) +
    ((finiteNumber(cost.cacheRead) ?? 0) / 1_000_000) *
      (finiteNumber(usage.cacheRead) ?? 0) +
    ((finiteNumber(cost.cacheWrite) ?? 0) / 1_000_000) *
      (finiteNumber(usage.cacheWrite) ?? 0)
  );
}

function getMessageModel(
  message: AssistantLike,
  modelRegistry: ModelRegistryLike,
): ModelLike | undefined {
  if (!message.provider || !message.model) {
    return undefined;
  }
  return (
    modelRegistry.find?.(message.provider, message.model) ?? {
      provider: message.provider,
      id: message.model,
    }
  );
}

function isSubscriptionModel(
  model: ModelLike | undefined,
  modelRegistry: ModelRegistryLike,
): boolean {
  return model ? (modelRegistry.isUsingOAuth?.(model) ?? false) : false;
}

function getAssistantMessageCost(
  message: AssistantLike,
  modelRegistry: ModelRegistryLike,
): { cost: number; subscription: boolean } {
  const usage = message.usage;
  if (!usage) {
    return { cost: 0, subscription: false };
  }

  const model = getMessageModel(message, modelRegistry);
  const subscription = isSubscriptionModel(model, modelRegistry);
  if (subscription) {
    return { cost: 0, subscription: true };
  }

  const storedCost = sumUsageCostComponents(usage);
  if (storedCost !== undefined && storedCost > 0) {
    return { cost: storedCost, subscription: false };
  }

  const estimatedCost = model ? estimateUsageCostFromModel(usage, model) : 0;
  if (estimatedCost > 0) {
    return { cost: estimatedCost, subscription: false };
  }

  return { cost: storedCost ?? 0, subscription: false };
}

export function getLatestCacheHitRate(
  entries: readonly SessionEntryLike[],
): number | undefined {
  let totalCacheRead = 0;
  let totalCacheWrite = 0;
  let latest: number | undefined;

  for (const entry of entries) {
    const message = entry.message;
    if (entry.type !== "message" || message?.role !== "assistant") {
      continue;
    }
    const usage = message.usage;
    if (!usage) {
      continue;
    }

    const cacheRead = finiteNumber(usage.cacheRead) ?? 0;
    const cacheWrite = finiteNumber(usage.cacheWrite) ?? 0;
    totalCacheRead += cacheRead;
    totalCacheWrite += cacheWrite;

    const promptTokens =
      (finiteNumber(usage.input) ?? 0) + cacheRead + cacheWrite;
    latest = promptTokens > 0 ? (cacheRead / promptTokens) * 100 : undefined;
  }

  if (totalCacheRead === 0 && totalCacheWrite === 0) {
    return undefined;
  }
  return latest;
}

export function getFooterCostInfo(
  entries: readonly SessionEntryLike[],
  modelRegistry: ModelRegistryLike,
  currentModel: ModelLike | undefined,
): FooterCostInfo {
  let totalCost = 0;
  let hasBillableAssistantUsage = false;
  let hasSubscriptionAssistantUsage = false;

  for (const entry of entries) {
    const message = entry.message;
    if (entry.type !== "message" || message?.role !== "assistant") {
      continue;
    }

    const { cost, subscription } = getAssistantMessageCost(
      message,
      modelRegistry,
    );
    if (subscription) {
      hasSubscriptionAssistantUsage = true;
    } else {
      hasBillableAssistantUsage = true;
      totalCost += cost;
    }
  }

  const currentModelUsesSubscription = isSubscriptionModel(
    currentModel,
    modelRegistry,
  );
  const hideCost =
    !hasBillableAssistantUsage &&
    (hasSubscriptionAssistantUsage || currentModelUsesSubscription);

  return { totalCost, hideCost };
}
