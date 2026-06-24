import { describe, it, expect } from "vitest";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  buildFooterLines,
  buildLeftSegment,
  buildRightSegment,
  buildStatusLine,
  formatCacheHitRate,
  formatContextPercent,
  sanitizeStatusText,
} from "./format.js";

function makeSpyTheme(): Theme & {
  calls: Array<{ method: string; color: string; text: string }>;
} {
  const calls: Array<{ method: string; color: string; text: string }> = [];
  return {
    fg(color: string, text: string) {
      calls.push({ method: "fg", color, text });
      return `[fg:${color}:${text}]`;
    },
    bg(color: string, text: string) {
      calls.push({ method: "bg", color, text });
      return `[bg:${color}:${text}]`;
    },
    bold(text: string) {
      return `**${text}**`;
    },
    italic(text: string) {
      return `*${text}*`;
    },
    underline(text: string) {
      return `_${text}_`;
    },
    inverse(text: string) {
      return `!${text}!`;
    },
    strikethrough(text: string) {
      return `~~${text}~~`;
    },
    getFgAnsi() {
      return "";
    },
    getBgAnsi() {
      return "";
    },
    getColorMode() {
      return "truecolor" as const;
    },
    getThinkingBorderColor() {
      return (s: string) => s;
    },
    getBashModeBorderColor() {
      return (s: string) => s;
    },
    calls,
  } as unknown as Theme & { calls: typeof calls };
}

function makePlainTheme(): Theme {
  return {
    fg(_color: string, text: string) {
      return text;
    },
    bg() {
      return "";
    },
    bold(text: string) {
      return text;
    },
    italic(text: string) {
      return text;
    },
    underline(text: string) {
      return text;
    },
    inverse(text: string) {
      return text;
    },
    strikethrough(text: string) {
      return text;
    },
    getFgAnsi() {
      return "";
    },
    getBgAnsi() {
      return "";
    },
    getColorMode() {
      return "truecolor" as const;
    },
    getThinkingBorderColor() {
      return (s: string) => s;
    },
    getBashModeBorderColor() {
      return (s: string) => s;
    },
  } as unknown as Theme;
}

describe("compact footer formatting", () => {
  it("colors context pressure at the warning and error thresholds", () => {
    const theme = makeSpyTheme();

    formatContextPercent(null, theme);
    formatContextPercent(12.5, theme);
    formatContextPercent(70, theme);
    formatContextPercent(90, theme);

    expect(theme.calls).toContainEqual({
      method: "fg",
      color: "dim",
      text: "?%",
    });
    expect(theme.calls).toContainEqual({
      method: "fg",
      color: "muted",
      text: "13%",
    });
    expect(theme.calls).toContainEqual({
      method: "fg",
      color: "warning",
      text: "70%",
    });
    expect(theme.calls).toContainEqual({
      method: "fg",
      color: "error",
      text: "90%",
    });
  });
});

describe("footer segments", () => {
  it("shows cwd basename and branch when available", () => {
    const result = buildLeftSegment(
      "/Users/mads/Code/pi-extensions",
      "main",
      makePlainTheme(),
    );

    expect(result).toBe("pi-extensions on  main");
  });

  it("formats billable and subscription right segments differently", () => {
    const theme = makePlainTheme();

    const billable = buildRightSegment(
      { name: "GPT-5.5", id: "openai-codex/gpt-5.5" },
      "high",
      0.04,
      { percent: 12, contextWindow: 272000 },
      false,
      theme,
      true,
    );
    const subscription = buildRightSegment(
      { name: "Claude Sonnet 4.6", id: "claude-sonnet" },
      "high",
      0.04,
      { percent: 12, contextWindow: 200000 },
      true,
      theme,
      true,
    );

    expect(billable).toContain("GPT-5.5 (high)");
    expect(billable).toContain("$0.04");
    expect(billable).toContain("12% (272k)");
    expect(subscription).toContain("Claude Sonnet 4.6 (high)");
    expect(subscription).not.toContain("$");
    expect(subscription).toContain("12% (200k)");
  });

  it("can omit context window and provider details", () => {
    const result = buildRightSegment(
      { name: "Custom Name", id: "provider/model-id", provider: "custom" },
      "off",
      0,
      { percent: 12, contextWindow: 272000 },
      false,
      makePlainTheme(),
      false,
      true,
    );

    expect(result).toContain("(custom) Custom Name (off)");
    expect(result).toContain("12%");
    expect(result).not.toContain("272k");
  });
});

