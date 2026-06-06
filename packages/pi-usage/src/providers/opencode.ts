import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Model, Api } from "@earendil-works/pi-ai";
import type { UsageSnapshot } from "../provider.js";
import { readConfig, validateOpencodeConfig } from "../config.js";
import { TIMEOUT_MS } from "../constants.js";

const DASHBOARD_URL = "https://opencode.ai/workspace";

type RawWindow = {
  usagePercent: number;
  resetInSec: number;
};

let lastSnapshot: UsageSnapshot | null = null;
let lastModelKey: string | undefined;

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
): Promise<UsageSnapshot | null> {
  const modelKey = `${model.provider}:${model.id}`;

  const config = readConfigFn();
  const opencodeConfig = validateOpencodeConfig(config);

  if (!opencodeConfig) {
    return {
      provider: "opencode",
      fetchedAt: Date.now(),
      error:
        "Opencode credentials not configured. Run /usage auth to set them up.",
    };
  }

  if (
    !force &&
    lastSnapshot &&
    lastModelKey === modelKey &&
    Date.now() - lastSnapshot.fetchedAt < 5 * 60 * 1000
  ) {
    return lastSnapshot;
  }

  const snapshot = await fetchUsage(
    opencodeConfig.workspaceId,
    opencodeConfig.authCookie,
  );

  if (snapshot) {
    lastModelKey = modelKey;
    lastSnapshot = snapshot;
    return snapshot;
  }

  if (lastSnapshot && lastModelKey === modelKey) {
    return { ...lastSnapshot, stale: true };
  }

  return null;
}
