import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { fetchUsage, getUsage, isCodexProvider } from "./usage.js";
import { CACHE_TTL_MS } from "./constants.js";

type FakeModel = { provider: string; id: string };

const fakeModel: FakeModel = { provider: "openai-codex", id: "codex-1" };
const fakeCtx = {} as never;

const fakeCtxWithOkAuth = {
  modelRegistry: {
    getApiKeyAndHeaders: async () => ({
      ok: true as const,
      headers: {},
    }),
  },
} as never;

function makeOkHeaders() {
  return async () => ({ ok: true as const, headers: {} });
}

function makeFailHeaders() {
  return async () => ({ ok: false as const, error: "no auth" });
}

function makeJsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status < 400,
    status,
    json: async () => body,
  } as Response;
}

describe("isCodexProvider", () => {
  it("returns true for exact openai-codex provider", () => {
    expect(isCodexProvider("openai-codex")).toBe(true);
  });

  it("returns true for openai-codex- prefixed providers", () => {
    expect(isCodexProvider("openai-codex-plus")).toBe(true);
    expect(isCodexProvider("openai-codex-enterprise")).toBe(true);
  });

  it("returns false for unrelated providers", () => {
    expect(isCodexProvider("openai")).toBe(false);
    expect(isCodexProvider("anthropic")).toBe(false);
    expect(isCodexProvider("codex")).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(isCodexProvider(undefined)).toBe(false);
  });
});

describe("fetchUsage", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns null when buildHeaders fails", async () => {
    const result = await fetchUsage(
      fakeModel as never,
      fakeCtx,
      makeFailHeaders() as never,
    );
    expect(result).toBeNull();
  });

  it("returns null when fetch throws", async () => {
    globalThis.fetch = async () => {
      throw new Error("network error");
    };
    const result = await fetchUsage(
      fakeModel as never,
      fakeCtx,
      makeOkHeaders() as never,
    );
    expect(result).toBeNull();
  });

  it("returns null when response has no rate_limit field", async () => {
    globalThis.fetch = async () => makeJsonResponse({ other: "data" });
    const result = await fetchUsage(
      fakeModel as never,
      fakeCtx,
      makeOkHeaders() as never,
    );
    expect(result).toBeNull();
  });

  it("returns null when response JSON is invalid", async () => {
    globalThis.fetch = async () =>
      ({
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError("bad json");
        },
      }) as unknown as Response;
    const result = await fetchUsage(
      fakeModel as never,
      fakeCtx,
      makeOkHeaders() as never,
    );
    expect(result).toBeNull();
  });

  it("normalizes primary_window into fiveHour", async () => {
    globalThis.fetch = async () =>
      makeJsonResponse({
        rate_limit: {
          primary_window: {
            used_percent: 42,
            limit_window_seconds: 18000,
            reset_at: 9999,
          },
        },
      });
    const result = await fetchUsage(
      fakeModel as never,
      fakeCtx,
      makeOkHeaders() as never,
    );
    expect(result).not.toBeNull();
    expect(result!.fiveHour).toEqual({
      usedPercent: 42,
      windowSeconds: 18000,
      resetAt: 9999,
    });
  });

  it("normalizes secondary_window into weekly", async () => {
    globalThis.fetch = async () =>
      makeJsonResponse({
        rate_limit: {
          secondary_window: {
            used_percent: 71,
            limit_window_seconds: 604800,
          },
        },
      });
    const result = await fetchUsage(
      fakeModel as never,
      fakeCtx,
      makeOkHeaders() as never,
    );
    expect(result).not.toBeNull();
    expect(result!.weekly).toEqual({
      usedPercent: 71,
      windowSeconds: 604800,
    });
  });

  it("defaults usedPercent to 0 when missing from window", async () => {
    globalThis.fetch = async () =>
      makeJsonResponse({
        rate_limit: {
          primary_window: {},
        },
      });
    const result = await fetchUsage(
      fakeModel as never,
      fakeCtx,
      makeOkHeaders() as never,
    );
    expect(result!.fiveHour!.usedPercent).toBe(0);
  });

  it("leaves fiveHour undefined when primary_window is absent", async () => {
    globalThis.fetch = async () =>
      makeJsonResponse({
        rate_limit: {
          secondary_window: { used_percent: 50 },
        },
      });
    const result = await fetchUsage(
      fakeModel as never,
      fakeCtx,
      makeOkHeaders() as never,
    );
    expect(result!.fiveHour).toBeUndefined();
    expect(result!.weekly).toBeDefined();
  });

  it("leaves weekly undefined when secondary_window is absent", async () => {
    globalThis.fetch = async () =>
      makeJsonResponse({
        rate_limit: {
          primary_window: { used_percent: 20 },
        },
      });
    const result = await fetchUsage(
      fakeModel as never,
      fakeCtx,
      makeOkHeaders() as never,
    );
    expect(result!.weekly).toBeUndefined();
    expect(result!.fiveHour).toBeDefined();
  });

  it("ignores additional_rate_limits when present", async () => {
    globalThis.fetch = async () =>
      makeJsonResponse({
        rate_limit: {
          primary_window: { used_percent: 10 },
        },
        additional_rate_limits: [{ used_percent: 99 }],
      });
    const result = await fetchUsage(
      fakeModel as never,
      fakeCtx,
      makeOkHeaders() as never,
    );
    expect(result!.fiveHour!.usedPercent).toBe(10);
    expect(result).not.toHaveProperty("additional_rate_limits");
  });

  it("sets fetchedAt to approximately now", async () => {
    const before = Date.now();
    globalThis.fetch = async () =>
      makeJsonResponse({ rate_limit: { primary_window: { used_percent: 5 } } });
    const result = await fetchUsage(
      fakeModel as never,
      fakeCtx,
      makeOkHeaders() as never,
    );
    const after = Date.now();
    expect(result!.fetchedAt).toBeGreaterThanOrEqual(before);
    expect(result!.fetchedAt).toBeLessThanOrEqual(after);
  });
});

