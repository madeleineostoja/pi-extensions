import type { Theme } from "@earendil-works/pi-coding-agent";
import type { UsageSnapshot, UsageProviderId } from "./provider.js";
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
  providerLabel?: UsageProviderId,
): string | undefined {
  if (!snapshot) {
    const label = `${providerLabel ?? "codex"} usage ?`;
    return formatColoredStatus("warning", "warning", label, theme);
  }

  const accountLabel = snapshot.accountLabel ?? snapshot.accountId;
  const label = accountLabel
    ? `${snapshot.provider} ${accountLabel}`
    : snapshot.provider;
  const parts: string[] = [];
  const percents: number[] = [];

  if (snapshot.primary !== undefined) {
    const pct = clampPercent(Math.round(snapshot.primary.usedPercent));
    if (pct === 100 && snapshot.primary.resetAt !== undefined) {
      parts.push(`resets at ${formatResetTime(snapshot.primary.resetAt)}`);
    } else {
      parts.push(`${pct}%`);
    }
    percents.push(pct);
  }

  if (snapshot.secondary !== undefined) {
    const pct = clampPercent(Math.round(snapshot.secondary.usedPercent));
    if (pct === 100 && snapshot.secondary.resetAt !== undefined) {
      parts.push(`(resets at ${formatResetTime(snapshot.secondary.resetAt)})`);
    } else {
      parts.push(`(${pct}%)`);
    }
    percents.push(pct);
  }

  if (parts.length === 0) {
    if (snapshot.error) {
      return formatColoredStatus(
        "error",
        "error",
        `${label}: ${snapshot.error}`,
        theme,
      );
    }
    return undefined;
  }

  const text = `${label} ${parts.join(" ")}`;
  const worst = Math.max(...percents);
  const color = statusColor(worst);
  const textColor = snapshot.stale
    ? "muted"
    : color === "success"
      ? "muted"
      : color;

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
    return "Failed to fetch usage data.";
  }
  if (snapshot.error) {
    return snapshot.error;
  }
  if (snapshot.primary === undefined) {
    return "No window data available.";
  }
  const pct = Math.round(clampPercent(snapshot.primary.usedPercent));
  const resetAt = snapshot.primary.resetAt;
  if (resetAt !== undefined) {
    const resetTime = formatResetTime(resetAt);
    const now = Math.floor(Date.now() / 1000);
    const remainingSeconds = Math.max(0, resetAt - now);
    const remaining = formatDuration(remainingSeconds);
    return `${snapshot.provider} 5h window: ${pct}% used. Resets at ${resetTime} (${remaining} remaining).`;
  }
  return `${snapshot.provider} 5h window: ${pct}% used.`;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function formatResetAtDurationLong(
  resetAt: number | undefined,
): string | undefined {
  if (resetAt === undefined) {
    return undefined;
  }
  const now = Math.floor(Date.now() / 1000);
  const remaining = Math.max(0, resetAt - now);
  return formatDurationLong(remaining);
}

function formatResetInSec(
  resetInSec: number | undefined,
  fetchedAt: number,
): string | undefined {
  if (resetInSec === undefined) {
    return undefined;
  }
  const elapsed = Math.floor((Date.now() - fetchedAt) / 1000);
  const remaining = Math.max(0, resetInSec - elapsed);
  return formatDurationLong(remaining);
}

function formatDurationLong(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const remaining = seconds % 86400;
  const h = Math.floor(remaining / 3600);
  const m = Math.floor((remaining % 3600) / 60);

  if (days > 0) {
    return `${days}d`;
  }
  if (h > 0) {
    return `${h}h ${m}m`;
  }
  return `${m}m`;
}

