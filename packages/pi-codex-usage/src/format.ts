import type { Theme } from "@earendil-works/pi-coding-agent";
import type { UsageSnapshot } from "./usage.js";
import { ICON } from "./constants.js";

function clampPercent(percent: number): number {
  return Math.min(100, Math.max(0, percent));
}

function colorize(text: string, worstPercent: number, theme: Theme): string {
  const clampedWorst = clampPercent(worstPercent);
  if (clampedWorst >= 95) return theme.fg("error", text);
  if (clampedWorst >= 80) return theme.fg("warning", text);
  return theme.fg("success", text);
}

export function formatStatus(
  snapshot: UsageSnapshot | null,
  theme: Theme,
): string | undefined {
  if (!snapshot) {
    return theme.fg("warning", `${ICON} usage ?`);
  }

  const parts: string[] = [];
  const percents: number[] = [];

  if (snapshot.fiveHour !== undefined) {
    const pct = clampPercent(Math.round(snapshot.fiveHour.usedPercent));
    parts.push(`${pct}%`);
    percents.push(pct);
  }

  if (snapshot.weekly !== undefined) {
    const pct = clampPercent(Math.round(snapshot.weekly.usedPercent));
    parts.push(`(${pct}%)`);
    percents.push(pct);
  }

  if (parts.length === 0) return undefined;

  const text = `${ICON} ${parts.join(" ")}`;
  const worst = Math.max(...percents);

  return colorize(text, worst, theme);
}
