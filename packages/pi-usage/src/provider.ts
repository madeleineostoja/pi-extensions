import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Model, Api } from "@earendil-works/pi-ai";
import { CACHE_TTL_MS } from "./constants.js";
import { getUsage as getCodexUsage } from "./providers/codex.js";
import { getUsage as getOpencodeUsage } from "./providers/opencode.js";

export type UsageProviderId = "codex" | "opencode";

export type UsageWindow = {
  usedPercent: number;
  resetAt?: number;
  resetInSec?: number;
  windowSeconds?: number;
};

export type UsageSnapshot = {
  provider: UsageProviderId;
  primary?: UsageWindow;
  secondary?: UsageWindow;
  monthly?: UsageWindow;
  fetchedAt: number;
  error?: string;
  stale?: boolean;
};

export type UsageProvider = {
  id: UsageProviderId;
  label: UsageProviderId;
  matches(model: Model<Api> | null | undefined): boolean;
  resolveFetchModel(ctx: ExtensionContext): Model<Api> | null;
  getUsage(
    model: Model<Api>,
    ctx: ExtensionContext,
    force?: boolean,
  ): Promise<UsageSnapshot | null>;
};

function isCodexProviderString(provider: string | undefined): boolean {
  if (!provider) {
    return false;
  }
  return provider === "openai-codex" || provider.startsWith("openai-codex-");
}

function isOpencodeProviderString(provider: string | undefined): boolean {
  if (!provider) {
    return false;
  }
  return provider === "opencode";
}

export function providerForModel(
  model: Model<Api> | null | undefined,
): UsageProviderId | null {
  if (!model) {
    return null;
  }
  if (isCodexProviderString(model.provider)) {
    return "codex";
  }
  if (isOpencodeProviderString(model.provider)) {
    return "opencode";
  }
  return null;
}

export function resolveFetchModel(
  ctx: ExtensionContext,
  matcher: (model: Model<Api>) => boolean,
): Model<Api> | null {
  const available = ctx.modelRegistry.getAvailable();
  for (const model of available) {
    if (matcher(model)) {
      return model;
    }
  }
  return null;
}

const codexProvider: UsageProvider = {
  id: "codex",
  label: "codex",
  matches(model) {
    return isCodexProviderString(model?.provider);
  },
  resolveFetchModel(ctx) {
    return resolveFetchModel(ctx, (m) => isCodexProviderString(m.provider));
  },
  getUsage(model, ctx, force) {
    return getCodexUsage(model, ctx, force);
  },
};

const opencodeProvider: UsageProvider = {
  id: "opencode",
  label: "opencode",
  matches(model) {
    return isOpencodeProviderString(model?.provider);
  },
  resolveFetchModel(ctx) {
    return resolveFetchModel(ctx, (m) => isOpencodeProviderString(m.provider));
  },
  getUsage(model, ctx, force) {
    return getOpencodeUsage(model, ctx, force);
  },
};

const providers: Record<UsageProviderId, UsageProvider> = {
  codex: codexProvider,
  opencode: opencodeProvider,
};

export function getProviderById(
  id: UsageProviderId,
): UsageProvider | undefined {
  return providers[id];
}

export function getUsageProvider(
  model: Model<Api> | null | undefined,
): UsageProvider | null {
  const id = providerForModel(model);
  if (!id) {
    return null;
  }
  return providers[id] ?? null;
}

function cacheKey(providerId: UsageProviderId, model: Model<Api>): string {
  return `${providerId}:${model.provider}:${model.id}`;
}

const cache = new Map<string, { snapshot: UsageSnapshot; fetchedAt: number }>();

export async function getUsage(
  model: Model<Api>,
  ctx: ExtensionContext,
  force = false,
): Promise<UsageSnapshot | null> {
  const provider = getUsageProvider(model);
  if (!provider) {
    return null;
  }

  const key = cacheKey(provider.id, model);
  const cached = cache.get(key);
  if (!force && cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.snapshot;
  }

  const snapshot = await provider.getUsage(model, ctx, force);
  if (snapshot) {
    cache.set(key, { snapshot, fetchedAt: Date.now() });
  }
  return snapshot;
}
