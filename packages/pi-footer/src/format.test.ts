import { describe, it, expect } from "vitest";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  buildFooterLines,
  buildLeftSegment,
  buildRightSegment,
  buildStatusLine,
  formatCompactTokens,
  formatContextPercent,
  formatCost,
  formatModelName,
  formatThinking,
  hasAnsi,
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

describe("formatCompactTokens", () => {
  it("formats small numbers raw", () => {
    expect(formatCompactTokens(0)).toBe("0");
    expect(formatCompactTokens(999)).toBe("999");
  });

  it("formats thousands with one decimal when under 10k", () => {
    expect(formatCompactTokens(1500)).toBe("1.5k");
    expect(formatCompactTokens(9500)).toBe("9.5k");
  });

  it("formats thousands rounded when 10k–1M", () => {
    expect(formatCompactTokens(10000)).toBe("10k");
    expect(formatCompactTokens(272000)).toBe("272k");
    expect(formatCompactTokens(999999)).toBe("1000k");
  });

  it("formats millions with one decimal when under 10M", () => {
    expect(formatCompactTokens(1500000)).toBe("1.5M");
    expect(formatCompactTokens(9500000)).toBe("9.5M");
  });

  it("formats millions rounded when 10M+", () => {
    expect(formatCompactTokens(10000000)).toBe("10M");
    expect(formatCompactTokens(15000000)).toBe("15M");
  });
});

describe("formatCost", () => {
  it("rounds to exactly two decimal places in cents", () => {
    expect(formatCost(0)).toBe("$0.00");
    expect(formatCost(0.004)).toBe("$0.00");
    expect(formatCost(0.046)).toBe("$0.05");
    expect(formatCost(1.2)).toBe("$1.20");
    expect(formatCost(1.205)).toBe("$1.21");
  });
});

describe("formatModelName", () => {
  it("prefers name over id", () => {
    expect(
      formatModelName({ name: "GPT-5.5", id: "openai-codex/gpt-5.5" }),
    ).toBe("GPT-5.5");
  });

  it("falls back to id when name is absent", () => {
    expect(formatModelName({ id: "claude-sonnet" })).toBe("claude-sonnet");
  });

  it("returns no model when undefined", () => {
    expect(formatModelName(undefined)).toBe("no model");
  });

  it("includes provider when requested", () => {
    expect(
      formatModelName(
        { name: "GPT-5.5", id: "gpt-5.5", provider: "openai" },
        true,
      ),
    ).toBe("(openai) GPT-5.5");
  });
});

describe("formatThinking", () => {
  it("uses the correct thinking ladder token for each level", () => {
    const theme = makeSpyTheme();
    formatThinking("off", theme);
    expect(theme.calls).toContainEqual({
      method: "fg",
      color: "thinkingOff",
      text: "(off)",
    });

    formatThinking("minimal", theme);
    expect(theme.calls).toContainEqual({
      method: "fg",
      color: "thinkingMinimal",
      text: "(minimal)",
    });

    formatThinking("low", theme);
    expect(theme.calls).toContainEqual({
      method: "fg",
      color: "thinkingLow",
      text: "(low)",
    });

    formatThinking("medium", theme);
    expect(theme.calls).toContainEqual({
      method: "fg",
      color: "thinkingMedium",
      text: "(medium)",
    });

    formatThinking("high", theme);
    expect(theme.calls).toContainEqual({
      method: "fg",
      color: "thinkingHigh",
      text: "(high)",
    });

    formatThinking("xhigh", theme);
    expect(theme.calls).toContainEqual({
      method: "fg",
      color: "thinkingXhigh",
      text: "(xhigh)",
    });
  });

  it("renders text with level in parentheses", () => {
    const theme = makePlainTheme();
    expect(formatThinking("high", theme)).toBe("(high)");
  });
});

describe("formatContextPercent", () => {
  it("rounds to whole percentages", () => {
    const theme = makePlainTheme();
    expect(formatContextPercent(12.4, theme)).toBe("12%");
    expect(formatContextPercent(12.5, theme)).toBe("13%");
  });

  it("returns ?% for null", () => {
    const theme = makePlainTheme();
    expect(formatContextPercent(null, theme)).toBe("?%");
  });

  it("uses muted for <70%", () => {
    const theme = makeSpyTheme();
    formatContextPercent(12, theme);
    expect(theme.calls).toContainEqual({
      method: "fg",
      color: "muted",
      text: "12%",
    });
  });

  it("uses warning for 70%–89%", () => {
    const theme = makeSpyTheme();
    formatContextPercent(70, theme);
    expect(theme.calls).toContainEqual({
      method: "fg",
      color: "warning",
      text: "70%",
    });
    formatContextPercent(89, theme);
    expect(theme.calls).toContainEqual({
      method: "fg",
      color: "warning",
      text: "89%",
    });
  });

  it("uses error for >=90%", () => {
    const theme = makeSpyTheme();
    formatContextPercent(90, theme);
    expect(theme.calls).toContainEqual({
      method: "fg",
      color: "error",
      text: "90%",
    });
  });
});

