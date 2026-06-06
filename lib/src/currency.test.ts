import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const getAgentDirMock = vi.hoisted(() => vi.fn());

vi.mock("@earendil-works/pi-coding-agent", async () => {
  const actual = await vi.importActual<
    typeof import("@earendil-works/pi-coding-agent")
  >("@earendil-works/pi-coding-agent");
  return {
    ...actual,
    getAgentDir: getAgentDirMock,
  };
});

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "currency-test-"));
  getAgentDirMock.mockReturnValue(tmpDir);
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

async function loadModule() {
  return import("./currency.js");
}

function seedCache(rates: Record<string, unknown>) {
  const dir = join(tmpDir, "cache");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "currency-rates.json"),
    JSON.stringify({ version: 1, rates }, null, 2),
  );
}

function makeFetchOk(rate: number, date = "2026-06-06") {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ rate, date }),
  });
}

function makeFetchFail(status = 500) {
  return vi.fn().mockResolvedValue({ ok: false, status });
}

describe("convertCurrency", () => {
  it("returns amount for same currency", async () => {
    const { convertCurrency } = await loadModule();
    expect(convertCurrency({ amount: 10, from: "usd", to: "USD" })).toBe(10);
  });

  it("returns undefined when no rate is cached", async () => {
    const { convertCurrency } = await loadModule();
    expect(
      convertCurrency({ amount: 10, from: "USD", to: "NZD" }),
    ).toBeUndefined();
  });

  it("converts using cached rate", async () => {
    vi.stubGlobal("fetch", makeFetchOk(1.7));
    const { refreshCurrencyRate, convertCurrency } = await loadModule();
    await refreshCurrencyRate({ from: "USD", to: "NZD" });
    expect(convertCurrency({ amount: 10, from: "USD", to: "NZD" })).toBeCloseTo(
      17,
    );
  });
});

describe("refreshCurrencyRate", () => {
  it("short-circuits when cache is fresh", async () => {
    const fetchMock = makeFetchOk(1.7);
    vi.stubGlobal("fetch", fetchMock);
    const { refreshCurrencyRate } = await loadModule();

    await refreshCurrencyRate({ from: "USD", to: "NZD" });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await refreshCurrencyRate({ from: "USD", to: "NZD" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("fetches when cache is stale", async () => {
    const fetchMock = makeFetchOk(1.8);
    vi.stubGlobal("fetch", fetchMock);
    const staleTime = Date.now() - 25 * 60 * 60 * 1000;
    seedCache({
      "USD/NZD": {
        rate: 1.7,
        fetchedAt: staleTime,
        lastAttemptAt: staleTime,
        consecutiveFailures: 0,
      },
    });

    const { refreshCurrencyRate } = await loadModule();
    await refreshCurrencyRate({ from: "USD", to: "NZD" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.frankfurter.dev/v2/rate/USD/NZD",
    );
  });

  it("dedupes in-flight refreshes", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 50));
      return {
        ok: true,
        json: async () => ({ rate: 1.7, date: "2026-06-06" }),
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    const { refreshCurrencyRate } = await loadModule();
    const p1 = refreshCurrencyRate({ from: "USD", to: "NZD" });
    const p2 = refreshCurrencyRate({ from: "USD", to: "NZD" });
    await Promise.all([p1, p2]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps stale data on failed refresh", async () => {
    const fetchMock = makeFetchFail(500);
    vi.stubGlobal("fetch", fetchMock);
    const staleTime = Date.now() - 25 * 60 * 60 * 1000;
    seedCache({
      "USD/NZD": {
        rate: 1.7,
        fetchedAt: staleTime,
        lastAttemptAt: staleTime,
        consecutiveFailures: 0,
      },
    });

    const { refreshCurrencyRate, convertCurrency } = await loadModule();
    await refreshCurrencyRate({ from: "USD", to: "NZD" });
    expect(convertCurrency({ amount: 10, from: "USD", to: "NZD" })).toBeCloseTo(
      17,
    );
  });

  it("does not repeatedly fetch when no cache and under backoff", async () => {
    const fetchMock = makeFetchFail(500);
    vi.stubGlobal("fetch", fetchMock);

    const { refreshCurrencyRate } = await loadModule();
    await refreshCurrencyRate({ from: "USD", to: "NZD" });
    await refreshCurrencyRate({ from: "USD", to: "NZD" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("persists rate across module reloads", async () => {
    const fetchMock = makeFetchOk(1.7);
    vi.stubGlobal("fetch", fetchMock);

    const mod1 = await loadModule();
    await mod1.refreshCurrencyRate({ from: "USD", to: "NZD" });

    vi.resetModules();
    const mod2 = await loadModule();
    expect(
      mod2.convertCurrency({ amount: 10, from: "USD", to: "NZD" }),
    ).toBeCloseTo(17);
  });

  it("short-circuits same-currency pair without fetch", async () => {
    const fetchMock = makeFetchOk(1.7);
    vi.stubGlobal("fetch", fetchMock);

    const { refreshCurrencyRate } = await loadModule();
    await refreshCurrencyRate({ from: "USD", to: "usd" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("obeys backoff after repeated failures", async () => {
    const fetchMock = makeFetchFail(500);
    vi.stubGlobal("fetch", fetchMock);
    const justPastTtl = Date.now() - 24 * 60 * 60 * 1000 - 1000;
    seedCache({
      "USD/NZD": {
        rate: 1.7,
        fetchedAt: justPastTtl,
        lastAttemptAt: Date.now(),
        consecutiveFailures: 2,
      },
    });

    const { refreshCurrencyRate, convertCurrency } = await loadModule();
    await refreshCurrencyRate({ from: "USD", to: "NZD" });
    // Backoff = 5min * 2^2 = 20min; lastAttemptAt is now, so still under backoff
    expect(fetchMock).not.toHaveBeenCalled();
    expect(convertCurrency({ amount: 10, from: "USD", to: "NZD" })).toBeCloseTo(
      17,
    );
  });
});
