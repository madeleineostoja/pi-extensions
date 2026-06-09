import { basename } from "node:path";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";

export type ThinkingLevel =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh";
export type FooterModel =
  | { name?: string; id?: string; provider?: string }
  | undefined;
export type ContextUsageInfo =
  | { percent: number | null; contextWindow: number }
  | undefined;

export function formatCompactTokens(n: number): string {
  if (n < 1000) {
    return n.toString();
  }
  if (n < 10000) {
    return `${(n / 1000).toFixed(1)}k`;
  }
  if (n < 1000000) {
    return `${Math.round(n / 1000)}k`;
  }
  if (n < 10000000) {
    return `${(n / 1000000).toFixed(1)}M`;
  }
  return `${Math.round(n / 1000000)}M`;
}

export function formatCost(cost: number): string {
  const cents = Math.round(cost * 100);
  const dollars = Math.floor(cents / 100);
  const rem = cents % 100;
  return `$${dollars}.${rem.toString().padStart(2, "0")}`;
}

export function formatModelName(
  model: FooterModel,
  includeProvider = false,
): string {
  const name = model?.name || model?.id;
  if (!name) {
    return "no model";
  }
  if (includeProvider && model?.provider) {
    return `(${model.provider}) ${name}`;
  }
  return name;
}

export function formatThinking(level: ThinkingLevel, theme: Theme): string {
  const token =
    `thinking${level.charAt(0).toUpperCase() + level.slice(1)}` as Parameters<
      Theme["fg"]
    >[0];
  return theme.fg(token, `(${level})`);
}

export function getContextColor(
  percent: number | null,
): Parameters<Theme["fg"]>[0] {
  if (percent === null) {
    return "dim";
  }
  if (percent >= 90) {
    return "error";
  }
  if (percent >= 70) {
    return "warning";
  }
  return "muted";
}

export function formatContextPercent(
  percent: number | null,
  theme: Theme,
): string {
  const num = percent === null ? "?" : `${Math.round(percent)}`;
  return theme.fg(getContextColor(percent), `${num}%`);
}

export function buildLeftSegment(
  cwd: string,
  branch: string | null,
  theme: Theme,
): string {
  const name = basename(cwd) || cwd;
  const base = theme.bold(theme.fg("accent", name));
  if (!branch) {
    return base;
  }
  const gitBranch = theme.bold(theme.fg("accent", ` ${branch}`));
  return `${base} ${theme.fg("dim", "on")} ${gitBranch}`;
}

export function formatCacheHitRate(rate: number): string {
  return `󰃨 ${rate.toFixed(1)}%`;
}

export function buildRightSegment(
  model: FooterModel,
  thinkingLevel: ThinkingLevel,
  cost: number,
  contextUsage: ContextUsageInfo,
  hideCost: boolean,
  theme: Theme,
  includeWindow: boolean,
  includeProvider = false,
  cacheHitRate?: number,
): string {
  const parts: string[] = [];
  parts.push(
    `${theme.fg("muted", formatModelName(model, includeProvider))} ${formatThinking(thinkingLevel, theme)}`,
  );

  if (!hideCost) {
    parts.push(theme.fg("muted", formatCost(cost)));
  }

  if (cacheHitRate !== undefined) {
    parts.push(theme.fg("muted", formatCacheHitRate(cacheHitRate)));
  }

  const percent = contextUsage?.percent ?? null;
  const contextColor = getContextColor(percent);
  const ctxPercent = formatContextPercent(percent, theme);
  const ctxLabel = theme.fg(contextColor, "󰔚");

  let ctxPart: string;
  if (includeWindow && contextUsage) {
    const windowText = theme.fg(
      "dim",
      `(${formatCompactTokens(contextUsage.contextWindow)})`,
    );
    ctxPart = `${ctxLabel}  ${ctxPercent} ${windowText}`;
  } else {
    ctxPart = `${ctxLabel}  ${ctxPercent}`;
  }
  parts.push(ctxPart);

  return parts.join(theme.fg("dim", " · "));
}

/* eslint-disable no-control-regex */
const SGR_ANSI_PATTERN = new RegExp("\\x1b\\[[0-9;]*m", "g");
const OSC_ANSI_PATTERN = new RegExp(
  "\\x1b\\][^\\x07]*(?:\\x07|\\x1b\\\\)",
  "g",
);
const CSI_ANSI_PATTERN = new RegExp("\\x1b\\[[0-?]*[ -/]*[@-~]", "g");
const UNSUPPORTED_ESC_PATTERN = new RegExp("\\x1b.", "g");
const CONTROL_PATTERN = new RegExp(
  "[\\x00-\\x08\\x0b\\x0c\\x0e-\\x1f\\x7f-\\x9f]",
  "g",
);
/* eslint-enable no-control-regex */

export function sanitizeStatusText(text: string): string {
  const sgrCodes: string[] = [];
  return text
    .replace(SGR_ANSI_PATTERN, (code) => {
      const index = sgrCodes.push(code) - 1;
      return `\u{e000}${index}\u{e001}`;
    })
    .replace(/[\r\n\t]/g, " ")
    .replace(OSC_ANSI_PATTERN, "")
    .replace(CSI_ANSI_PATTERN, "")
    .replace(UNSUPPORTED_ESC_PATTERN, "")
    .replace(CONTROL_PATTERN, "")
    .replace(
      /\u{e000}(\d+)\u{e001}/gu,
      (_match, index: string) => sgrCodes[Number(index)] ?? "",
    )
    .replace(/ +/g, " ")
    .trim();
}

export function hasAnsi(text: string): boolean {
  return text.includes("\x1b");
}

export function buildStatusLine(
  statuses: ReadonlyMap<string, string>,
  theme: Theme,
): string {
  const sorted = Array.from(statuses.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, text]) => {
      const sanitized = sanitizeStatusText(text);
      return hasAnsi(sanitized) ? sanitized : theme.fg("muted", sanitized);
    });
  return sorted.join("  ");
}

export function buildFooterLines(
  width: number,
  left: string,
  rightWithWindow: string,
  rightWithoutWindow: string,
  statuses: ReadonlyMap<string, string>,
  theme: Theme,
): string[] {
  const lines: string[] = [];
  const leftWidth = visibleWidth(left);
  const minGap = 2;

  const tryFit = (right: string): boolean => {
    const rightWidth = visibleWidth(right);
    return leftWidth + minGap + rightWidth <= width;
  };

  let chosenRight: string;
  if (tryFit(rightWithWindow)) {
    chosenRight = rightWithWindow;
  } else if (tryFit(rightWithoutWindow)) {
    chosenRight = rightWithoutWindow;
  } else {
    const availableForRight = Math.max(0, width - leftWidth - minGap);
    if (availableForRight > 0) {
      chosenRight = truncateToWidth(rightWithoutWindow, availableForRight, "");
    } else {
      lines.push(truncateToWidth(left, width));
      if (statuses.size > 0) {
        lines.push(truncateToWidth(buildStatusLine(statuses, theme), width));
      }
      return lines;
    }
  }

  const rightWidth = visibleWidth(chosenRight);
  const gap = " ".repeat(Math.max(0, width - leftWidth - rightWidth));
  lines.push(left + gap + chosenRight);

  if (statuses.size > 0) {
    const statusLine = buildStatusLine(statuses, theme);
    lines.push(truncateToWidth(statusLine, width));
  }

  return lines;
}