describe("buildLeftSegment", () => {
  it("shows cwd basename and branch when available", () => {
    const theme = makePlainTheme();
    const result = buildLeftSegment(
      "/Users/mads/Code/pi-extensions",
      "main",
      theme,
    );
    expect(result).toBe("pi-extensions on  main");
  });

  it("omits branch text when branch is null", () => {
    const theme = makePlainTheme();
    const result = buildLeftSegment(
      "/Users/mads/Code/pi-extensions",
      null,
      theme,
    );
    expect(result).toBe("pi-extensions");
  });

  it("uses accent for cwd and branch, dim for on", () => {
    const theme = makeSpyTheme();
    buildLeftSegment("/Users/mads/Code/pi-extensions", "main", theme);
    expect(theme.calls).toContainEqual({
      method: "fg",
      color: "accent",
      text: "pi-extensions",
    });
    expect(theme.calls).toContainEqual({
      method: "fg",
      color: "dim",
      text: "on",
    });
    expect(theme.calls).toContainEqual({
      method: "fg",
      color: "accent",
      text: " main",
    });
  });
});

describe("buildRightSegment", () => {
  it("formats non-subscription model with cost and window", () => {
    const theme = makePlainTheme();
    const result = buildRightSegment(
      { name: "GPT-5.5", id: "openai-codex/gpt-5.5" },
      "high",
      0.04,
      { percent: 12, contextWindow: 272000 },
      false,
      theme,
      true,
    );
    expect(result).toContain("GPT-5.5 (high)");
    expect(result).toContain("$0.04");
    expect(result).toContain("ctx 12% (272k)");
  });

  it("hides cost for subscription models", () => {
    const theme = makePlainTheme();
    const result = buildRightSegment(
      { name: "Claude Sonnet 4.6", id: "claude-sonnet" },
      "high",
      0.04,
      { percent: 12, contextWindow: 200000 },
      true,
      theme,
      true,
    );
    expect(result).toContain("Claude Sonnet 4.6 (high)");
    expect(result).not.toContain("$");
    expect(result).not.toContain("sub");
    expect(result).toContain("ctx 12% (200k)");
  });

  it("drops window when includeWindow is false", () => {
    const theme = makePlainTheme();
    const result = buildRightSegment(
      { name: "GPT-5.5", id: "openai-codex/gpt-5.5" },
      "high",
      0.04,
      { percent: 12, contextWindow: 272000 },
      false,
      theme,
      false,
    );
    expect(result).toContain("ctx 12%");
    expect(result).not.toContain("272k");
  });

  it("shows no model when model is missing", () => {
    const theme = makePlainTheme();
    const result = buildRightSegment(
      undefined,
      "off",
      0,
      undefined,
      false,
      theme,
      false,
    );
    expect(result).toContain("no model (off)");
    expect(result).toContain("ctx ?%");
  });

  it("prefers model name over id", () => {
    const theme = makePlainTheme();
    const result = buildRightSegment(
      { name: "Custom Name", id: "provider/model-id" },
      "off",
      0,
      undefined,
      false,
      theme,
      false,
    );
    expect(result).toContain("Custom Name (off)");
  });

  it("includes provider when requested", () => {
    const theme = makePlainTheme();
    const result = buildRightSegment(
      { name: "Custom Name", id: "provider/model-id", provider: "custom" },
      "off",
      0,
      undefined,
      false,
      theme,
      false,
      true,
    );
    expect(result).toContain("(custom) Custom Name (off)");
  });
});

describe("sanitizeStatusText", () => {
  it("replaces newlines, tabs, and carriage returns with spaces", () => {
    expect(sanitizeStatusText("a\nb\tc\r")).toBe("a b c");
  });

  it("collapses multiple spaces", () => {
    expect(sanitizeStatusText("a   b")).toBe("a b");
  });

  it("trims leading and trailing whitespace", () => {
    expect(sanitizeStatusText("  hello  ")).toBe("hello");
  });

  it("preserves SGR color escape sequences", () => {
    expect(sanitizeStatusText("\x1b[31mred\x1b[0m")).toBe("\x1b[31mred\x1b[0m");
  });

  it("strips non-SGR escape and control sequences", () => {
    expect(
      sanitizeStatusText("a\x1b[2Jb\x1b]8;;https://x\x07c\x1b]8;;\x07\x01"),
    ).toBe("abc");
  });
});

