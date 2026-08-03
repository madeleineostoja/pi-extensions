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
const ACTIVITY_BODY_LINE_LIMIT = 8;

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
  const primaryRecords = recordsForBudget(records).slice(
    0,
    ACTIVITY_BODY_LINE_LIMIT,
  );
  const rendered = new Set<string>();
  let detailLinesRemaining = ACTIVITY_BODY_LINE_LIMIT - primaryRecords.length;
  for (const record of primaryRecords) {
    const depth = depthFor(record, records);
    lines.push(recordLine(record, depth, contentWidth, theme, now));
    rendered.add(record.key);
    if (record.detail && detailLinesRemaining > 0) {
      const prefix = `${"  ".repeat(Math.min(depth + 1, 3))}  `;
      lines.push(
        truncateToWidth(
          `${prefix}${theme.fg("muted", record.detail)}`,
          contentWidth,
          "…",
          false,
        ),
      );
      detailLinesRemaining -= 1;
    }
  }
  const overflow = records.length - rendered.size;
  if (overflow > 0) {
    lines.push(
      truncateToWidth(
        theme.fg("muted", `… ${overflow} more`),
        contentWidth,
        "…",
        false,
      ),
    );
  }
  return lines.map((line) => truncateToWidth(line, contentWidth, "…", false));
}

function recordsForBudget(
  records: readonly StoredActivityRecord[],
): StoredActivityRecord[] {
  const byKey = new Map(records.map((record) => [record.key, record]));
  const ordered: StoredActivityRecord[] = [];
  const included = new Set<string>();
  const append = (record: StoredActivityRecord) => {
    if (!included.has(record.key)) {
      included.add(record.key);
      ordered.push(record);
    }
  };

  for (const record of records) {
    if (
      (record.state !== "attention" && record.state !== "failed") ||
      !record.parent ||
      !byKey.has(`${record.parent.source}:${record.parent.id}`)
    ) {
      continue;
    }
    const path = [record];
    const visited = new Set<string>([record.key]);
    let parent = byKey.get(`${record.parent.source}:${record.parent.id}`);
    while (parent && !visited.has(parent.key)) {
      visited.add(parent.key);
      path.push(parent);
      parent = parent.parent
        ? byKey.get(`${parent.parent.source}:${parent.parent.id}`)
        : undefined;
    }
    for (const candidate of path.reverse().slice(-ACTIVITY_BODY_LINE_LIMIT)) {
      append(candidate);
    }
  }
  for (const record of records) {
    append(record);
  }
  return ordered;
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