export function formatUsageSummary(
  entries: Array<{
    provider: UsageProviderId;
    snapshot: UsageSnapshot | null;
    accounts?: Array<{ accountId: string; snapshot: UsageSnapshot | null }>;
  }>,
): string {
  if (entries.length === 0) {
    return "No usage providers configured.";
  }

  const lines: string[] = [];

  for (const { provider, snapshot, accounts } of entries) {
    if (lines.length > 0) {
      lines.push("");
    }
    lines.push(capitalize(provider));

    if (accounts && accounts.length > 0) {
      for (const { accountId, snapshot: accountSnapshot } of accounts) {
        if (accountSnapshot === null) {
          lines.push(`  ${accountId}: Failed to fetch usage data.`);
          continue;
        }
        if (accountSnapshot.error) {
          lines.push(`  ${accountId}: ${accountSnapshot.error}`);
          continue;
        }

        const marker = accountSnapshot.active ? "→ " : "  ";
        const label =
          accountSnapshot.accountLabel ??
          accountSnapshot.accountId ??
          accountId;
        const display =
          accountSnapshot.accountLabel && accountSnapshot.accountId
            ? `${label} (${accountSnapshot.accountId})`
            : label;
        lines.push(`${marker}${display}`);

        if (accountSnapshot.primary !== undefined) {
          const pct = Math.round(
            clampPercent(accountSnapshot.primary.usedPercent),
          );
          const remaining = formatResetInSec(
            accountSnapshot.primary.resetInSec,
            accountSnapshot.fetchedAt,
          );
          if (remaining) {
            lines.push(`    Rolling: ${pct}% used. Resets in ${remaining}.`);
          } else {
            lines.push(`    Rolling: ${pct}% used.`);
          }
        }
        if (accountSnapshot.secondary !== undefined) {
          const pct = Math.round(
            clampPercent(accountSnapshot.secondary.usedPercent),
          );
          const remaining = formatResetInSec(
            accountSnapshot.secondary.resetInSec,
            accountSnapshot.fetchedAt,
          );
          if (remaining) {
            lines.push(`    Weekly: ${pct}% used. Resets in ${remaining}.`);
          } else {
            lines.push(`    Weekly: ${pct}% used.`);
          }
        }
        if (accountSnapshot.monthly !== undefined) {
          const pct = Math.round(
            clampPercent(accountSnapshot.monthly.usedPercent),
          );
          const remaining = formatResetInSec(
            accountSnapshot.monthly.resetInSec,
            accountSnapshot.fetchedAt,
          );
          if (remaining) {
            lines.push(`    Monthly: ${pct}% used. Resets in ${remaining}.`);
          } else {
            lines.push(`    Monthly: ${pct}% used.`);
          }
        }
      }
      continue;
    }

    if (!snapshot) {
      lines.push("Failed to fetch usage data.");
      continue;
    }

    if (snapshot.error) {
      lines.push(snapshot.error);
      continue;
    }

    if (provider === "codex") {
      if (snapshot.primary !== undefined) {
        const pct = Math.round(clampPercent(snapshot.primary.usedPercent));
        const resetAt = snapshot.primary.resetAt;
        if (resetAt !== undefined) {
          const resetTime = formatResetTime(resetAt);
          const now = Math.floor(Date.now() / 1000);
          const remainingSeconds = Math.max(0, resetAt - now);
          const remaining = formatDuration(remainingSeconds);
          lines.push(
            `5h: ${pct}% used. Resets at ${resetTime} (${remaining} remaining).`,
          );
        } else {
          lines.push(`5h: ${pct}% used.`);
        }
      }
      if (snapshot.secondary !== undefined) {
        const pct = Math.round(clampPercent(snapshot.secondary.usedPercent));
        const remaining = formatResetAtDurationLong(snapshot.secondary.resetAt);
        if (remaining) {
          lines.push(`Weekly: ${pct}% used. Resets in ${remaining}.`);
        } else {
          lines.push(`Weekly: ${pct}% used.`);
        }
      }
    } else {
      if (snapshot.primary !== undefined) {
        const pct = Math.round(clampPercent(snapshot.primary.usedPercent));
        const remaining = formatResetInSec(
          snapshot.primary.resetInSec,
          snapshot.fetchedAt,
        );
        if (remaining) {
          lines.push(`Rolling: ${pct}% used. Resets in ${remaining}.`);
        } else {
          lines.push(`Rolling: ${pct}% used.`);
        }
      }
      if (snapshot.secondary !== undefined) {
        const pct = Math.round(clampPercent(snapshot.secondary.usedPercent));
        const remaining = formatResetInSec(
          snapshot.secondary.resetInSec,
          snapshot.fetchedAt,
        );
        if (remaining) {
          lines.push(`Weekly: ${pct}% used. Resets in ${remaining}.`);
        } else {
          lines.push(`Weekly: ${pct}% used.`);
        }
      }
      if (snapshot.monthly !== undefined) {
        const pct = Math.round(clampPercent(snapshot.monthly.usedPercent));
        const remaining = formatResetInSec(
          snapshot.monthly.resetInSec,
          snapshot.fetchedAt,
        );
        if (remaining) {
          lines.push(`Monthly: ${pct}% used. Resets in ${remaining}.`);
        } else {
          lines.push(`Monthly: ${pct}% used.`);
        }
      }
    }
  }

  return lines.join("\n");
}
