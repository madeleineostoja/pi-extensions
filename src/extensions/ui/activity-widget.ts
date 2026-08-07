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
const FULLSCREEN_ACTIVITY_BODY_LINE_LIMIT = 3;

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
      return renderActivity(
        records,
        Math.max(1, width),
        this.theme,
        Date.now(),
        this.lineLimit,
      ).map((line) =>
        activityBackground(
          truncateToWidth(line, Math.max(1, width), "", true),
          this.theme,
        ),
      );
    }
    const box = new Box(1, 1, (text) => activityBackground(text, this.theme));
    box.addChild({
      render: (contentWidth) =>
        renderActivity(
          records,
          Math.max(1, contentWidth),
          this.theme,
          Date.now(),
          this.lineLimit,
        ),
      invalidate() {},
    });
    return box.render(width);
  }

  get lineLimit(): number {
    return this.tui.mode === "fullscreen"
      ? FULLSCREEN_ACTIVITY_BODY_LINE_LIMIT
      : ACTIVITY_BODY_LINE_LIMIT;
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
  let registered = false;
  let disposed = false;
  const disposeComponents = () => {
    while (components.size > 0) {
      components.values().next().value?.dispose();
    }
    components.clear();
  };
  const reconcile = () => {
    if (disposed) {
      return;
    }
    const shouldRegister = store.records.length > 0;
    if (shouldRegister === registered) {
      return;
    }
    registered = shouldRegister;
    if (!shouldRegister) {
      disposeComponents();
      ctx.ui.setWidget(WIDGET_KEY, undefined);
      return;
    }
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
  };
  const unsubscribe = store.subscribe(reconcile);
  reconcile();
  return () => {
    if (disposed) {
      return;
    }
    disposed = true;
    unsubscribe();
    disposeComponents();
    if (registered) {
      registered = false;
      ctx.ui.setWidget(WIDGET_KEY, undefined);
    }
  };
}

function activityBackground(text: string, theme: Theme): string {
  const backgroundReset = "\x1b[49m";
  const emptyBackground = theme.bg("toolPendingBg", "");
  const backgroundStart = emptyBackground.endsWith(backgroundReset)
    ? emptyBackground.slice(0, -backgroundReset.length)
    : emptyBackground;
  const reset = "\x1b[0m";
  return theme.bg(
    "toolPendingBg",
    text.replaceAll(reset, `${reset}${backgroundStart}`),
  );
}

export function renderActivity(
  records: readonly StoredActivityRecord[],
  width: number,
  theme: Theme,
  now = Date.now(),
  lineLimit = ACTIVITY_BODY_LINE_LIMIT,
): string[] {
  const contentWidth = Math.max(1, width);
  const lines: string[] = [];
  const labelWidth = Math.min(
    24,
    Math.max(...records.map((record) => visibleWidth(record.label))),
  );
  const rightWidth = Math.max(
    0,
    ...records.map((record) => visibleWidth(rightFields(record, now))),
  );
  let remaining = lineLimit;
  let renderedRecords = 0;
  for (const record of records) {
    if (remaining === 0) {
      break;
    }
    const depth = depthFor(record, records);
    lines.push(
      recordLine(
        record,
        depth,
        contentWidth,
        theme,
        now,
        labelWidth,
        rightWidth,
      ),
    );
    remaining -= 1;
    renderedRecords += 1;
    if (record.detail && remaining > 0) {
      lines.push(detailLine(record.detail, depth, contentWidth, theme));
      remaining -= 1;
    }
  }
  const overflow = records.length - renderedRecords;
  if (overflow > 0) {
    lines.push(
      theme.fg(
        "muted",
        truncateToWidth(`… ${overflow} more`, contentWidth, "…", false),
      ),
    );
  }
  return lines;
}

