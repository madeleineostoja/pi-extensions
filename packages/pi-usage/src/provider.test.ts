import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  providerForModel,
  getProviderById,
  getUsageProvider,
  getUsage,
  resolveFetchModel,
} from "./provider.js";
import { CACHE_TTL_MS } from "./constants.js";

type FakeModel = { provider: string; id: string };

function makeCtxWithAvailable(models: FakeModel[]): {
  modelRegistry: {
    getAvailable: () => FakeModel[];
    getApiKeyAndHeaders: () => Promise<{
      ok: true;
      headers: Record<string, string>;
    }>;
  };
} {
  return {
    modelRegistry: {
      getAvailable: () => models,
      getApiKeyAndHeaders: async () => ({ ok: true, headers: {} }),
    },
  };
}

describe("providerForModel", () => {
  it("returns codex for exact openai-codex provider", () => {
    const model: FakeModel = { provider: "openai-codex", id: "codex-1" };
    expect(providerForModel(model as never)).toBe("codex");
  });

  it("returns codex for openai-codex- prefixed providers", () => {
    expect(
      providerForModel({ provider: "openai-codex-plus", id: "1" } as never),
    ).toBe("codex");
    expect(
      providerForModel({
        provider: "openai-codex-enterprise",
        id: "2",
      } as never),
    ).toBe("codex");
  });

  it("returns opencode for opencode provider", () => {
    expect(
      providerForModel({ provider: "opencode", id: "go-1" } as never),
    ).toBe("opencode");
  });

  it("returns null for unrelated providers", () => {
    expect(
      providerForModel({ provider: "openai", id: "1" } as never),
    ).toBeNull();
    expect(
      providerForModel({ provider: "anthropic", id: "2" } as never),
    ).toBeNull();
    expect(
      providerForModel({ provider: "codex", id: "3" } as never),
    ).toBeNull();
  });

  it("returns null for null or undefined model", () => {
    expect(providerForModel(null)).toBeNull();
    expect(providerForModel(undefined)).toBeNull();
  });
});

describe("getProviderById", () => {
  it("returns codex provider for codex", () => {
    const provider = getProviderById("codex");
    expect(provider).toBeDefined();
    expect(provider!.id).toBe("codex");
    expect(provider!.label).toBe("codex");
  });

  it("returns opencode provider for opencode", () => {
    const provider = getProviderById("opencode");
    expect(provider).toBeDefined();
    expect(provider!.id).toBe("opencode");
    expect(provider!.label).toBe("opencode");
  });
});

describe("getUsageProvider", () => {
  it("returns codex provider for codex model", () => {
    const provider = getUsageProvider({
      provider: "openai-codex",
      id: "1",
    } as never);
    expect(provider?.id).toBe("codex");
  });

  it("returns opencode provider for opencode model", () => {
    const provider = getUsageProvider({
      provider: "opencode",
      id: "1",
    } as never);
    expect(provider?.id).toBe("opencode");
  });

  it("returns null for unsupported model", () => {
    expect(
      getUsageProvider({ provider: "anthropic", id: "1" } as never),
    ).toBeNull();
  });
});

describe("resolveFetchModel", () => {
  it("returns first matching model from getAvailable", () => {
    const ctx = makeCtxWithAvailable([
      { provider: "openai-codex", id: "a" },
      { provider: "openai-codex", id: "b" },
    ]);
    const result = resolveFetchModel(
      ctx as never,
      (m) => m.provider === "openai-codex",
    );
    expect(result).toEqual({ provider: "openai-codex", id: "a" });
  });

  it("returns null when no models match", () => {
    const ctx = makeCtxWithAvailable([{ provider: "anthropic", id: "a" }]);
    const result = resolveFetchModel(
      ctx as never,
      (m) => m.provider === "openai-codex",
    );
    expect(result).toBeNull();
  });

  it("returns null when getAvailable is empty", () => {
    const ctx = makeCtxWithAvailable([]);
    const result = resolveFetchModel(ctx as never, () => true);
    expect(result).toBeNull();
  });
});

