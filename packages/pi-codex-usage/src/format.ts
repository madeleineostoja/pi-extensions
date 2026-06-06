import type { Theme } from "@earendil-works/pi-coding-agent";
import type { UsageSnapshot } from "./usage.js";
import { ICON } from "./constants.js";

function clampPercent(percent: number): number {
  return Math.min(100, Math.max(0, percent));
}

function formatResetTime(resetAt: number): string {
  const date = new Date(resetAt * 1000);
  const h = date.getHours().toString().padStart(2, "0");
  const m = date.getMinutes().toString().padStart(2, "0");
  return `${h}:${m}`;
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
    if (pct === 100 && snapshot.fiveHour.resetAt !== undefined) {
      parts.push(`resets at ${formatResetTime(snapshot.fiveHour.resetAt)}`);
    } else {
      parts.push(`${pct}%`);
    }
    percents.push(pct);
  }

  if (snapshot.weekly !== undefined) {
    const pct = clampPercent(Math.round(snapshot.weekly.usedPercent));
    if (pct === 100 && snapshot.weekly.resetAt !== undefined) {
      parts.push(`(resets at ${formatResetTime(snapshot.weekly.resetAt)})`);
    } else {
      parts.push(`(${pct}%)`);
    }
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

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) {
    return `${h}h ${m}m`;
  }
  return `${m}m`;
}

export function formatResetMessage(snapshot: UsageSnapshot | null): string {
  if (!snapshot) {
    return "Failed to fetch Codex usage data.";
  }
  if (snapshot.fiveHour === undefined) {
    return "No 5h window data available.";
  }
  const pct = Math.round(clampPercent(snapshot.fiveHour.usedPercent));
  const resetAt = snapshot.fiveHour.resetAt;
  if (resetAt !== undefined) {
    const resetTime = formatResetTime(resetAt);
    const now = Math.floor(Date.now() / 1000);
    const remainingSeconds = Math.max(0, resetAt - now);
    const remaining = formatDuration(remainingSeconds);
    return `Codex 5h window: ${pct}% used. Resets at ${resetTime} (${remaining} remaining).`;
  }
  return `Codex 5h window: ${pct}% used.`;
}
