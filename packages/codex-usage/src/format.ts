import type { Theme } from "@earendil-works/pi-coding-agent";
import type { UsageSnapshot } from "./usage.js";
import { ICON } from "./constants.js";

function colorize(text: string, worstPercent: number, theme: Theme): string {
  if (worstPercent >= 95) return theme.fg("error", text);
  if (worstPercent >= 80) return theme.fg("warning", text);
  return theme.fg("muted", text);
}

export function formatStatus(
  snapshot: UsageSnapshot | null,
  theme: Theme,
): string {
  if (!snapshot) {
    return theme.fg("warning", `${ICON} usage ?`);
  }

  const parts: string[] = [];
  const percents: number[] = [];

  if (snapshot.fiveHour !== undefined) {
    const pct = Math.round(snapshot.fiveHour.usedPercent);
    parts.push(`5h ${pct}%`);
    percents.push(pct);
  }

  if (snapshot.weekly !== undefined) {
    const pct = Math.round(snapshot.weekly.usedPercent);
    parts.push(`W ${pct}%`);
    percents.push(pct);
  }

  const suffix = parts.length > 0 ? ` ${parts.join(" ")}` : "";
  const text = `${ICON}${suffix}`;
  const worst = percents.length > 0 ? Math.max(...percents) : 0;

  return colorize(text, worst, theme);
}
