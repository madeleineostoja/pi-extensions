import {
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";

export type ModalTheme = {
  fg(color: string, text: string): string;
  bold(text: string): string;
};

export type ModalStatusKind =
  | "running"
  | "completed"
  | "failed"
  | "stopped"
  | "pending"
  | "warning"
  | "info";

export type ModalStatus = {
  label: string;
  kind?: ModalStatusKind;
  icon?: string;
};

export type ModalViewOptions = {
  theme: ModalTheme;
  width: number;
  maxRows: number;
  title: string;
  status?: ModalStatus;
  subtitle?: string;
  contentLines: string[];
  scrollOffset: number;
  footerControls: string;
  footerLeft?: string;
  minContentRows?: number;
};

export type ModalViewRenderResult = {
  lines: string[];
  scrollOffset: number;
  maxScroll: number;
  visibleStart: number;
  viewportRows: number;
};

export type TerminalInputHandlerResult =
  | { consume?: boolean; data?: string }
  | undefined;

export type TerminalInputUI = {
  onTerminalInput?: (
    handler: (data: string) => TerminalInputHandlerResult,
  ) => () => void;
};

export function renderModalView(
  options: ModalViewOptions,
): ModalViewRenderResult {
  const width = Math.max(6, options.width);
  const maxRows = Math.max(1, options.maxRows);
  const innerWidth = Math.max(1, width - 4);
  const subtitle = maxRows >= 8 ? options.subtitle : undefined;
  const chromeRows = 6 + (subtitle ? 1 : 0);
  const viewportRows = Math.max(
    Math.min(options.minContentRows ?? 1, Math.max(0, maxRows - 6)),
    maxRows - chromeRows,
  );
  const maxScroll = Math.max(0, options.contentLines.length - viewportRows);
  const scrollOffset = Math.min(Math.max(0, options.scrollOffset), maxScroll);
  const visibleStart = Math.max(0, maxScroll - scrollOffset);
  const visible = options.contentLines.slice(
    visibleStart,
    visibleStart + viewportRows,
  );

  const border = (text: string) => options.theme.fg("border", text);
  const row = (content: string) =>
    `${border("│")} ${padVisible(
      truncateToWidth(content, innerWidth, "...", false),
      innerWidth,
    )} ${border("│")}`;
  const horizontal = border(`╭${"─".repeat(width - 2)}╮`);
  const bottom = border(`╰${"─".repeat(width - 2)}╯`);
  const separator = row(options.theme.fg("dim", "─".repeat(innerWidth)));

  const title = titleLine(options.theme, options.title, options.status);
  const footer = footerLine(
    options.theme,
    innerWidth,
    options.footerLeft ??
      defaultFooterLeft(
        options.contentLines.length,
        Math.max(1, viewportRows),
        visibleStart,
      ),
    options.footerControls,
  );

  if (maxRows < 6) {
    return renderCompactModalView({
      maxRows,
      horizontal,
      title: row(title),
      footer: row(footer),
      bottom,
      scrollOffset,
      maxScroll,
      visibleStart,
      viewportRows,
    });
  }

  const lines = [horizontal, row(title)];
  if (subtitle) {
    lines.push(row(options.theme.fg("muted", subtitle)));
  }
  lines.push(separator);
  for (let i = 0; i < viewportRows; i++) {
    lines.push(row(visible[i] ?? ""));
  }
  lines.push(separator, row(footer), bottom);

  return { lines, scrollOffset, maxScroll, visibleStart, viewportRows };
}

export function nextModalScrollOffset(
  data: string,
  current: number,
  maxScroll: number,
  pageRows: number,
): number | undefined {
  if (matchesKey(data, Key.up) || matchesKey(data, "k")) {
    return Math.min(maxScroll, current + 1);
  }
  if (matchesKey(data, Key.down) || matchesKey(data, "j")) {
    return Math.max(0, current - 1);
  }
  if (matchesKey(data, Key.pageUp) || matchesKey(data, "shift+up")) {
    return Math.min(maxScroll, current + pageRows);
  }
  if (matchesKey(data, Key.pageDown) || matchesKey(data, "shift+down")) {
    return Math.max(0, current - pageRows);
  }
  if (matchesKey(data, Key.home)) {
    return maxScroll;
  }
  if (matchesKey(data, Key.end)) {
    return 0;
  }
  return undefined;
}

export function isModalCloseInput(data: string): boolean {
  return matchesKey(data, Key.escape);
}

export function registerModalCloseInput(
  ui: TerminalInputUI | undefined,
  close: () => void,
): () => void {
  const unsubscribe = ui?.onTerminalInput?.((data) => {
    if (!isModalCloseInput(data)) {
      return undefined;
    }
    close();
    return { consume: true };
  });
  return () => unsubscribe?.();
}

export function modalStatusIcon(status: ModalStatus | undefined): string {
  if (status?.icon) {
    return status.icon;
  }
  switch (status?.kind) {
    case "running":
    case "pending":
      return "●";
    case "completed":
      return "✓";
    case "failed":
      return "✗";
    case "stopped":
      return "■";
    case "warning":
      return "!";
    default:
      return "○";
  }
}

export function modalStatusColor(
  status: ModalStatus | undefined,
): "accent" | "success" | "error" | "warning" | "muted" {
  switch (status?.kind) {
    case "running":
    case "pending":
      return "accent";
    case "completed":
      return "success";
    case "failed":
      return "error";
    case "stopped":
    case "warning":
      return "warning";
    default:
      return "muted";
  }
}

function renderCompactModalView(options: {
  maxRows: number;
  horizontal: string;
  title: string;
  footer: string;
  bottom: string;
  scrollOffset: number;
  maxScroll: number;
  visibleStart: number;
  viewportRows: number;
}): ModalViewRenderResult {
  const lines = [
    options.horizontal,
    options.title,
    options.footer,
    options.bottom,
  ].slice(0, options.maxRows);
  return {
    lines,
    scrollOffset: options.scrollOffset,
    maxScroll: options.maxScroll,
    visibleStart: options.visibleStart,
    viewportRows: options.viewportRows,
  };
}

function titleLine(
  theme: ModalTheme,
  title: string,
  status: ModalStatus | undefined,
): string {
  if (!status) {
    return theme.bold(title);
  }
  const icon = theme.fg(modalStatusColor(status), modalStatusIcon(status));
  return `${icon} ${theme.bold(title)} ${theme.fg("muted", status.label)}`;
}

function footerLine(
  theme: ModalTheme,
  width: number,
  left: string,
  right: string,
): string {
  const visibleLeft = visibleWidth(left);
  const visibleRight = visibleWidth(right);
  if (visibleLeft + visibleRight + 1 >= width) {
    return theme.fg(
      "dim",
      truncateToWidth(
        `${stripAnsiFallback(left)} · ${stripAnsiFallback(right)}`,
        width,
        "...",
        false,
      ),
    );
  }
  return `${theme.fg("dim", left)}${" ".repeat(
    width - visibleLeft - visibleRight,
  )}${theme.fg("dim", right)}`;
}

function defaultFooterLeft(
  totalLines: number,
  viewportRows: number,
  visibleStart: number,
): string {
  const pct =
    totalLines <= viewportRows
      ? "100%"
      : `${Math.round(((visibleStart + viewportRows) / totalLines) * 100)}%`;
  return `${totalLines} lines · ${pct}`;
}

function padVisible(text: string, width: number): string {
  return `${text}${" ".repeat(Math.max(0, width - visibleWidth(text)))}`;
}

function stripAnsiFallback(text: string): string {
  const escape = String.fromCharCode(27);
  return text.replace(new RegExp(`${escape}\\[[0-9;]*m`, "g"), "");
}
