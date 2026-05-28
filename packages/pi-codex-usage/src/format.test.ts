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
    expect(result).toContain("usage ?");
    expect(theme.calls).toContainEqual(
      expect.objectContaining({ color: "warning" }),
    );
  });

  it("formats compact status with both windows", () => {
    const theme = makeSpyTheme();
    const snapshot: UsageSnapshot = {
      fiveHour: { usedPercent: 42 },
      weekly: { usedPercent: 71 },
      fetchedAt: Date.now(),
    };
    const result = formatStatus(snapshot, theme);
    expect(result).toContain(`${ICON} 42% (71%)`);
  });

  it("omits fiveHour section when fiveHour is undefined", () => {
    const theme = makeSpyTheme();
    const snapshot: UsageSnapshot = {
      weekly: { usedPercent: 55 },
      fetchedAt: Date.now(),
    };
    const result = formatStatus(snapshot, theme);
    expect(result).toContain(`${ICON} (55%)`);
  });

  it("omits weekly section when weekly is undefined", () => {
    const theme = makeSpyTheme();
    const snapshot: UsageSnapshot = {
      fiveHour: { usedPercent: 10 },
      fetchedAt: Date.now(),
    };
    const result = formatStatus(snapshot, theme);
    expect(result).toContain(`${ICON} 10%`);
  });

  it("hides status when both windows are undefined", () => {
    const theme = makeSpyTheme();
    const snapshot: UsageSnapshot = { fetchedAt: Date.now() };
    const result = formatStatus(snapshot, theme);
    expect(result).toBeUndefined();
    expect(theme.calls).toHaveLength(0);
  });

  it("uses success color when worst percent is below 80", () => {
    const theme = makeSpyTheme();
    const snapshot: UsageSnapshot = {
      fiveHour: { usedPercent: 50 },
      weekly: { usedPercent: 30 },
      fetchedAt: Date.now(),
    };
    formatStatus(snapshot, theme);
    expect(theme.calls[0]!.color).toBe("success");
  });

  it("uses warning color when worst percent is 80–94", () => {
    const theme = makeSpyTheme();
    const snapshot: UsageSnapshot = {
      fiveHour: { usedPercent: 80 },
      weekly: { usedPercent: 20 },
      fetchedAt: Date.now(),
    };
    formatStatus(snapshot, theme);
    expect(theme.calls[0]!.color).toBe("warning");
  });

  it("uses warning color at 94%", () => {
    const theme = makeSpyTheme();
    const snapshot: UsageSnapshot = {
      fiveHour: { usedPercent: 94 },
      fetchedAt: Date.now(),
    };
    formatStatus(snapshot, theme);
    expect(theme.calls[0]!.color).toBe("warning");
  });

  it("uses error color when worst percent is 95 or above", () => {
    const theme = makeSpyTheme();
    const snapshot: UsageSnapshot = {
      fiveHour: { usedPercent: 95 },
      weekly: { usedPercent: 40 },
      fetchedAt: Date.now(),
    };
    formatStatus(snapshot, theme);
    expect(theme.calls[0]!.color).toBe("error");
  });

  it("uses error color at 100%", () => {
    const theme = makeSpyTheme();
    const snapshot: UsageSnapshot = {
      weekly: { usedPercent: 100 },
      fetchedAt: Date.now(),
    };
    formatStatus(snapshot, theme);
    expect(theme.calls[0]!.color).toBe("error");
  });

  it("rounds percentages to whole numbers", () => {
    const theme = makeSpyTheme();
    const snapshot: UsageSnapshot = {
      fiveHour: { usedPercent: 42.6 },
      weekly: { usedPercent: 71.2 },
      fetchedAt: Date.now(),
    };
    const result = formatStatus(snapshot, theme);
    expect(result).toContain("43% (71%)");
  });

  it("clamps displayed percentages to 0–100", () => {
    const theme = makeSpyTheme();
    const snapshot: UsageSnapshot = {
      fiveHour: { usedPercent: -5 },
      weekly: { usedPercent: 145 },
      fetchedAt: Date.now(),
    };
    const result = formatStatus(snapshot, theme);
    expect(result).toContain("0% (100%)");
  });

  it("uses clamped percentages for color selection", () => {
    const theme = makeSpyTheme();
    const snapshot: UsageSnapshot = {
      fiveHour: { usedPercent: 145 },
      fetchedAt: Date.now(),
    };
    formatStatus(snapshot, theme);
    expect(theme.calls[0]!.color).toBe("error");
  });

  it("wraps the entire text in theme.fg", () => {
    const theme = makeSpyTheme();
    const snapshot: UsageSnapshot = {
      fiveHour: { usedPercent: 10 },
      fetchedAt: Date.now(),
    };
    formatStatus(snapshot, theme);
    expect(theme.calls).toHaveLength(1);
  });
});