describe("getUsage", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("returns cached snapshot without re-fetching when within TTL", async () => {
    let callCount = 0;
    globalThis.fetch = async () => {
      callCount++;
      return makeJsonResponse({
        rate_limit: { primary_window: { used_percent: 30 } },
      });
    };

    const m: FakeModel = { provider: "openai-codex", id: "cache-test" };
    await getUsage(m as never, fakeCtxWithOkAuth, true);
    await getUsage(m as never, fakeCtxWithOkAuth, false);
    expect(callCount).toBe(1);
  });

  it("re-fetches when force=true even within TTL", async () => {
    let callCount = 0;
    globalThis.fetch = async () => {
      callCount++;
      return makeJsonResponse({
        rate_limit: { primary_window: { used_percent: 10 } },
      });
    };

    const m: FakeModel = { provider: "openai-codex", id: "force-test" };
    await getUsage(m as never, fakeCtxWithOkAuth, true);
    await getUsage(m as never, fakeCtxWithOkAuth, true);
    expect(callCount).toBe(2);
  });

  it("re-fetches when model changes", async () => {
    let callCount = 0;
    globalThis.fetch = async () => {
      callCount++;
      return makeJsonResponse({
        rate_limit: { primary_window: { used_percent: 10 } },
      });
    };

    const m1: FakeModel = { provider: "openai-codex", id: "model-a" };
    const m2: FakeModel = { provider: "openai-codex", id: "model-b" };
    await getUsage(m1 as never, fakeCtxWithOkAuth, true);
    await getUsage(m2 as never, fakeCtxWithOkAuth, false);
    expect(callCount).toBe(2);
  });

  it("re-fetches after TTL expires", async () => {
    let callCount = 0;
    globalThis.fetch = async () => {
      callCount++;
      return makeJsonResponse({
        rate_limit: { primary_window: { used_percent: 10 } },
      });
    };

    const m: FakeModel = { provider: "openai-codex", id: "ttl-test" };
    await getUsage(m as never, fakeCtxWithOkAuth, true);

    vi.spyOn(Date, "now").mockReturnValue(Date.now() + CACHE_TTL_MS + 1000);
    await getUsage(m as never, fakeCtxWithOkAuth, false);
    expect(callCount).toBe(2);
  });

  it("returns null and caches null when fetch fails", async () => {
    globalThis.fetch = async () => {
      throw new Error("fail");
    };

    const m: FakeModel = {
      provider: "openai-codex",
      id: "null-cache-test-" + Date.now(),
    };
    const result = await getUsage(m as never, fakeCtxWithOkAuth, true);
    expect(result).toBeNull();
  });
});
