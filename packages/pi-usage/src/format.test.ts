process.env.TZ = "UTC";

import { describe, it, expect, afterEach, vi } from "vitest";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { formatStatus, formatResetMessage } from "./format.js";
import { ICON } from "./constants.js";
import type { UsageSnapshot } from "./provider.js";

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

  it("formats compact status with both windows for codex", () => {
    const theme = makeSpyTheme();
    const snapshot: UsageSnapshot = {
      provider: "codex",
      primary: { usedPercent: 42 },
      secondary: { usedPercent: 71 },
      fetchedAt: Date.now(),
    };
    const result = formatStatus(snapshot, theme);
    expect(result).toBe(`[success:${ICON}] [muted:codex 42% (71%)]`);
  });

  it("formats compact status with both windows for opencode", () => {
    const theme = makeSpyTheme();
    const snapshot: UsageSnapshot = {
      provider: "opencode",
      primary: { usedPercent: 42 },
      secondary: { usedPercent: 71 },
      fetchedAt: Date.now(),
    };
    const result = formatStatus(snapshot, theme);
    expect(result).toBe(`[success:${ICON}] [muted:opencode 42% (71%)]`);
  });

  it("omits primary section when primary is undefined", () => {
    const theme = makeSpyTheme();
    const snapshot: UsageSnapshot = {
      provider: "codex",
      secondary: { usedPercent: 55 },
      fetchedAt: Date.now(),
    };
    const result = formatStatus(snapshot, theme);
    expect(result).toContain("codex (55%)");
  });

  it("omits secondary section when secondary is undefined", () => {
    const theme = makeSpyTheme();
    const snapshot: UsageSnapshot = {
      provider: "codex",
      primary: { usedPercent: 10 },
      fetchedAt: Date.now(),
    };
    const result = formatStatus(snapshot, theme);
    expect(result).toContain("codex 10%");
  });

  it("hides status when both windows are undefined", () => {
    const theme = makeSpyTheme();
    const snapshot: UsageSnapshot = {
      provider: "codex",
      fetchedAt: Date.now(),
    };
    const result = formatStatus(snapshot, theme);
    expect(result).toBeUndefined();
    expect(theme.calls).toHaveLength(0);
  });

  it("uses success icon and muted text when worst percent is below 80", () => {
    const theme = makeSpyTheme();
    const snapshot: UsageSnapshot = {
      provider: "codex",
      primary: { usedPercent: 50 },
      secondary: { usedPercent: 30 },
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
      provider: "codex",
      primary: { usedPercent: 80 },
      secondary: { usedPercent: 20 },
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
      provider: "codex",
      primary: { usedPercent: 94 },
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
      provider: "codex",
      primary: { usedPercent: 95 },
      secondary: { usedPercent: 40 },
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
      provider: "codex",
      secondary: { usedPercent: 100 },
      fetchedAt: Date.now(),
    };
    formatStatus(snapshot, theme);
    expect(theme.calls).toEqual([
      { color: "error", text: ICON },
      { color: "error", text: "codex (100%)" },
    ]);
  });

  it("shows reset time instead of 100% for primary when resetAt is present", () => {
    const theme = makeSpyTheme();
    const snapshot: UsageSnapshot = {
      provider: "codex",
      primary: { usedPercent: 100, resetAt: 0 },
      fetchedAt: Date.now(),
    };
    const result = formatStatus(snapshot, theme);
    expect(result).toContain("codex resets at 00:00");
    expect(theme.calls).toEqual([
      { color: "error", text: ICON },
      { color: "error", text: "codex resets at 00:00" },
    ]);
  });

  it("shows reset time instead of 100% for secondary when resetAt is present", () => {
    const theme = makeSpyTheme();
    const snapshot: UsageSnapshot = {
      provider: "codex",
      secondary: { usedPercent: 100, resetAt: 3661 },
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
      provider: "codex",
      primary: { usedPercent: 100 },
      fetchedAt: Date.now(),
    };
    const result = formatStatus(snapshot, theme);
    expect(result).toContain("codex 100%");
  });

  it("shows reset time for one window and percent for the other", () => {
    const theme = makeSpyTheme();
    const snapshot: UsageSnapshot = {
      provider: "codex",
      primary: { usedPercent: 100, resetAt: 7200 },
      secondary: { usedPercent: 42 },
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
      provider: "codex",
      primary: { usedPercent: 42.6 },
      secondary: { usedPercent: 71.2 },
      fetchedAt: Date.now(),
    };
    const result = formatStatus(snapshot, theme);
    expect(result).toContain("codex 43% (71%)");
  });

  it("clamps displayed percentages to 0–100", () => {
    const theme = makeSpyTheme();
    const snapshot: UsageSnapshot = {
      provider: "codex",
      primary: { usedPercent: -5 },
      secondary: { usedPercent: 145 },
      fetchedAt: Date.now(),
    };
    const result = formatStatus(snapshot, theme);
    expect(result).toContain("codex 0% (100%)");
  });

  it("uses clamped percentages for color selection", () => {
    const theme = makeSpyTheme();
    const snapshot: UsageSnapshot = {
      provider: "codex",
      primary: { usedPercent: 145 },
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
      provider: "codex",
      primary: { usedPercent: 10 },
      fetchedAt: Date.now(),
    };
    formatStatus(snapshot, theme);
    expect(theme.calls).toHaveLength(2);
  });

  it("forces muted text color when stale, keeping icon color from percent", () => {
    const theme = makeSpyTheme();
    const snapshot: UsageSnapshot = {
      provider: "opencode",
      primary: { usedPercent: 95 },
      fetchedAt: Date.now(),
      stale: true,
    };
    formatStatus(snapshot, theme);
    expect(theme.calls).toEqual([
      { color: "error", text: ICON },
      { color: "muted", text: "opencode 95%" },
    ]);
  });

  it("forces muted text color when stale even at low percent", () => {
    const theme = makeSpyTheme();
    const snapshot: UsageSnapshot = {
      provider: "opencode",
      primary: { usedPercent: 10 },
      secondary: { usedPercent: 20 },
      fetchedAt: Date.now(),
      stale: true,
    };
    formatStatus(snapshot, theme);
    expect(theme.calls).toEqual([
      { color: "success", text: ICON },
      { color: "muted", text: "opencode 10% (20%)" },
    ]);
  });
});