describe("provider availability via matches", () => {
  it("codex provider matches when getAvailable has codex model", () => {
    const ctx = makeCtxWithAvailable([{ provider: "openai-codex", id: "a" }]);
    const provider = getProviderById("codex")!;
    expect(provider.resolveFetchModel(ctx as never)).not.toBeNull();
  });

  it("codex provider does not match when getAvailable has no codex model", () => {
    const ctx = makeCtxWithAvailable([{ provider: "anthropic", id: "a" }]);
    const provider = getProviderById("codex")!;
    expect(provider.resolveFetchModel(ctx as never)).toBeNull();
  });

  it("opencode provider matches when getAvailable has opencode model", () => {
    const ctx = makeCtxWithAvailable([{ provider: "opencode", id: "a" }]);
    const provider = getProviderById("opencode")!;
    expect(provider.resolveFetchModel(ctx as never)).not.toBeNull();
  });

  it("opencode provider does not match when getAvailable has no opencode model", () => {
    const ctx = makeCtxWithAvailable([{ provider: "openai-codex", id: "a" }]);
    const provider = getProviderById("opencode")!;
    expect(provider.resolveFetchModel(ctx as never)).toBeNull();
  });
});

describe("getUsage caching", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("does not let Codex and Opencode snapshots overwrite each other", async () => {
    let codexFetchCount = 0;

    globalThis.fetch = async (url) => {
      if (typeof url === "string" && url.includes("wham")) {
        codexFetchCount++;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            rate_limit: {
              primary_window: { used_percent: codexFetchCount * 10 },
            },
          }),
        } as Response;
      }
      throw new Error("unexpected fetch");
    };

    const codexModel = { provider: "openai-codex", id: "c1" };
    const opencodeModel = { provider: "opencode", id: "o1" };
    const ctx = makeCtxWithAvailable([codexModel, opencodeModel]);

    const r1 = await getUsage(codexModel as never, ctx as never, true);
    const r2 = await getUsage(opencodeModel as never, ctx as never, true);
    const r3 = await getUsage(codexModel as never, ctx as never, false);

    expect(r1).not.toBeNull();
    expect(r1!.provider).toBe("codex");
    expect(r1!.primary!.usedPercent).toBe(10);

    expect(r2).not.toBeNull();
    expect(r2!.provider).toBe("opencode");
    expect(r2!.error).toBeDefined();

    expect(r3).not.toBeNull();
    expect(r3!.provider).toBe("codex");
    expect(r3!.primary!.usedPercent).toBe(10);
    expect(codexFetchCount).toBe(1);
  });

  it("re-fetches after TTL expires", async () => {
    let callCount = 0;
    globalThis.fetch = async () => {
      callCount++;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          rate_limit: { primary_window: { used_percent: callCount } },
        }),
      } as Response;
    };

    const m = { provider: "openai-codex", id: "ttl-test" };
    const ctx = makeCtxWithAvailable([m]);

    await getUsage(m as never, ctx as never, true);
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + CACHE_TTL_MS + 1000);
    const r2 = await getUsage(m as never, ctx as never, false);
    expect(callCount).toBe(2);
    expect(r2!.primary!.usedPercent).toBe(2);
  });

  it("does not share cache entries between different models of the same provider", async () => {
    let callCount = 0;
    globalThis.fetch = async () => {
      callCount++;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          rate_limit: { primary_window: { used_percent: callCount } },
        }),
      } as Response;
    };

    const m1 = { provider: "openai-codex", id: "model-a" };
    const m2 = { provider: "openai-codex", id: "model-b" };
    const ctx = makeCtxWithAvailable([m1, m2]);

    const r1 = await getUsage(m1 as never, ctx as never, true);
    const r2 = await getUsage(m2 as never, ctx as never, true);
    const r3 = await getUsage(m1 as never, ctx as never, false);

    expect(callCount).toBe(2);
    expect(r1!.primary!.usedPercent).toBe(1);
    expect(r2!.primary!.usedPercent).toBe(2);
    expect(r3!.primary!.usedPercent).toBe(1);
  });

  it("does not cache null results so transient failures can be retried", async () => {
    let callCount = 0;
    globalThis.fetch = async () => {
      callCount++;
      if (callCount === 1) {
        throw new Error("network error");
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          rate_limit: { primary_window: { used_percent: 42 } },
        }),
      } as Response;
    };

    const m = { provider: "openai-codex", id: "retry-test" };
    const ctx = makeCtxWithAvailable([m]);

    const r1 = await getUsage(m as never, ctx as never, true);
    expect(r1).toBeNull();
    expect(callCount).toBe(1);

    const r2 = await getUsage(m as never, ctx as never, false);
    expect(r2).not.toBeNull();
    expect(r2!.primary!.usedPercent).toBe(42);
    expect(callCount).toBe(2);
  });
});