describe("hasAnsi", () => {
  it("returns true for strings containing escape sequences", () => {
    expect(hasAnsi("\x1b[31mred\x1b[0m")).toBe(true);
  });

  it("returns false for plain strings", () => {
    expect(hasAnsi("plain text")).toBe(false);
  });
});

describe("buildStatusLine", () => {
  it("sorts statuses by key", () => {
    const theme = makePlainTheme();
    const statuses = new Map([
      ["z", "z-status"],
      ["a", "a-status"],
    ]);
    const result = buildStatusLine(statuses, theme);
    expect(result.indexOf("a-status")).toBeLessThan(result.indexOf("z-status"));
  });

  it("sanitizes status text", () => {
    const theme = makePlainTheme();
    const statuses = new Map([["k", "multi\nline"]]);
    const result = buildStatusLine(statuses, theme);
    expect(result).toBe("multi line");
  });

  it("preserves colored statuses without wrapping", () => {
    const theme = makeSpyTheme();
    const statuses = new Map([["k", "\x1b[31mcolored\x1b[0m"]]);
    const result = buildStatusLine(statuses, theme);
    expect(result).toBe("\x1b[31mcolored\x1b[0m");
    expect(theme.calls).toHaveLength(0);
  });

  it("wraps plain statuses in muted theme color", () => {
    const theme = makeSpyTheme();
    const statuses = new Map([["k", "readonly"]]);
    buildStatusLine(statuses, theme);
    expect(theme.calls).toContainEqual({
      method: "fg",
      color: "muted",
      text: "readonly",
    });
  });
});

describe("buildFooterLines", () => {
  it("returns one line when no statuses exist", () => {
    const theme = makePlainTheme();
    const lines = buildFooterLines(
      120,
      "left",
      "right-w",
      "right-wo",
      new Map(),
      theme,
    );
    expect(lines).toHaveLength(1);
  });

  it("returns two lines when statuses exist", () => {
    const theme = makePlainTheme();
    const lines = buildFooterLines(
      120,
      "left",
      "right-w",
      "right-wo",
      new Map([["k", "v"]]),
      theme,
    );
    expect(lines).toHaveLength(2);
  });

  it("left is flush-left and right is flush-right when both fit", () => {
    const theme = makePlainTheme();
    const left = "left";
    const right = "right";
    const lines = buildFooterLines(20, left, right, right, new Map(), theme);
    const expectedGap = 20 - 4 - 5;
    expect(lines[0]).toBe("left" + " ".repeat(expectedGap) + "right");
    expect(lines[0]!.indexOf("right")).toBe(4 + expectedGap);
  });

  it("drops window suffix first when full line does not fit", () => {
    const theme = makePlainTheme();
    const left = "left";
    const rightWith = "right-with-window";
    const rightWithout = "right-wo";
    const width = 4 + 2 + rightWithout.length; // left + gap + rightWithout fits, rightWith does not
    const lines = buildFooterLines(
      width,
      left,
      rightWith,
      rightWithout,
      new Map(),
      theme,
    );
    expect(lines[0]).toContain("right-wo");
    expect(lines[0]).not.toContain("right-with-window");
  });

  it("truncates right side when even without window it does not fit", () => {
    const theme = makePlainTheme();
    const left = "left";
    const right = "right-that-is-very-long";
    const width = 10;
    const lines = buildFooterLines(width, left, right, right, new Map(), theme);
    expect(lines[0]).not.toContain("right-that-is-very-long");
  });

  it("truncates left side alone when no room for right at all", () => {
    const theme = makePlainTheme();
    const left = "left-is-longer";
    const right = "r";
    const width = 6;
    const lines = buildFooterLines(width, left, right, right, new Map(), theme);
    expect(lines[0]).not.toContain("left-is-longer");
    expect(lines[0]).not.toContain("r");
  });

  it("second line is truncated to terminal width", () => {
    const theme = makePlainTheme();
    const statuses = new Map([["k", "a".repeat(200)]]);
    const lines = buildFooterLines(
      80,
      "left",
      "right",
      "right",
      statuses,
      theme,
    );
    expect(lines[1]).not.toContain("a".repeat(200));
  });
});
