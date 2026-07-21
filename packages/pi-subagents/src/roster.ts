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
    cost: costLabel(snapshot.health?.estimatedCost),
    tokens: tokenLabel(snapshot.health?.peakContextTokens),
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
    cost: maxWidth(
      "cost",
      rows.map((row) => row.cost),
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
      "cost".padStart(widths.cost),
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
        row.cost.padStart(widths.cost),
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
  return snapshots.filter(
    (snapshot) =>
      !terminalStatuses.has(snapshot.status) &&
      snapshot.rosterVisibility !== "hide",
  );
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

export function contextUsageLabel(snapshot: RuntimeSnapshot): string {
  const tokens = snapshot.health?.contextUsage?.tokens;
  return tokens === undefined || tokens === null ? "?" : tokenLabel(tokens);
}

export function costLabel(value: number | undefined): string {
  return value === undefined ? "-" : `$${value.toFixed(2)}`;
}

export function tokenLabel(value: number | undefined): string {
  if (value === undefined) {
    return "-";
  }
  const rounded = roundToTwoSignificantFigures(value);
  if (rounded < 1000) {
    return String(rounded);
  }
  if (rounded < 1_000_000) {
    return compactTokenLabel(rounded / 1000, "k");
  }
  return compactTokenLabel(rounded / 1_000_000, "M");
}

function roundToTwoSignificantFigures(value: number): number {
  if (value === 0) {
    return 0;
  }
  const power = 10 ** (Math.ceil(Math.log10(Math.abs(value))) - 2);
  return Math.round(value / power) * power;
}

function compactTokenLabel(value: number, suffix: string): string {
  return `${value.toFixed(value >= 10 ? 0 : 1).replace(/\.0$/, "")}${suffix}`;
}

function maxWidth(label: string, values: string[]): number {
  return Math.max(label.length, ...values.map((value) => value.length));
}
