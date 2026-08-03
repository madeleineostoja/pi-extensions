import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
  Box,
  type Component,
  type TUI,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { formatDuration, formatProgress } from "#lib/ui/metrics";
import type { ActivityState } from "./activity.js";
import { ActivityStore, type StoredActivityRecord } from "./activity-store.js";

const WIDGET_KEY = "pipkin.ui.activity";

class ActivityWidget implements Component {
  #disposed = false;
  #unsubscribe: () => void;

  constructor(
    private readonly store: ActivityStore,
    private readonly tui: TUI,
    private readonly theme: Theme,
    onDispose: () => void,
  ) {
    this.#unsubscribe = store.subscribe(() => tui.requestRender());
    this.#onDispose = onDispose;
  }
  #onDispose: () => void;

  dispose(): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    this.#unsubscribe();
    this.#onDispose();
  }

  invalidate(): void {
    if (!this.#disposed) {
      this.tui.requestRender();
    }
  }

  render(width: number): string[] {
    const records = this.store.records;
    if (records.length === 0) {
      return [];
    }
    if (width < 3) {
      return renderActivity(records, Math.max(1, width), this.theme).map(
        (line) => this.theme.bg("customMessageBg", line),
      );
    }
    const lines = renderActivity(records, width - 2, this.theme);
    const box = new Box(1, 0, (text) => this.theme.bg("customMessageBg", text));
    box.addChild({ render: () => lines, invalidate() {} });
    return box.render(width);
  }
}

export function installActivityWidget(
  ctx: Pick<ExtensionContext, "mode" | "hasUI" | "ui">,
  store: ActivityStore,
): () => void {
  if (ctx.mode !== "tui" || !ctx.hasUI) {
    return () => {};
  }
  const components = new Set<ActivityWidget>();
  ctx.ui.setWidget(
    WIDGET_KEY,
    (tui, theme) => {
      const widget = new ActivityWidget(store, tui, theme, () =>
        components.delete(widget),
      );
      components.add(widget);
      return widget;
    },
    { placement: "aboveEditor" },
  );
  return () => {
    for (const component of components) {
      component.dispose();
    }
    components.clear();
    ctx.ui.setWidget(WIDGET_KEY, undefined);
  };
}

export function renderActivity(
  records: readonly StoredActivityRecord[],
  width: number,
  theme: Theme,
  now = Date.now(),
): string[] {
  const contentWidth = Math.max(1, width);
  const active = records.filter(
    (record) =>
      !["completed", "stopped"].includes(record.state) &&
      record.state !== "failed",
  ).length;
  const failed = records.filter((record) => record.state === "failed").length;
  const heading = [
    "[•_•] Activity",
    active ? `${active} active` : "",
    failed ? `${failed} failed` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  const lines = [
    theme.bold(truncateToWidth(heading, contentWidth, "…", false)),
  ];
  let bodyLines = 0;
  let next = 0;
  while (next < records.length && bodyLines < 8) {
    const record = records[next];
    const depth = depthFor(record, records);
    lines.push(recordLine(record, depth, contentWidth, theme, now));
    bodyLines += 1;
    next += 1;
    if (record.detail && bodyLines < 8) {
      const prefix = `${"  ".repeat(Math.min(depth + 1, 3))}  `;
      lines.push(
        truncateToWidth(
          `${prefix}${theme.fg("muted", record.detail)}`,
          contentWidth,
          "…",
          false,
        ),
      );
      bodyLines += 1;
    }
  }
  if (next < records.length) {
    lines.push(
      truncateToWidth(
        theme.fg("muted", `… ${records.length - next} more`),
        contentWidth,
        "…",
        false,
      ),
    );
  }
  return lines.map((line) => truncateToWidth(line, contentWidth, "…", false));
}

function depthFor(
  record: StoredActivityRecord,
  records: readonly StoredActivityRecord[],
): number {
  const keys = new Set(records.map((item) => item.key));
  let depth = 0;
  let parentKey = record.parent
    ? `${record.parent.source}:${record.parent.id}`
    : undefined;
  while (parentKey && keys.has(parentKey) && depth < 3) {
    depth += 1;
    const parent = records.find((item) => item.key === parentKey)?.parent;
    parentKey = parent ? `${parent.source}:${parent.id}` : undefined;
  }
  return depth;
}

function recordLine(
  record: StoredActivityRecord,
  depth: number,
  width: number,
  theme: Theme,
  now: number,
): string {
  const indentation = depth ? `${"  ".repeat(depth - 1)}└ ` : "";
  const glyph = theme.fg(glyphTone(record.state), glyphFor(record.state));
  const prefix = `${indentation}${glyph} `;
  const right = record.progress
    ? formatProgress(record.progress.completed, record.progress.total)
    : record.startedAt === undefined
      ? ""
      : formatDuration(now - record.startedAt);
  const primaryWidth = Math.max(0, width - visibleWidth(prefix));
  const primary = primaryFields(record.label, record.title, primaryWidth);
  if (
    !right ||
    visibleWidth(prefix) + visibleWidth(primary) + visibleWidth(right) + 1 >
      width
  ) {
    return truncateToWidth(`${prefix}${primary}`, width, "…", false);
  }
  return `${prefix}${primary} ${theme.fg("muted", right)}`;
}

function primaryFields(label: string, title: string, width: number): string {
  if (width <= 0) {
    return "";
  }
  if (width < 5) {
    return truncateToWidth(title, width, "…", false);
  }
  const separator = " · ";
  const available = width - visibleWidth(separator);
  const labelWidth = Math.max(1, Math.floor(available / 2));
  const titleWidth = Math.max(1, available - labelWidth);
  return `${truncateToWidth(label, labelWidth, "…", false)}${separator}${truncateToWidth(title, titleWidth, "…", false)}`;
}

function glyphFor(state: ActivityState): string {
  return {
    queued: "○",
    running: "●",
    waiting: "◌",
    attention: "!",
    completed: "✓",
    failed: "×",
    stopped: "■",
  }[state];
}

function glyphTone(
  state: ActivityState,
): "muted" | "accent" | "warning" | "success" | "error" {
  if (state === "failed") {
    return "error";
  }
  if (state === "attention") {
    return "warning";
  }
  if (state === "completed") {
    return "success";
  }
  if (state === "queued" || state === "stopped") {
    return "muted";
  }
  return "accent";
}
