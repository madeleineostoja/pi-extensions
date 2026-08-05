import { basename } from "node:path";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { formatCompactTokens, formatUsdCost } from "#lib/ui/metrics";
import { parsePipkinStatusKey } from "./status.js";

export type ThinkingLevel =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";
export type FooterModel =
  | { name?: string; id?: string; provider?: string }
  | undefined;
export type ContextUsageInfo =
  | { percent: number | null; contextWindow: number }
  | undefined;

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

export type FooterLeftSegment = Readonly<{
  repository: string;
  branch?: string;
}>;

export function buildFooterLeftSegment(
  cwd: string,
  branch: string | null,
  theme: Theme,
): FooterLeftSegment {
  const name = basename(cwd) || cwd;
  return {
    repository: theme.bold(theme.fg("accent", name)),
    ...(branch
      ? {
          branch: `${theme.fg("dim", "on")} ${theme.bold(
            theme.fg("accent", ` ${branch}`),
          )}`,
        }
      : {}),
  };
}

export function buildLeftSegment(
  cwd: string,
  branch: string | null,
  theme: Theme,
): string {
  const left = buildFooterLeftSegment(cwd, branch, theme);
  return left.branch ? `${left.repository} ${left.branch}` : left.repository;
}

export function formatCacheHitRate(rate: number): string {
  return `󰃨 ${Math.round(rate)}%`;
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
    parts.push(theme.fg("muted", formatUsdCost(cost)));
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

const PRIVATE_USE_GLYPH_PATTERN =
  /[\u{e000}-\u{f8ff}\u{f0000}-\u{ffffd}\u{100000}-\u{10fffd}]/u;
const GENERIC_STATUS_ICON = "";

export function hasPrivateUseGlyph(text: string): boolean {
  return PRIVATE_USE_GLYPH_PATTERN.test(text);
}

export function buildStatusLine(
  statuses: ReadonlyMap<string, string>,
  theme: Theme,
): string {
  const sorted = Array.from(statuses.entries())
    .sort(([a], [b]) => {
      const aStatus = parsePipkinStatusKey(a);
      const bStatus = parsePipkinStatusKey(b);
      if (aStatus && bStatus) {
        return aStatus.priority === bStatus.priority
          ? a.localeCompare(b)
          : aStatus.priority - bStatus.priority;
      }
      if (aStatus) {
        return -1;
      }
      if (bStatus) {
        return 1;
      }
      return a.localeCompare(b);
    })
    .map(([, text]) => {
      const sanitized = sanitizeStatusText(text);
      const styled = hasAnsi(sanitized)
        ? sanitized
        : theme.fg("muted", sanitized);
      if (!sanitized || hasPrivateUseGlyph(sanitized)) {
        return styled;
      }
      return `${theme.fg("muted", GENERIC_STATUS_ICON)} ${styled}`;
    });
  return sorted.join("  ");
}

const MIN_BRANCH_WIDTH = 12;

function renderFooterLeft(
  left: string | FooterLeftSegment,
  branchWidth?: number,
): string {
  if (typeof left === "string") {
    return left;
  }
  if (!left.branch || branchWidth === undefined) {
    return left.branch ? `${left.repository} ${left.branch}` : left.repository;
  }
  return `${left.repository} ${truncateToWidth(left.branch, branchWidth)}`;
}

export function buildFooterLines(
  width: number,
  left: string | FooterLeftSegment,
  rightWithWindow: string,
  rightWithoutWindow: string,
  statuses: ReadonlyMap<string, string>,
  theme: Theme,
): string[] {
  const lines: string[] = [];
  const fullLeft = renderFooterLeft(left);
  const minGap = 2;

  const fitBranch = (right: string): string | undefined => {
    if (typeof left === "string" || !left.branch) {
      return undefined;
    }
    const available =
      width - visibleWidth(left.repository) - 1 - minGap - visibleWidth(right);
    if (available < MIN_BRANCH_WIDTH) {
      return undefined;
    }
    return renderFooterLeft(left, available);
  };

  const chooseRight = (): { left: string; right: string } | undefined => {
    if (
      visibleWidth(fullLeft) + minGap + visibleWidth(rightWithWindow) <=
      width
    ) {
      return { left: fullLeft, right: rightWithWindow };
    }
    const branchWithWindow = fitBranch(rightWithWindow);
    if (branchWithWindow) {
      return { left: branchWithWindow, right: rightWithWindow };
    }
    if (
      visibleWidth(fullLeft) + minGap + visibleWidth(rightWithoutWindow) <=
      width
    ) {
      return { left: fullLeft, right: rightWithoutWindow };
    }
    const branchWithoutWindow = fitBranch(rightWithoutWindow);
    return branchWithoutWindow
      ? { left: branchWithoutWindow, right: rightWithoutWindow }
      : undefined;
  };

  const chosen = chooseRight();
  if (chosen) {
    const gap = " ".repeat(
      Math.max(
        0,
        width - visibleWidth(chosen.left) - visibleWidth(chosen.right),
      ),
    );
    lines.push(chosen.left + gap + chosen.right);
  } else {
    const leftWidth = visibleWidth(fullLeft);
    const availableForRight = Math.max(0, width - leftWidth - minGap);
    if (availableForRight > 0) {
      lines.push(
        fullLeft +
          " ".repeat(Math.max(0, width - leftWidth - availableForRight)) +
          truncateToWidth(rightWithoutWindow, availableForRight, ""),
      );
    } else {
      lines.push(truncateToWidth(fullLeft, width));
    }
  }

  if (statuses.size > 0) {
    const statusLine = buildStatusLine(statuses, theme);
    lines.push(truncateToWidth(statusLine, width));
  }

  return lines;
}
