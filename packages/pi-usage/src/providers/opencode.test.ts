import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { fetchUsage, getUsage, parseUsage } from "./opencode.js";

const fakeModel = { provider: "opencode", id: "go-1" };
const fakeCtx = {} as never;

describe("fetchUsage", () => {
  it("returns null when fetch throws", async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error("network"));
    const result = await fetchUsage("wrk_1", "cookie", fetchFn);
    expect(result).toBeNull();
  });

  it("returns null when response text throws", async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      text: async () => {
        throw new Error("read fail");
      },
    });
    const result = await fetchUsage("wrk_1", "cookie", fetchFn);
    expect(result).toBeNull();
  });

  it("uses correct URL, cookie header, and user-agent", async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      text: async () => "",
    });
    await fetchUsage("wrk_test", "Fe26.2**abc", fetchFn);
    expect(fetchFn).toHaveBeenCalledWith(
      "https://opencode.ai/workspace/wrk_test/go",
      expect.objectContaining({
        headers: expect.objectContaining({
          Cookie: "auth=Fe26.2**abc",
          "User-Agent": expect.stringContaining("Mozilla/5.0"),
        }),
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("passes through parsed snapshot when windows are present", async () => {
    const html =
      "rollingUsage:$R[0]={usagePercent:42,resetInSec:3600} monthlyUsage:$R[1]={usagePercent:8,resetInSec:2592000}";
    const fetchFn = vi.fn().mockResolvedValue({
      text: async () => html,
    });
    const result = await fetchUsage("wrk_1", "cookie", fetchFn);
    expect(result).not.toBeNull();
    expect(result!.provider).toBe("opencode");
    expect(result!.primary).toEqual({ usedPercent: 42, resetInSec: 3600 });
    expect(result!.monthly).toEqual({ usedPercent: 8, resetInSec: 2592000 });
  });
});

describe("parseUsage", () => {
  it("extracts all three windows in usagePercent-first order", () => {
    const html =
      "rollingUsage:$R[0]={usagePercent:42,resetInSec:3600} weeklyUsage:$R[1]={usagePercent:17,resetInSec:86400} monthlyUsage:$R[2]={usagePercent:8,resetInSec:2592000}";
    const result = parseUsage(html);
    expect(result).not.toBeNull();
    expect(result!.provider).toBe("opencode");
    expect(result!.primary).toEqual({ usedPercent: 42, resetInSec: 3600 });
    expect(result!.secondary).toEqual({ usedPercent: 17, resetInSec: 86400 });
    expect(result!.monthly).toEqual({ usedPercent: 8, resetInSec: 2592000 });
  });

  it("extracts windows in resetInSec-first order", () => {
    const html = "rollingUsage:$R[0]={resetInSec:3600,usagePercent:42}";
    const result = parseUsage(html);
    expect(result!.primary).toEqual({ usedPercent: 42, resetInSec: 3600 });
  });

  it("returns null when no windows are present", () => {
    const result = parseUsage("<html><body>login page</body></html>");
    expect(result).toBeNull();
  });

  it("returns snapshot with partial windows", () => {
    const html = "rollingUsage:$R[0]={usagePercent:50,resetInSec:1800}";
    const result = parseUsage(html);
    expect(result!.primary).toEqual({ usedPercent: 50, resetInSec: 1800 });
    expect(result!.secondary).toBeUndefined();
    expect(result!.monthly).toBeUndefined();
  });

  it("matches real-world-like hydration shape", () => {
    const html =
      "some preamble rollingUsage:$R[3]={usagePercent:12.5,resetInSec:7200} weeklyUsage:$R[4]={resetInSec:432000,usagePercent:33.3} more stuff";
    const result = parseUsage(html);
    expect(result!.primary).toEqual({ usedPercent: 12.5, resetInSec: 7200 });
    expect(result!.secondary).toEqual({
      usedPercent: 33.3,
      resetInSec: 432000,
    });
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

  it("returns missing-auth snapshot when config is absent", async () => {
    const result = await getUsage(
      fakeModel as never,
      fakeCtx,
      true,
      () => null,
    );
    expect(result).not.toBeNull();
    expect(result!.provider).toBe("opencode");
    expect(result!.error).toContain("Run /usage auth");
  });

  it("returns missing-auth snapshot when config is malformed", async () => {
    const result = await getUsage(
      fakeModel as never,
      fakeCtx,
      true,
      () => ({ opencode: { workspaceId: 123 } }) as never,
    );
    expect(result).not.toBeNull();
    expect(result!.error).toContain("Run /usage auth");
  });

  it("fetches and returns snapshot when config is valid", async () => {
    globalThis.fetch = async () =>
      ({
        text: async () =>
          "rollingUsage:$R[0]={usagePercent:42,resetInSec:3600}",
      }) as Response;

    const result = await getUsage(fakeModel as never, fakeCtx, true, () => ({
      opencode: { workspaceId: "wrk_1", authCookie: "Fe26.2**test" },
    }));
    expect(result).not.toBeNull();
    expect(result!.provider).toBe("opencode");
    expect(result!.primary).toEqual({ usedPercent: 42, resetInSec: 3600 });
  });

  it("returns cached snapshot without re-fetching when within TTL", async () => {
    globalThis.fetch = async () =>
      ({
        text: async () =>
          "rollingUsage:$R[0]={usagePercent:10,resetInSec:3600}",
      }) as Response;

    const m = { provider: "opencode", id: "cache-test" };
    await getUsage(m as never, fakeCtx, true, () => ({
      opencode: { workspaceId: "wrk_1", authCookie: "cookie" },
    }));
    const r2 = await getUsage(m as never, fakeCtx, false, () => ({
      opencode: { workspaceId: "wrk_1", authCookie: "cookie" },
    }));
    expect(r2!.primary!.usedPercent).toBe(10);
  });

  it("re-fetches when force=true even within TTL", async () => {
    let callCount = 0;
    globalThis.fetch = async () => {
      callCount++;
      return {
        text: async () =>
          `rollingUsage:$R[0]={usagePercent:${callCount * 10},resetInSec:3600}`,
      } as Response;
    };

    const m = { provider: "opencode", id: "force-test" };
    await getUsage(m as never, fakeCtx, true, () => ({
      opencode: { workspaceId: "wrk_1", authCookie: "cookie" },
    }));
    await getUsage(m as never, fakeCtx, true, () => ({
      opencode: { workspaceId: "wrk_1", authCookie: "cookie" },
    }));
    expect(callCount).toBe(2);
  });

  it("returns stale cached snapshot when fetch fails and cache exists", async () => {
    globalThis.fetch = async () =>
      ({
        text: async () =>
          "rollingUsage:$R[0]={usagePercent:50,resetInSec:3600}",
      }) as Response;

    const m = { provider: "opencode", id: "stale-test" };
    await getUsage(m as never, fakeCtx, true, () => ({
      opencode: { workspaceId: "wrk_1", authCookie: "cookie" },
    }));

    globalThis.fetch = async () => {
      throw new Error("network");
    };
    const r2 = await getUsage(m as never, fakeCtx, true, () => ({
      opencode: { workspaceId: "wrk_1", authCookie: "cookie" },
    }));
    expect(r2).not.toBeNull();
    expect(r2!.stale).toBe(true);
    expect(r2!.primary!.usedPercent).toBe(50);
  });

  it("returns null when fetch fails and no cache exists", async () => {
    globalThis.fetch = async () => {
      throw new Error("network");
    };
    const m = { provider: "opencode", id: "no-cache-test" + Date.now() };
    const result = await getUsage(m as never, fakeCtx, true, () => ({
      opencode: { workspaceId: "wrk_1", authCookie: "cookie" },
    }));
    expect(result).toBeNull();
  });

  it("returns null for zero-window parse (login redirect shape)", async () => {
    globalThis.fetch = async () =>
      ({
        text: async () => "<html><body><h1>Login</h1></body></html>",
      }) as Response;

    const m = { provider: "opencode", id: "redirect-test" + Date.now() };
    const result = await getUsage(m as never, fakeCtx, true, () => ({
      opencode: { workspaceId: "wrk_1", authCookie: "cookie" },
    }));
    expect(result).toBeNull();
  });

  it("re-fetches after TTL expires", async () => {
    let callCount = 0;
    globalThis.fetch = async () => {
      callCount++;
      return {
        text: async () =>
          `rollingUsage:$R[0]={usagePercent:${callCount},resetInSec:3600}`,
      } as Response;
    };

    const m = { provider: "opencode", id: "ttl-test" };
    await getUsage(m as never, fakeCtx, true, () => ({
      opencode: { workspaceId: "wrk_1", authCookie: "cookie" },
    }));
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 5 * 60 * 1000 + 1000);
    const r2 = await getUsage(m as never, fakeCtx, false, () => ({
      opencode: { workspaceId: "wrk_1", authCookie: "cookie" },
    }));
    expect(callCount).toBe(2);
    expect(r2!.primary!.usedPercent).toBe(2);
  });
});
