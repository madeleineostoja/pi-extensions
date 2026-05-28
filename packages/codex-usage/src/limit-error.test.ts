import { describe, it, expect } from "vitest";
import {
  isCodexLimitError,
  formatLimitReplacementText,
} from "./limit-error.js";
import type { UsageSnapshot } from "./usage.js";

function makeMsg(text: string, role = "assistant"): unknown {
  return { role, content: [{ type: "text", text }] };
}

function makeStringContentMsg(text: string): unknown {
  return { role: "assistant", content: text };
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

  it("returns false for messages with no content", () => {
    expect(isCodexLimitError({ role: "assistant", content: [] })).toBe(false);
  });

  it("detects plain text with both limit and codex indicators", () => {
    expect(
      isCodexLimitError(
        makeMsg("You have hit the codex openai rate limit 429"),
      ),
    ).toBe(true);
  });

  it("returns false when only limit indicator present (no codex indicator)", () => {
    expect(
      isCodexLimitError(makeMsg("You have hit your quota for requests")),
    ).toBe(false);
  });

  it("returns false when only codex indicator present (no limit indicator)", () => {
    expect(
      isCodexLimitError(makeMsg("OpenAI Codex is a great AI system")),
    ).toBe(false);
  });

  it("detects direct JSON with limit + codex in leaf string", () => {
    const payload = JSON.stringify({
      error: {
        message: "You have exceeded your OpenAI Codex rate_limit",
        code: "quota_exceeded",
      },
    });
    expect(isCodexLimitError(makeMsg(payload))).toBe(true);
  });

  it("detects JSON string shape (escaped JSON in a string)", () => {
    const inner = JSON.stringify({
      error: "OpenAI Codex rate_limit exceeded",
    });
    const outer = JSON.stringify(inner);
    expect(isCodexLimitError(makeMsg(outer))).toBe(true);
  });

  it("detects JSON embedded in prose text", () => {
    const embedded = `Server responded: {"error":"chatgpt quota exceeded","code":"429"}`;
    expect(isCodexLimitError(makeMsg(embedded))).toBe(true);
  });

  it("detects limit+codex across combined leaf strings in JSON", () => {
    const payload = JSON.stringify({
      provider: "openai",
      status: "rate_limit",
    });
    expect(isCodexLimitError(makeMsg(payload))).toBe(true);
  });

  it("detects error in errorMessage field", () => {
    expect(
      isCodexLimitError(makeErrorMsgMsg("OpenAI Codex wham rate_limit hit")),
    ).toBe(true);
  });

  it("detects error in string content", () => {
    expect(
      isCodexLimitError(makeStringContentMsg("chatgpt quota limit reached")),
    ).toBe(true);
  });

  it("returns false for ordinary JSON unrelated to limits", () => {
    const payload = JSON.stringify({ result: "success", model: "codex-mini" });
    expect(isCodexLimitError(makeMsg(payload))).toBe(false);
  });

  it("returns false for unrelated provider error", () => {
    expect(
      isCodexLimitError(makeMsg("Anthropic Claude rate_limit exceeded")),
    ).toBe(false);
  });

  it("returns false for unrelated plain text", () => {
    expect(isCodexLimitError(makeMsg("Everything is working fine today"))).toBe(
      false,
    );
  });

  it("detects wham indicator in error", () => {
    expect(isCodexLimitError(makeMsg("wham quota 429 exceeded"))).toBe(true);
  });
});

describe("formatLimitReplacementText", () => {
  it("includes both window percentages when snapshot has both", () => {
    const snapshot: UsageSnapshot = {
      fiveHour: { usedPercent: 42 },
      weekly: { usedPercent: 71 },
      fetchedAt: Date.now(),
    };
    const text = formatLimitReplacementText(snapshot);
    expect(text).toContain("5h 42%");
    expect(text).toContain("W 71%");
  });

  it("includes only fiveHour when weekly is absent", () => {
    const snapshot: UsageSnapshot = {
      fiveHour: { usedPercent: 55 },
      fetchedAt: Date.now(),
    };
    const text = formatLimitReplacementText(snapshot);
    expect(text).toContain("5h 55%");
    expect(text).not.toContain("W");
  });

  it("includes only weekly when fiveHour is absent", () => {
    const snapshot: UsageSnapshot = {
      weekly: { usedPercent: 88 },
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
    const snapshot: UsageSnapshot = { fetchedAt: Date.now() };
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
      fiveHour: { usedPercent: 42.7 },
      weekly: { usedPercent: 71.2 },
      fetchedAt: Date.now(),
    };
    const text = formatLimitReplacementText(snapshot);
    expect(text).toContain("5h 43%");
    expect(text).toContain("W 71%");
  });
});
