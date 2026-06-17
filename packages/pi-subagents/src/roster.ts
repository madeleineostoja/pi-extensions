import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type {
  RuntimeSnapshot,
  SubagentRuntime,
  SubagentRuntimeStatus,
} from "./runtime.js";

const WIDGET_KEY = "subagents";
const REFRESH_MS = 350;
const terminalStatuses = new Set<SubagentRuntimeStatus>([
  "completed",
  "failed",
  "stopped",
]);

type RosterContext = Pick<ExtensionContext, "mode" | "hasUI" | "ui">;

export class SubagentRosterController {
  #ctx: RosterContext | undefined;
  #interval: ReturnType<typeof setInterval> | undefined;
  #components = new Set<SubagentRosterWidget>();

  constructor(private runtime: SubagentRuntime) {}

  track(ctx: RosterContext): void {
    if (!canUseRoster(ctx)) {
      return;
    }
    if (this.#ctx && this.#ctx.ui !== ctx.ui) {
      this.#clearWidget();
    }
    this.#ctx = ctx;
    if (this.#interval === undefined) {
      this.#ctx.ui.setWidget(
        WIDGET_KEY,
        (tui, theme) => {
          const widget = new SubagentRosterWidget(
            this.runtime,
            tui,
            theme,
            () => {
              this.#components.delete(widget);
            },
          );
          this.#components.add(widget);
          return widget;
        },
        { placement: "aboveEditor" },
      );
      this.#interval = setInterval(() => this.#refresh(), REFRESH_MS);
    }
    this.#refresh();
  }

  dispose(): void {
    this.#clearWidget();
  }

  #refresh(): void {
    const active = activeSnapshots(this.runtime).length > 0;
    if (!active) {
      this.#clearWidget();
      return;
    }
    for (const component of this.#components) {
      component.invalidate();
    }
  }

  #clearWidget(): void {
    if (this.#interval !== undefined) {
      clearInterval(this.#interval);
      this.#interval = undefined;
    }
    for (const component of this.#components) {
      component.dispose();
    }
    this.#components.clear();
    this.#ctx?.ui.setWidget(WIDGET_KEY, undefined);
    this.#ctx = undefined;
  }
}

export function canUseRoster(ctx: RosterContext): boolean {
  return ctx.mode === "tui" && ctx.hasUI;
}

export function formatRosterRows(snapshots: RuntimeSnapshot[]): string[] {
  const rows = activeSnapshotsFrom(snapshots).map((snapshot) => ({
    type: snapshot.type,
    description: snapshot.description,
    status: snapshot.status,
    tool: snapshot.health?.activeTool ?? "-",
    turns: String(snapshot.health?.turns ?? "-"),
    tokens: tokenLabel(snapshot.health?.tokensTotal),
    elapsed: elapsedLabel(snapshot),
  }));
  if (rows.length === 0) {
    return [];
  }
  const widths = {
    type: maxWidth(
      "type",
      rows.map((row) => row.type),
    ),
    status: maxWidth(
      "status",
      rows.map((row) => row.status),
    ),
    tool: maxWidth(
      "tool",
      rows.map((row) => row.tool),
    ),
    turns: maxWidth(
      "turns",
      rows.map((row) => row.turns),
    ),
    tokens: maxWidth(
      "tokens",
      rows.map((row) => row.tokens),
    ),
    elapsed: maxWidth(
      "elapsed",
      rows.map((row) => row.elapsed),
    ),
  };
  return [
    [
      "type".padEnd(widths.type),
      "status".padEnd(widths.status),
      "tool".padEnd(widths.tool),
      "turns".padStart(widths.turns),
      "tokens".padStart(widths.tokens),
      "elapsed".padStart(widths.elapsed),
      "description",
    ].join("  "),
    ...rows.map((row) =>
      [
        row.type.padEnd(widths.type),
        row.status.padEnd(widths.status),
        row.tool.padEnd(widths.tool),
        row.turns.padStart(widths.turns),
        row.tokens.padStart(widths.tokens),
        row.elapsed.padStart(widths.elapsed),
        row.description,
      ].join("  "),
    ),
  ];
}

class SubagentRosterWidget implements Component {
  #disposed = false;

  constructor(
    private runtime: SubagentRuntime,
    private tui: TUI,
    private theme: Theme,
    private onDispose: () => void,
  ) {}

  invalidate(): void {
    if (!this.#disposed) {
      this.tui.requestRender();
    }
  }

  dispose(): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    this.onDispose();
  }

  render(width: number): string[] {
    const rows = formatRosterRows(
      this.runtime.snapshots({ includeNested: true }),
    );
    if (rows.length === 0) {
      return [];
    }
    const [header, ...body] = rows;
    const lines = [
      this.theme.bold("Subagents"),
      this.theme.fg("dim", header ?? ""),
      ...body,
    ];
    return lines.map((line) =>
      truncateToWidth(line, Math.max(1, width), "...", false),
    );
  }
}

function activeSnapshots(runtime: SubagentRuntime): RuntimeSnapshot[] {
  return activeSnapshotsFrom(runtime.snapshots({ includeNested: true }));
}

function activeSnapshotsFrom(snapshots: RuntimeSnapshot[]): RuntimeSnapshot[] {
  return snapshots.filter((snapshot) => !terminalStatuses.has(snapshot.status));
}

export function elapsedLabel(snapshot: RuntimeSnapshot): string {
  const start = Date.parse(
    snapshot.timestamps.startedAt ?? snapshot.timestamps.queuedAt,
  );
  const end = Date.parse(
    snapshot.timestamps.completedAt ?? new Date().toISOString(),
  );
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    return "unknown";
  }
  const seconds = Math.max(0, Math.round((end - start) / 1000));
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}m ${remainder.toString().padStart(2, "0")}s`;
}

function tokenLabel(value: number | undefined): string {
  if (value === undefined) {
    return "-";
  }
  if (value < 1000) {
    return String(value);
  }
  return `${(value / 1000)
    .toFixed(2)
    .replace(/\.00$/, "")
    .replace(/(\.\d)0$/, "$1")}k`;
}

function maxWidth(label: string, values: string[]): number {
  return Math.max(label.length, ...values.map((value) => value.length));
}