describe("formatResetMessage", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns error text when snapshot is null", () => {
    expect(formatResetMessage(null)).toBe("Failed to fetch usage data.");
  });

  it("returns error text when snapshot has an error", () => {
    const snapshot: UsageSnapshot = {
      provider: "opencode",
      fetchedAt: Date.now(),
      error:
        "Opencode credentials not configured. Run /usage auth to set them up.",
    };
    expect(formatResetMessage(snapshot)).toBe(
      "Opencode credentials not configured. Run /usage auth to set them up.",
    );
  });

  it("returns no data text when primary is undefined", () => {
    const snapshot: UsageSnapshot = {
      provider: "codex",
      fetchedAt: Date.now(),
    };
    expect(formatResetMessage(snapshot)).toBe("No window data available.");
  });

  it("returns reset time and remaining duration when resetAt is present", () => {
    const resetAt = 3661; // 01:01 UTC
    const now = (resetAt - 3720) * 1000; // 1h 2m before reset
    vi.spyOn(Date, "now").mockReturnValue(now);
    const snapshot: UsageSnapshot = {
      provider: "codex",
      primary: { usedPercent: 42, resetAt },
      fetchedAt: now,
    };
    expect(formatResetMessage(snapshot)).toBe(
      "codex 5h window: 42% used. Resets at 01:01 (1h 2m remaining).",
    );
  });

  it("returns reset time and remaining duration for opencode", () => {
    const resetAt = 3661;
    const now = (resetAt - 3720) * 1000;
    vi.spyOn(Date, "now").mockReturnValue(now);
    const snapshot: UsageSnapshot = {
      provider: "opencode",
      primary: { usedPercent: 42, resetAt },
      fetchedAt: now,
    };
    expect(formatResetMessage(snapshot)).toBe(
      "opencode 5h window: 42% used. Resets at 01:01 (1h 2m remaining).",
    );
  });

  it("returns usage only when resetAt is missing", () => {
    const snapshot: UsageSnapshot = {
      provider: "codex",
      primary: { usedPercent: 55 },
      fetchedAt: Date.now(),
    };
    expect(formatResetMessage(snapshot)).toBe("codex 5h window: 55% used.");
  });
});