function depthFor(
  record: StoredActivityRecord,
  records: readonly StoredActivityRecord[],
): number {
  const byKey = new Map(records.map((item) => [item.key, item]));
  let depth = 0;
  let parent = record.parent
    ? byKey.get(`${record.parent.source}:${record.parent.id}`)
    : undefined;
  while (parent && depth < 3) {
    depth += 1;
    parent = parent.parent
      ? byKey.get(`${parent.parent.source}:${parent.parent.id}`)
      : undefined;
  }
  return depth;
}

function detailLine(
  detail: string,
  depth: number,
  width: number,
  theme: Theme,
): string {
  const prefix = `${"  ".repeat(Math.min(depth + 1, 3))}`;
  const plain = `${prefix}${truncateToWidth(
    detail,
    Math.max(0, width - visibleWidth(prefix)),
    "…",
    false,
  )}`;
  return theme.fg("muted", plain);
}

function recordLine(
  record: StoredActivityRecord,
  depth: number,
  width: number,
  theme: Theme,
  now: number,
  labelWidth: number,
  rightWidth: number,
): string {
  const indentation = depth ? `${"  ".repeat(depth - 1)}└ ` : "";
  const glyph = glyphFor(record.state);
  const prefix = `${indentation}${glyph} `;
  if (visibleWidth(prefix) >= width) {
    return theme.fg("accent", truncateToWidth(prefix, width, "", false));
  }
  const right = rightFields(record, now);
  const available = Math.max(
    0,
    width - visibleWidth(prefix) - (right ? rightWidth + 1 : 0),
  );
  const primary = primaryFields(
    record.label,
    record.title,
    available,
    labelWidth,
  );
  const shownRight =
    right && primary
      ? `${" ".repeat(rightWidth - visibleWidth(right))}${right}`
      : "";
  return styleRecordLine(indentation, glyph, primary, shownRight, theme);
}

function rightFields(record: StoredActivityRecord, now: number): string {
  const values: string[] = [];
  if (record.metric) {
    values.push(record.metric);
  }
  if (record.progress) {
    values.push(
      formatProgress(record.progress.completed, record.progress.total),
    );
  }
  if (record.startedAt !== undefined) {
    values.push(formatDuration(now - record.startedAt));
  }
  return values.join(" · ");
}

function primaryFields(
  label: string,
  title: string,
  width: number,
  preferredLabelWidth: number,
): string {
  if (width <= 0) {
    return "";
  }
  const separator = " · ";
  if (width <= visibleWidth(separator) + 1) {
    return truncateToWidth(title, width, "…", false);
  }
  const available = width - visibleWidth(separator);
  const labelWidth = Math.min(preferredLabelWidth, Math.max(1, available - 1));
  const shownLabel = truncateToWidth(label, labelWidth, "…", false);
  const paddedLabel = `${shownLabel}${" ".repeat(
    Math.max(0, labelWidth - visibleWidth(shownLabel)),
  )}`;
  const titleWidth = Math.max(1, available - labelWidth);
  const shownTitle = truncateToWidth(title, titleWidth, "…", false);
  const paddedTitle = `${shownTitle}${" ".repeat(
    Math.max(0, titleWidth - visibleWidth(shownTitle)),
  )}`;
  return `${paddedLabel}${separator}${paddedTitle}`;
}

function styleRecordLine(
  indentation: string,
  glyph: string,
  primary: string,
  right: string,
  theme: Theme,
): string {
  const labelEnd = primary.indexOf(" · ");
  const styledPrimary =
    labelEnd < 0
      ? primary
      : `${theme.fg("toolTitle", primary.slice(0, labelEnd))}${theme.fg("muted", " · ")}${primary.slice(labelEnd + 3)}`;
  return `${theme.fg("accent", indentation)}${theme.fg("accent", glyph)} ${styledPrimary}${right ? ` ${theme.fg("muted", right)}` : ""}`;
}

function glyphFor(state: ActivityState): string {
  return state === "running" ? "●" : state === "waiting" ? "◌" : "○";
}
