import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const CACHE_VERSION = 1;
const TTL_MS = 24 * 60 * 60 * 1000;
const BACKOFF_BASE_MS = 5 * 60 * 1000;
const BACKOFF_MAX_MS = 60 * 60 * 1000;
const FRANKFURTER_URL = "https://api.frankfurter.dev/v2/rate";

type CacheEntry = {
  rate?: number;
  fetchedAt: number;
  lastAttemptAt: number;
  providerDate?: string;
  consecutiveFailures: number;
};

type CacheData = {
  version: number;
  rates: Record<string, CacheEntry>;
};

const inFlight = new Map<string, Promise<void>>();

function getCachePath(): string {
  return join(getAgentDir(), "cache", "currency-rates.json");
}

function readCache(): CacheData {
  try {
    const path = getCachePath();
    if (!existsSync(path)) {
      return { version: CACHE_VERSION, rates: {} };
    }
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "version" in parsed &&
      (parsed as { version: unknown }).version === CACHE_VERSION &&
      "rates" in parsed
    ) {
      return parsed as CacheData;
    }
  } catch {
    // ignore read/parse errors
  }
  return { version: CACHE_VERSION, rates: {} };
}

function writeCache(cache: CacheData): void {
  try {
    const path = getCachePath();
    const dir = join(path, "..");
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(path, JSON.stringify(cache, null, 2), "utf-8");
  } catch {
    // ignore write errors
  }
}

function pairKey(from: string, to: string): string {
  return `${from.toUpperCase()}/${to.toUpperCase()}`;
}

function backoffMs(failures: number): number {
  return Math.min(BACKOFF_BASE_MS * Math.pow(2, failures), BACKOFF_MAX_MS);
}

function shouldFetch(entry: CacheEntry | undefined): boolean {
  if (!entry) {
    return true;
  }
  const now = Date.now();
  const fresh = entry.rate !== undefined && now - entry.fetchedAt < TTL_MS;
  if (fresh) {
    return false;
  }
  return now >= entry.lastAttemptAt + backoffMs(entry.consecutiveFailures);
}

export function convertCurrency({
  amount,
  from,
  to,
}: {
  amount: number;
  from: string;
  to: string;
}): number | undefined {
  const f = from.toUpperCase();
  const t = to.toUpperCase();
  if (f === t) {
    return amount;
  }
  const cache = readCache();
  const entry = cache.rates[pairKey(f, t)];
  if (entry?.rate === undefined) {
    return undefined;
  }
  return amount * entry.rate;
}

async function doFetch(from: string, to: string): Promise<void> {
  const response = await fetch(`${FRANKFURTER_URL}/${from}/${to}`);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  const data = (await response.json()) as unknown;
  if (
    typeof data !== "object" ||
    data === null ||
    !("rate" in data) ||
    typeof (data as { rate: unknown }).rate !== "number" ||
    !Number.isFinite((data as { rate: number }).rate)
  ) {
    throw new Error("Invalid rate");
  }
  const cache = readCache();
  cache.rates[pairKey(from, to)] = {
    rate: (data as { rate: number }).rate,
    fetchedAt: Date.now(),
    lastAttemptAt: Date.now(),
    providerDate:
      typeof (data as unknown as { date?: unknown }).date === "string"
        ? (data as unknown as { date: string }).date
        : undefined,
    consecutiveFailures: 0,
  };
  writeCache(cache);
}

export async function refreshCurrencyRate({
  from,
  to,
}: {
  from: string;
  to: string;
}): Promise<void> {
  const f = from.toUpperCase();
  const t = to.toUpperCase();
  if (f === t) {
    return;
  }

  const key = pairKey(f, t);
  const existing = inFlight.get(key);
  if (existing) {
    return existing;
  }

  const cache = readCache();
  const entry = cache.rates[key];
  if (!shouldFetch(entry)) {
    return;
  }

  const promise = doFetch(f, t).catch(() => {
    const cacheAfter = readCache();
    const existingEntry = cacheAfter.rates[key];
    if (existingEntry) {
      existingEntry.lastAttemptAt = Date.now();
      existingEntry.consecutiveFailures++;
    } else {
      cacheAfter.rates[key] = {
        fetchedAt: 0,
        lastAttemptAt: Date.now(),
        consecutiveFailures: 1,
      };
    }
    writeCache(cacheAfter);
  });

  inFlight.set(key, promise);
  try {
    await promise;
  } finally {
    inFlight.delete(key);
  }
}
