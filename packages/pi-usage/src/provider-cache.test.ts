import { describe, it, expect, afterEach, vi } from "vitest";

type FakeModel = { provider: string; id: string };

function makeCtx(models: FakeModel[]) {
  return {
    modelRegistry: {
      getAvailable: () => models,
      getApiKeyAndHeaders: async () => ({ ok: true, headers: {} }),
    },
  };
}

describe("shared usage cache", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    vi.doUnmock("./providers/codex.js");
    vi.doUnmock("./providers/opencode.js");
  });

  it("does not cache error snapshots", async () => {
    let callCount = 0;
    vi.doMock("./providers/opencode.js", () => ({
      getUsage: vi.fn(async () => {
        callCount++;
        if (callCount === 1) {
          return {
            provider: "opencode" as const,
            fetchedAt: Date.now(),
            error:
              "Opencode credentials not configured. Run /usage auth to set them up.",
          };
        }
        return {
          provider: "opencode" as const,
          primary: { usedPercent: 12 },
          fetchedAt: Date.now(),
        };
      }),
    }));
    vi.doMock("./providers/codex.js", () => ({
      getUsage: vi.fn(async () => null),
    }));

    const { getUsage } = await import("./provider.js");
    const model = { provider: "opencode", id: "go-1" };
    const ctx = makeCtx([model]);

    const first = await getUsage(model as never, ctx as never, true);
    const second = await getUsage(model as never, ctx as never, false);

    expect(first?.error).toContain("/usage auth");
    expect(second?.primary?.usedPercent).toBe(12);
    expect(callCount).toBe(2);
  });
});
