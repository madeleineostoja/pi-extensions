import type { Theme } from "@earendil-works/pi-coding-agent";
import type { UsageSnapshot } from "./usage.js";
import { ICON } from "./constants.js";

function clampPercent(percent: number): number {
  return Math.min(100, Math.max(0, percent));
}

type StatusColor = "success" | "warning" | "error";

type StatusTextColor = StatusColor | "muted";

function statusColor(worstPercent: number): StatusColor {
  const clampedWorst = clampPercent(worstPercent);
  if (clampedWorst >= 95) {
    return "error";
  }
  if (clampedWorst >= 80) {
    return "warning";
  }
  return "success";
}

function formatColoredStatus(
  iconColor: StatusColor,
  textColor: StatusTextColor,
  text: string,
  theme: Theme,
): string {
  return `${theme.fg(iconColor, ICON)} ${theme.fg(textColor, text)}`;
}

export function formatStatus(
  snapshot: UsageSnapshot | null,
  theme: Theme,
): string | undefined {
  if (!snapshot) {
    return formatColoredStatus("warning", "warning", "codex usage ?", theme);
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

  if (parts.length === 0) {
    return undefined;
  }

  const text = `codex ${parts.join(" ")}`;
  const worst = Math.max(...percents);
  const color = statusColor(worst);
  const textColor = color === "success" ? "muted" : color;

  return formatColoredStatus(color, textColor, text, theme);
}
