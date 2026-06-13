import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Model, Api } from "@earendil-works/pi-ai";
import type { UsageSnapshot } from "../provider.js";
import { readConfig } from "../config.js";
import { TIMEOUT_MS } from "../constants.js";
import {
  resolveActiveAccount,
  resolveAllAccounts,
} from "./opencode-account.js";

const DASHBOARD_URL = "https://opencode.ai/workspace";

type RawWindow = {
  usagePercent: number;
  resetInSec: number;
};

const cache = new Map<string, { snapshot: UsageSnapshot; fetchedAt: number }>();

export async function fetchUsage(
  workspaceId: string,
  authCookie: string,
  fetchFn = globalThis.fetch,
): Promise<UsageSnapshot | null> {
  const url = `${DASHBOARD_URL}/${workspaceId}/go`;

  let response: Response;
  try {
    response = await fetchFn(url, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        Cookie: `auth=${authCookie}`,
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      },
    });
  } catch {
    return null;
  }

  let html: string;
  try {
    html = await response.text();
  } catch {
    return null;
  }

  return parseUsage(html);
}

const NUM = String.raw`(-?\d+(?:\.\d+)?)`;

function windowRegex(
  name: string,
): Array<{ regex: RegExp; usageFirst: boolean }> {
  return [
    {
      regex: new RegExp(
        String.raw`${name}:\$R\[\d+\]=\{[^}]*usagePercent:${NUM}[^}]*resetInSec:${NUM}[^}]*\}`,
      ),
      usageFirst: true,
    },
    {
      regex: new RegExp(
        String.raw`${name}:\$R\[\d+\]=\{[^}]*resetInSec:${NUM}[^}]*usagePercent:${NUM}[^}]*\}`,
      ),
      usageFirst: false,
    },
  ];
}

function extractWindow(html: string, name: string): RawWindow | null {
  for (const { regex, usageFirst } of windowRegex(name)) {
    const match = regex.exec(html);
    if (match) {
      return {
        usagePercent: Number.parseFloat(usageFirst ? match[1] : match[2]),
        resetInSec: Number.parseFloat(usageFirst ? match[2] : match[1]),
      };
    }
  }
  return null;
}

function normalizeWindow(raw: RawWindow) {
  return {
    usedPercent: raw.usagePercent,
    resetInSec: raw.resetInSec,
  };
}

export function parseUsage(html: string): UsageSnapshot | null {
  const rolling = extractWindow(html, "rollingUsage");
  const weekly = extractWindow(html, "weeklyUsage");
  const monthly = extractWindow(html, "monthlyUsage");

  if (!rolling && !weekly && !monthly) {
    return null;
  }

  const snapshot: UsageSnapshot = {
    provider: "opencode",
    fetchedAt: Date.now(),
  };

  if (rolling) {
    snapshot.primary = normalizeWindow(rolling);
  }
  if (weekly) {
    snapshot.secondary = normalizeWindow(weekly);
  }
  if (monthly) {
    snapshot.monthly = normalizeWindow(monthly);
  }

  return snapshot;
}

export async function getUsage(
  model: Model<Api>,
  _ctx: ExtensionContext,
  force = false,
  readConfigFn = readConfig,
  runtimeRoot?: string,
): Promise<UsageSnapshot | null> {
  const config = readConfigFn();
  const resolved = resolveActiveAccount(config, runtimeRoot);

  if (!resolved) {
    return {
      provider: "opencode",
      fetchedAt: Date.now(),
      error:
        "Opencode credentials not configured. Run /usage auth to set them up.",
    };
  }

  if (resolved.workspaceId === "") {
    return {
      provider: "opencode",
      fetchedAt: Date.now(),
      accountId: resolved.accountId,
      error: `Active pi-multi-auth account ${resolved.accountId} has no workspaceId. Run /usage auth to add it.`,
    };
  }

  const cacheKey = `${model.provider}:${model.id}:${resolved.accountId}:${resolved.workspaceId}`;

  if (!force) {
    const cached = cache.get(cacheKey);
    if (cached && Date.now() - cached.fetchedAt < 5 * 60 * 1000) {
      return cached.snapshot;
    }
  }

  const snapshot = await fetchUsage(resolved.workspaceId, resolved.authCookie);

  if (snapshot) {
    const enriched: UsageSnapshot = {
      ...snapshot,
      accountId: resolved.accountId,
      accountLabel: resolved.label,
      active: resolved.active,
    };
    cache.set(cacheKey, { snapshot: enriched, fetchedAt: Date.now() });
    return enriched;
  }

  const cached = cache.get(cacheKey);
  if (cached) {
    return { ...cached.snapshot, stale: true };
  }

  return null;
}

export async function getAllUsage(
  _model: Model<Api>,
  _ctx: ExtensionContext,
  force = false,
  readConfigFn = readConfig,
  runtimeRoot?: string,
): Promise<Array<{ accountId: string; snapshot: UsageSnapshot | null }>> {
  const config = readConfigFn();
  const accounts = resolveAllAccounts(config, runtimeRoot);

  if (accounts.length === 0) {
    return [
      {
        accountId: "opencode",
        snapshot: {
          provider: "opencode",
          fetchedAt: Date.now(),
          error:
            "Opencode credentials not configured. Run /usage auth to set them up.",
        } as UsageSnapshot,
      },
    ];
  }

  return Promise.all(
    accounts.map(async (entry) => {
      if (!entry.ok) {
        return {
          accountId: entry.accountId,
          snapshot: {
            provider: "opencode",
            fetchedAt: Date.now(),
            error: entry.error,
          } as UsageSnapshot,
        };
      }

      const account = entry.account;
      const cacheKey = `all:${account.accountId}:${account.workspaceId}`;

      if (!force) {
        const cached = cache.get(cacheKey);
        if (cached && Date.now() - cached.fetchedAt < 5 * 60 * 1000) {
          return {
            accountId: account.accountId,
            snapshot: cached.snapshot,
          };
        }
      }

      const snapshot = await fetchUsage(
        account.workspaceId,
        account.authCookie,
      );
      if (snapshot) {
        const enriched: UsageSnapshot = {
          ...snapshot,
          accountId: account.accountId,
          accountLabel: account.label,
          active: account.active,
        };
        cache.set(cacheKey, { snapshot: enriched, fetchedAt: Date.now() });
        return { accountId: account.accountId, snapshot: enriched };
      }

      const cached = cache.get(cacheKey);
      if (cached) {
        return {
          accountId: account.accountId,
          snapshot: { ...cached.snapshot, stale: true } as UsageSnapshot,
        };
      }

      return {
        accountId: account.accountId,
        snapshot: {
          provider: "opencode",
          fetchedAt: Date.now(),
          error: "Failed to fetch usage.",
        } as UsageSnapshot,
      };
    }),
  );
}
