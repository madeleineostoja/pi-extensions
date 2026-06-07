import { describe, it, expect } from "vitest";
import {
  isCodexLimitError,
  formatLimitReplacementText,
  buildLimitReplacementMessage,
} from "./limit-error.js";
import type { UsageSnapshot } from "./provider.js";

function makeMsg(text: string, role = "assistant"): unknown {
  return { role, content: [{ type: "text", text }] };
}

function makeErrorMsgMsg(errorMessage: string): unknown {
  return { role: "assistant", content: [], errorMessage };
}

describe("isCodexLimitError", () => {
  it("returns false for non-assistant messages", () => {
    expect(
      isCodexLimitError({
        role: "user",
        content: "hit the codex openai rate limit 429",
      }),
    ).toBe(false);
  });

  it("returns false for assistant messages with no errorMessage", () => {
    expect(isCodexLimitError({ role: "assistant", content: [] })).toBe(false);
    expect(
      isCodexLimitError(
        makeMsg("You have hit the codex openai rate limit 429"),
      ),
    ).toBe(false);
  });

  it("returns false when errorMessage has only limit indicator", () => {
    expect(
      isCodexLimitError(
        makeErrorMsgMsg("You have hit your quota for requests"),
      ),
    ).toBe(false);
  });

  it("returns false when errorMessage has only codex indicator", () => {
    expect(
      isCodexLimitError(makeErrorMsgMsg("OpenAI Codex is unavailable")),
    ).toBe(false);
  });

  it("detects errorMessage with both limit and codex indicators", () => {
    expect(
      isCodexLimitError(makeErrorMsgMsg("OpenAI Codex rate_limit exceeded")),
    ).toBe(true);
    expect(isCodexLimitError(makeErrorMsgMsg("chatgpt quota 429 hit"))).toBe(
      true,
    );
    expect(isCodexLimitError(makeErrorMsgMsg("wham limit reached"))).toBe(true);
  });

  it("returns false for unrelated provider errorMessage", () => {
    expect(
      isCodexLimitError(
        makeErrorMsgMsg("Anthropic Claude rate_limit exceeded"),
      ),
    ).toBe(false);
  });
});

describe("formatLimitReplacementText", () => {
  it("includes both window percentages when snapshot has both", () => {
    const snapshot: UsageSnapshot = {
      provider: "codex",
      primary: { usedPercent: 42 },
      secondary: { usedPercent: 71 },
      fetchedAt: Date.now(),
    };
    const text = formatLimitReplacementText(snapshot);
    expect(text).toContain("5h 42%");
    expect(text).toContain("W 71%");
  });

  it("includes only primary when secondary is absent", () => {
    const snapshot: UsageSnapshot = {
      provider: "codex",
      primary: { usedPercent: 55 },
      fetchedAt: Date.now(),
    };
    const text = formatLimitReplacementText(snapshot);
    expect(text).toContain("5h 55%");
    expect(text).not.toContain("W");
  });

  it("includes only secondary when primary is absent", () => {
    const snapshot: UsageSnapshot = {
      provider: "codex",
      secondary: { usedPercent: 88 },
      fetchedAt: Date.now(),
    };
    const text = formatLimitReplacementText(snapshot);
    expect(text).toContain("W 88%");
    expect(text).not.toContain("5h");
  });

  it("does not include usage line when snapshot is null", () => {
    const text = formatLimitReplacementText(null);
    expect(text).toContain("Codex usage limit reached");
    expect(text).not.toContain("%");
  });

  it("does not include usage line when both windows are absent", () => {
    const snapshot: UsageSnapshot = {
      provider: "codex",
      fetchedAt: Date.now(),
    };
    const text = formatLimitReplacementText(snapshot);
    expect(text).toContain("Codex usage limit reached");
    expect(text).not.toContain("%");
  });

  it("always contains the limit reached heading", () => {
    const text = formatLimitReplacementText(null);
    expect(text).toContain("🚫 Codex usage limit reached");
  });

  it("rounds percentages to whole numbers", () => {
    const snapshot: UsageSnapshot = {
      provider: "codex",
      primary: { usedPercent: 42.7 },
      secondary: { usedPercent: 71.2 },
      fetchedAt: Date.now(),
    };
    const text = formatLimitReplacementText(snapshot);
    expect(text).toContain("5h 43%");
    expect(text).toContain("W 71%");
  });
});

describe("buildLimitReplacementMessage", () => {
  it("removes the original raw errorMessage from the replacement", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      ({
        json: async () => ({
          rate_limit: { primary_window: { used_percent: 99 } },
        }),
      }) as Response;

    try {
      const message = {
        role: "assistant",
        content: [],
        errorMessage: '{"error":"OpenAI Codex rate_limit hit"}',
      };
      const ctx = {
        modelRegistry: {
          getAvailable: () => [],
          getApiKeyAndHeaders: async () => ({ ok: true, headers: {} }),
        },
      };

      const replacement = await buildLimitReplacementMessage(
        message as never,
        { provider: "openai-codex", id: "codex-1" } as never,
        ctx as never,
      );

      expect(
        "errorMessage" in (replacement as unknown as Record<string, unknown>),
      ).toBe(false);
      expect(JSON.stringify(replacement.content)).toContain(
        "Codex usage limit reached",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