describe("status line sanitization", () => {
  it("normalizes control whitespace and strips non-SGR control sequences", () => {
    expect(sanitizeStatusText("  a\nb\tc\r  ")).toBe("a b c");
    expect(
      sanitizeStatusText("a\x1b[2Jb\x1b]8;;https://x\x07c\x1b]8;;\x07\x01"),
    ).toBe("abc");
  });

  it("preserves SGR-colored statuses and mutes plain statuses", () => {
    const coloredTheme = makeSpyTheme();
    expect(
      buildStatusLine(new Map([["k", "\x1b[31mcolored\x1b[0m"]]), coloredTheme),
    ).toBe("\x1b[31mcolored\x1b[0m");
    expect(coloredTheme.calls).toHaveLength(0);

    const plainTheme = makeSpyTheme();
    buildStatusLine(new Map([["k", "readonly"]]), plainTheme);
    expect(plainTheme.calls).toContainEqual({
      method: "fg",
      color: "muted",
      text: "readonly",
    });
  });

  it("prioritizes common extension statuses before sorting unknown keys", () => {
    const result = buildStatusLine(
      new Map([
        ["z", "z-status"],
        ["pi-usage", "usage-status"],
        ["sandbox", "sandbox-status"],
        ["pi-implement.status", "implement-status"],
        ["a", "a-status"],
        ["pi-readonly.mode", "readonly-status"],
      ]),
      makePlainTheme(),
    );

    expect(result.indexOf("implement-status")).toBeLessThan(
      result.indexOf("readonly-status"),
    );
    expect(result.indexOf("readonly-status")).toBeLessThan(
      result.indexOf("sandbox-status"),
    );
    expect(result.indexOf("sandbox-status")).toBeLessThan(
      result.indexOf("usage-status"),
    );
    expect(result.indexOf("usage-status")).toBeLessThan(
      result.indexOf("a-status"),
    );
    expect(result.indexOf("a-status")).toBeLessThan(result.indexOf("z-status"));
  });
});

describe("footer line layout", () => {
  it("uses one line without statuses and two lines with statuses", () => {
    const theme = makePlainTheme();

    expect(
      buildFooterLines(120, "left", "right", "right", new Map(), theme),
    ).toHaveLength(1);
    expect(
      buildFooterLines(
        120,
        "left",
        "right",
        "right",
        new Map([["k", "v"]]),
        theme,
      ),
    ).toHaveLength(2);
  });

  it("aligns left and right when both fit", () => {
    const lines = buildFooterLines(
      20,
      "left",
      "right",
      "right",
      new Map(),
      makePlainTheme(),
    );

    expect(lines[0]).toBe("left" + " ".repeat(11) + "right");
  });

  it("drops the window suffix before truncating", () => {
    const lines = buildFooterLines(
      "left".length + 2 + "right-wo".length,
      "left",
      "right-with-window",
      "right-wo",
      new Map(),
      makePlainTheme(),
    );

    expect(lines[0]).toContain("right-wo");
    expect(lines[0]).not.toContain("right-with-window");
  });

  it("truncates overlong footer content", () => {
    const theme = makePlainTheme();
    const firstLine = buildFooterLines(
      10,
      "left",
      "right-that-is-very-long",
      "right-that-is-very-long",
      new Map(),
      theme,
    );
    const withStatus = buildFooterLines(
      80,
      "left",
      "right",
      "right",
      new Map([["k", "a".repeat(200)]]),
      theme,
    );

    expect(firstLine[0]).not.toContain("right-that-is-very-long");
    expect(withStatus[1]).not.toContain("a".repeat(200));
  });
});

describe("cache hit rate formatting", () => {
  it("formats with the cached icon rounded to a whole percent", () => {
    expect(formatCacheHitRate(42.5)).toBe("󰃨 43%");
    expect(formatCacheHitRate(0)).toBe("󰃨 0%");
    expect(formatCacheHitRate(99.99)).toBe("󰃨 100%");
  });

  it("shows cache hit rate between cost and context", () => {
    const result = buildRightSegment(
      { name: "Test" },
      "off",
      0.01,
      { percent: 50, contextWindow: 128000 },
      false,
      makePlainTheme(),
      true,
      false,
      75.5,
    );

    expect(result).toContain("Test (off)");
    expect(result).toContain("$0.01");
    expect(result).toContain("󰃨 76%");
    expect(result).toContain("50% (128k)");

    const parts = result.split(" · ");
    expect(parts[2]).toContain("󰃨 76%");
    expect(parts[3]).toContain("50%");
  });

  it("omits cache hit rate when undefined", () => {
    const result = buildRightSegment(
      { name: "Test" },
      "off",
      0.01,
      { percent: 50, contextWindow: 128000 },
      false,
      makePlainTheme(),
      true,
      false,
    );

    expect(result).not.toContain("󰃨");
  });
});
