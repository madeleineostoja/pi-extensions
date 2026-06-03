process.env.TZ = "UTC";

import { describe, it, expect } from "vitest";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { formatStatus } from "./format.js";
import { ICON } from "./constants.js";
import type { UsageSnapshot } from "./usage.js";

type SpyTheme = Theme & {
  calls: Array<{ color: string; text: string }>;
};

function makeSpyTheme(): SpyTheme {
  const calls: Array<{ color: string; text: string }> = [];
  return {
    fg(color: string, text: string) {
      calls.push({ color, text });
      return `[${color}:${text}]`;
    },
    bg(_color: string, text: string) {
      return text;
    },
    bold: (t: string) => t,
    italic: (t: string) => t,
    underline: (t: string) => t,
    inverse: (t: string) => t,
    strikethrough: (t: string) => t,
    getFgAnsi: () => "",
    getBgAnsi: () => "",
    getColorMode: () => "truecolor" as const,
    getThinkingBorderColor: () => (s: string) => s,
    getBashModeBorderColor: () => (s: string) => s,
    calls,
  } as unknown as SpyTheme;
}

describe("formatStatus", () => {
  it("returns warning-colored unknown status when snapshot is null", () => {
    const theme = makeSpyTheme();
    const result = formatStatus(null, theme);
    expect(result).toBe(`[warning:${ICON}] [warning:codex usage ?]`);
    expect(theme.calls).toEqual([
      { color: "warning", text: ICON },
      { color: "warning", text: "codex usage ?" },
    ]);
  });

  it("formats compact status with both windows", () => {
    const theme = makeSpyTheme();
    const snapshot: UsageSnapshot = {
      fiveHour: { usedPercent: 42 },
      weekly: { usedPercent: 71 },
      fetchedAt: Date.now(),
    };
    const result = formatStatus(snapshot, theme);
    expect(result).toBe(`[success:${ICON}] [muted:codex 42% (71%)]`);
  });

  it("omits fiveHour section when fiveHour is undefined", () => {
    const theme = makeSpyTheme();
    const snapshot: UsageSnapshot = {
      weekly: { usedPercent: 55 },
      fetchedAt: Date.now(),
    };
    const result = formatStatus(snapshot, theme);
    expect(result).toContain("codex (55%)");
  });

  it("omits weekly section when weekly is undefined", () => {
    const theme = makeSpyTheme();
    const snapshot: UsageSnapshot = {
      fiveHour: { usedPercent: 10 },
      fetchedAt: Date.now(),
    };
    const result = formatStatus(snapshot, theme);
    expect(result).toContain("codex 10%");
  });

  it("hides status when both windows are undefined", () => {
    const theme = makeSpyTheme();
    const snapshot: UsageSnapshot = { fetchedAt: Date.now() };
    const result = formatStatus(snapshot, theme);
    expect(result).toBeUndefined();
    expect(theme.calls).toHaveLength(0);
  });

  it("uses success icon and muted text when worst percent is below 80", () => {
    const theme = makeSpyTheme();
    const snapshot: UsageSnapshot = {
      fiveHour: { usedPercent: 50 },
      weekly: { usedPercent: 30 },
      fetchedAt: Date.now(),
    };
    formatStatus(snapshot, theme);
    expect(theme.calls).toEqual([
      { color: "success", text: ICON },
      { color: "muted", text: "codex 50% (30%)" },
    ]);
  });

  it("uses warning color for icon and text when worst percent is 80–94", () => {
    const theme = makeSpyTheme();
    const snapshot: UsageSnapshot = {
      fiveHour: { usedPercent: 80 },
      weekly: { usedPercent: 20 },
      fetchedAt: Date.now(),
    };
    formatStatus(snapshot, theme);
    expect(theme.calls).toEqual([
      { color: "warning", text: ICON },
      { color: "warning", text: "codex 80% (20%)" },
    ]);
  });

  it("uses warning color at 94%", () => {
    const theme = makeSpyTheme();
    const snapshot: UsageSnapshot = {
      fiveHour: { usedPercent: 94 },
      fetchedAt: Date.now(),
    };
    formatStatus(snapshot, theme);
    expect(theme.calls).toEqual([
      { color: "warning", text: ICON },
      { color: "warning", text: "codex 94%" },
    ]);
  });

  it("uses error color for icon and text when worst percent is 95 or above", () => {
    const theme = makeSpyTheme();
    const snapshot: UsageSnapshot = {
      fiveHour: { usedPercent: 95 },
      weekly: { usedPercent: 40 },
      fetchedAt: Date.now(),
    };
    formatStatus(snapshot, theme);
    expect(theme.calls).toEqual([
      { color: "error", text: ICON },
      { color: "error", text: "codex 95% (40%)" },
    ]);
  });

  it("uses error color at 100%", () => {
    const theme = makeSpyTheme();
    const snapshot: UsageSnapshot = {
      weekly: { usedPercent: 100 },
      fetchedAt: Date.now(),
    };
    formatStatus(snapshot, theme);
    expect(theme.calls).toEqual([
      { color: "error", text: ICON },
      { color: "error", text: "codex (100%)" },
    ]);
  });

  it("shows reset time instead of 100% for fiveHour when resetAt is present", () => {
    const theme = makeSpyTheme();
    const snapshot: UsageSnapshot = {
      fiveHour: { usedPercent: 100, resetAt: 0 },
      fetchedAt: Date.now(),
    };
    const result = formatStatus(snapshot, theme);
    expect(result).toContain("codex resets at 00:00");
    expect(theme.calls).toEqual([
      { color: "error", text: ICON },
      { color: "error", text: "codex resets at 00:00" },
    ]);
  });

  it("shows reset time instead of 100% for weekly when resetAt is present", () => {
    const theme = makeSpyTheme();
    const snapshot: UsageSnapshot = {
      weekly: { usedPercent: 100, resetAt: 3661 },
      fetchedAt: Date.now(),
    };
    const result = formatStatus(snapshot, theme);
    expect(result).toContain("codex (resets at 01:01)");
    expect(theme.calls).toEqual([
      { color: "error", text: ICON },
      { color: "error", text: "codex (resets at 01:01)" },
    ]);
  });

  it("falls back to 100% when resetAt is missing", () => {
    const theme = makeSpyTheme();
    const snapshot: UsageSnapshot = {
      fiveHour: { usedPercent: 100 },
      fetchedAt: Date.now(),
    };
    const result = formatStatus(snapshot, theme);
    expect(result).toContain("codex 100%");
  });

  it("shows reset time for one window and percent for the other", () => {
    const theme = makeSpyTheme();
    const snapshot: UsageSnapshot = {
      fiveHour: { usedPercent: 100, resetAt: 7200 },
      weekly: { usedPercent: 42 },
      fetchedAt: Date.now(),
    };
    const result = formatStatus(snapshot, theme);
    expect(result).toContain("codex resets at 02:00 (42%)");
    expect(theme.calls).toEqual([
      { color: "error", text: ICON },
      { color: "error", text: "codex resets at 02:00 (42%)" },
    ]);
  });

  it("rounds percentages to whole numbers", () => {
    const theme = makeSpyTheme();
    const snapshot: UsageSnapshot = {
      fiveHour: { usedPercent: 42.6 },
      weekly: { usedPercent: 71.2 },
      fetchedAt: Date.now(),
    };
    const result = formatStatus(snapshot, theme);
    expect(result).toContain("codex 43% (71%)");
  });

  it("clamps displayed percentages to 0–100", () => {
    const theme = makeSpyTheme();
    const snapshot: UsageSnapshot = {
      fiveHour: { usedPercent: -5 },
      weekly: { usedPercent: 145 },
      fetchedAt: Date.now(),
    };
    const result = formatStatus(snapshot, theme);
    expect(result).toContain("codex 0% (100%)");
  });

  it("uses clamped percentages for color selection", () => {
    const theme = makeSpyTheme();
    const snapshot: UsageSnapshot = {
      fiveHour: { usedPercent: 145 },
      fetchedAt: Date.now(),
    };
    formatStatus(snapshot, theme);
    expect(theme.calls).toEqual([
      { color: "error", text: ICON },
      { color: "error", text: "codex 100%" },
    ]);
  });

  it("colors icon and text separately", () => {
    const theme = makeSpyTheme();
    const snapshot: UsageSnapshot = {
      fiveHour: { usedPercent: 10 },
      fetchedAt: Date.now(),
    };
    formatStatus(snapshot, theme);
    expect(theme.calls).toHaveLength(2);
  });
});
