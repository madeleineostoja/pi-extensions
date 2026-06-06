import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Model, Api } from "@earendil-works/pi-ai";
import type { UsageSnapshot } from "../provider.js";
import { buildHeaders } from "../auth.js";
import { CODEX_USAGE_URL, TIMEOUT_MS } from "../constants.js";

let lastSnapshot: UsageSnapshot | null = null;
let lastModel: string | undefined;

export async function fetchUsage(
  model: Model<Api>,
  ctx: ExtensionContext,
  buildHeadersFn = buildHeaders,
): Promise<UsageSnapshot | null> {
  const headerResult = await buildHeadersFn(model, ctx);
  if (!headerResult.ok) {
    return null;
  }

  let response: Response;
  try {
    response = await fetch(CODEX_USAGE_URL, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: headerResult.headers,
    });
  } catch {
    return null;
  }

  let data: unknown;
  try {
    data = await response.json();
  } catch {
    return null;
  }

  type RawWindow = {
    used_percent?: number;
    limit_window_seconds?: number;
    reset_at?: number;
  };
  type RawUsageResponse = {
    rate_limit: { primary_window?: RawWindow; secondary_window?: RawWindow };
  };

  const typed = data as Partial<RawUsageResponse>;
  if (!typed.rate_limit) {
    return null;
  }

  return {
    provider: "codex",
    primary: normalizeWindow(typed.rate_limit.primary_window),
    secondary: normalizeWindow(typed.rate_limit.secondary_window),
    fetchedAt: Date.now(),
  };
}

function normalizeWindow(
  raw:
    | {
        used_percent?: number;
        limit_window_seconds?: number;
        reset_at?: number;
      }
    | undefined,
) {
  if (!raw) {
    return undefined;
  }
  return {
    usedPercent: raw.used_percent ?? 0,
    ...(raw.reset_at !== undefined ? { resetAt: raw.reset_at } : {}),
    ...(raw.limit_window_seconds !== undefined
      ? { windowSeconds: raw.limit_window_seconds }
      : {}),
  };
}

export async function getUsage(
  model: Model<Api>,
  ctx: ExtensionContext,
  force = false,
): Promise<UsageSnapshot | null> {
  const modelKey = `${model.provider}:${model.id}`;

  if (
    !force &&
    lastSnapshot &&
    lastModel === modelKey &&
    Date.now() - lastSnapshot.fetchedAt < 5 * 60 * 1000
  ) {
    return lastSnapshot;
  }

  const snapshot = await fetchUsage(model, ctx);
  lastModel = modelKey;
  lastSnapshot = snapshot;
  return snapshot;
}
