import type {
  ExtensionCommandContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import {
  matchesKey,
  SelectList,
  type Component,
  type TUI,
  truncateToWidth,
} from "@earendil-works/pi-tui";
import { Panel } from "#lib/ui/panel";
import { formatDuration } from "#lib/ui/metrics";
import type { ProcessSnapshot, ProcessRuntime } from "./runtime.js";

type Action = "stop" | "back";
type Entry = {
  id: string;
  snapshot: ProcessSnapshot;
  section: "running" | "stopped";
};

export async function showProcessesSurface(
  runtime: ProcessRuntime,
  ctx: ExtensionCommandContext,
): Promise<void> {
  await ctx.ui.custom<void>(
    (tui, theme, _keys, done) =>
      new ProcessesSurface(runtime, ctx, tui, theme, done),
  );
}

export class ProcessesSurface implements Component {
  #mode: "roster" | "inspector" = "roster";
  #selectedId: string | undefined;
  #roster: SelectList;
  #rosterEntries: Entry[] = [];
  #rosterPosition = 0;
  #actions: SelectList | undefined;
  #actionValues: Action[] = [];
  #contentOffset = 0;
  #focus: "actions" | "content" = "actions";
  #output = "Loading recent output…";
  #outputRevision = 0;
  #renderQueued = false;
  #disposed = false;
  #lastLost: string | undefined;
  #unsubscribe: () => void;
  #unsubscribeRecord: (() => void) | undefined;

  constructor(
    private readonly runtime: ProcessRuntime,
    private readonly ctx: ExtensionCommandContext,
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly done: () => void,
  ) {
    this.#roster = new SelectList([], 12, selectTheme(theme));
    this.#replaceRoster(undefined, 0);
    this.#unsubscribe = runtime.subscribe(() => this.#scheduleRefresh());
  }

  dispose(): void {
    this.#close();
  }

  invalidate(): void {
    this.#roster.invalidate();
    this.#actions?.invalidate();
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "q")) {
      if (this.#mode === "inspector") {
        this.#back();
      } else {
        this.#close();
      }
      return;
    }
    if (this.#mode === "inspector" && matchesKey(data, "tab")) {
      this.#focus = this.#focus === "actions" ? "content" : "actions";
      this.tui.requestRender();
      return;
    }
    if (this.#mode === "inspector" && this.#focus === "content") {
      if (matchesKey(data, "down") || matchesKey(data, "j")) {
        this.#contentOffset += 1;
      } else if (matchesKey(data, "up") || matchesKey(data, "k")) {
        this.#contentOffset = Math.max(0, this.#contentOffset - 1);
      } else {
        return;
      }
      this.tui.requestRender();
      return;
    }
    (this.#mode === "roster" ? this.#roster : this.#actions)?.handleInput(data);
  }

  render(width: number): string[] {
    if (this.#mode === "inspector" && !this.#selectedSnapshot()) {
      this.#loseSelection();
    }
    return new Panel({
      theme: this.theme,
      title: this.#mode === "roster" ? "Processes" : "Process inspector",
      subtitle:
        this.#mode === "roster"
          ? "Running and stopped current-session processes"
          : this.#focus === "actions"
            ? "Actions focused · Tab: output"
            : "Output focused · Tab: actions · ↑↓: scroll",
      footer:
        this.#mode === "roster"
          ? "Enter: inspect · Esc: close"
          : "Enter: action · Esc: back",
      child:
        this.#mode === "roster" ? this.#rosterComponent() : this.#inspector(),
    }).render(width);
  }

  #entries(): Entry[] {
    const running: Entry[] = [];
    const stopped: Entry[] = [];
    for (const snapshot of this.runtime.snapshots()) {
      const entry: Entry = {
        id: snapshot.id,
        snapshot,
        section: snapshot.status === "running" ? "running" : "stopped",
      };
      (entry.section === "running" ? running : stopped).push(entry);
    }
    return [...running, ...stopped];
  }

  #rosterComponent(): Component {
    if (this.#rosterEntries.length === 0) {
      return textComponent(["No current-session managed processes."]);
    }
    if (this.#rosterEntries.some((entry) => entry.section === "running")) {
      return this.#roster;
    }
    return {
      render: (width) => [
        "No running managed processes.",
        ...this.#roster.render(width),
      ],
      invalidate: () => this.#roster.invalidate(),
    };
  }

  #replaceRoster(
    preferredId: string | undefined,
    preferredIndex: number,
  ): void {
    const entries = this.#entries();
    this.#rosterEntries = entries;
    this.#roster = new SelectList(
      entries.map((entry, index) => ({
        value: entry.id,
        label: `${sectionPrefix(entries, index)}${glyph(entry.snapshot.status)} ${bounded(entry.snapshot.description, 120)}`,
        description: rosterMetrics(entry.snapshot),
      })),
      12,
      selectTheme(this.theme),
    );
    this.#roster.onSelect = (item) => {
      const index = this.#rosterEntries.findIndex(
        (entry) => entry.id === item.value,
      );
      const entry = this.#rosterEntries[index];
      if (entry) {
        this.#open(entry, index);
      }
    };
    if (entries.length > 0) {
      const index = entries.findIndex((entry) => entry.id === preferredId);
      const selected =
        index >= 0
          ? index
          : Math.min(Math.max(0, preferredIndex), entries.length - 1);
      this.#roster.setSelectedIndex(selected);
      this.#rosterPosition = selected;
    } else {
      this.#rosterPosition = 0;
    }
  }

  #open(entry: Entry, rosterPosition: number): void {
    this.#selectedId = entry.id;
    this.#rosterPosition = rosterPosition;
    this.#lastLost = undefined;
    this.#mode = "inspector";
    this.#contentOffset = 0;
    this.#focus = "actions";
    this.#output = "Loading recent output…";
    this.#bindSelectedRecord(entry.id);
    this.#makeActions(entry.snapshot);
    this.#loadOutput(entry.id);
    this.tui.requestRender();
  }

  #selectedSnapshot(): ProcessSnapshot | undefined {
    if (!this.#selectedId) {
      return undefined;
    }
    try {
      return this.runtime.snapshot(this.#selectedId);
    } catch {
      return undefined;
    }
  }

  #bindSelectedRecord(id: string): void {
    this.#unsubscribeRecord?.();
    this.#unsubscribeRecord = this.runtime.subscribeRecord(id, () =>
      this.#scheduleRefresh(),
    );
  }

  #makeActions(snapshot: ProcessSnapshot): void {
    const values: Action[] = [
      ...(snapshot.status === "running" ? (["stop"] as const) : []),
      "back",
    ];
    if (values.join("|") === this.#actionValues.join("|")) {
      return;
    }
    const selected = this.#actions?.getSelectedItem()?.value as
      | Action
      | undefined;
    this.#actionValues = values;
    this.#actions = new SelectList(
      values.map((value) => ({
        value,
        label: value === "stop" ? "Stop" : "Back",
      })),
      8,
      selectTheme(this.theme),
    );
    this.#actions.onSelect = (item) => void this.#action(item.value as Action);
    this.#actions.setSelectedIndex(
      selected === undefined ? 0 : Math.max(0, values.indexOf(selected)),
    );
  }

  #inspector(): Component {
    const snapshot = this.#selectedSnapshot();
    if (!snapshot) {
      return textComponent(["Selected process is no longer available."]);
    }
    const content = textComponent(detailLines(snapshot, this.#output));
    return {
      render: (width) => {
        const sidebarWidth = Math.min(24, Math.max(10, Math.floor(width / 3)));
        const contentWidth = Math.max(1, width - sidebarWidth - 3);
        const actions = this.#actions?.render(sidebarWidth) ?? [];
        const lines = content.render(contentWidth);
        this.#contentOffset = Math.min(
          this.#contentOffset,
          Math.max(0, lines.length - 1),
        );
        const visible = lines.slice(
          this.#contentOffset,
          this.#contentOffset + 24,
        );
        return Array.from(
          { length: Math.max(actions.length, visible.length) },
          (_, index) =>
            `${truncateToWidth(actions[index] ?? "", sidebarWidth, "…", false)}${this.#focus === "actions" ? " │ " : " · "}${truncateToWidth(visible[index] ?? "", contentWidth, "…", false)}`,
        );
      },
      invalidate: () => {
        this.#actions?.invalidate();
        content.invalidate();
      },
    };
  }

  #scheduleRefresh(): void {
    if (this.#disposed || this.#renderQueued) {
      return;
    }
    this.#renderQueued = true;
    queueMicrotask(() => {
      this.#renderQueued = false;
      this.#refresh();
    });
  }

  #refresh(): void {
    if (this.#disposed) {
      return;
    }
    if (this.#mode === "roster") {
      const selected = this.#roster.getSelectedItem()?.value;
      const index = Math.max(
        0,
        this.#rosterEntries.findIndex((entry) => entry.id === selected),
      );
      const entries = this.#entries();
      if (selected && !entries.some((entry) => entry.id === selected)) {
        this.#notifySelectionLoss(selected);
      }
      this.#replaceRoster(selected, index);
    } else {
      const snapshot = this.#selectedSnapshot();
      if (!snapshot) {
        this.#loseSelection();
        return;
      }
      this.#makeActions(snapshot);
      this.#loadOutput(snapshot.id);
    }
    this.tui.requestRender();
  }

  #loadOutput(id: string): void {
    const revision = ++this.#outputRevision;
    void this.runtime
      .result(id, false, undefined, undefined)
      .then(({ output }) => {
        if (
          !this.#disposed &&
          revision === this.#outputRevision &&
          this.#selectedId === id &&
          this.#selectedSnapshot()?.id === id
        ) {
          this.#output = output;
          this.tui.requestRender();
        }
      })
      .catch(() => {
        if (!this.#disposed && revision === this.#outputRevision) {
          this.#output = "Recent output is unavailable.";
          this.tui.requestRender();
        }
      });
  }

  async #action(action: Action): Promise<void> {
    if (action === "back") {
      this.#back();
      return;
    }
    const id = this.#selectedId;
    const snapshot = this.#selectedSnapshot();
    if (
      !id ||
      !snapshot ||
      snapshot.id !== id ||
      snapshot.status !== "running"
    ) {
      this.#warning("Process already settled or is no longer available.");
      return;
    }
    const confirmed = await this.ctx.ui.confirm(
      "Stop process",
      "Stop this running managed process?",
    );
    if (!confirmed) {
      return;
    }
    const current = this.#selectedSnapshot();
    if (!current || current.id !== id || current.status !== "running") {
      this.#warning("Process already settled or is no longer available.");
      return;
    }
    try {
      await this.runtime.stop(id);
    } catch {
      this.#warning("Process already settled or is no longer available.");
    }
    this.#refresh();
  }

  #notifySelectionLoss(id: string): void {
    if (this.#lastLost === id) {
      return;
    }
    this.#lastLost = id;
    this.ctx.ui.notify(
      "Selected process is no longer available; showing nearest roster entry.",
      "warning",
    );
  }

  #loseSelection(): void {
    const id = this.#selectedId;
    if (id) {
      this.#notifySelectionLoss(id);
    }
    const position = this.#rosterPosition;
    this.#unsubscribeRecord?.();
    this.#unsubscribeRecord = undefined;
    this.#selectedId = undefined;
    this.#mode = "roster";
    this.#contentOffset = 0;
    this.#outputRevision += 1;
    this.#replaceRoster(id, position);
    this.tui.requestRender();
  }

  #warning(message: string): void {
    this.ctx.ui.notify(message, "warning");
    this.#refresh();
  }

  #back(): void {
    const id = this.#selectedId;
    const position = this.#rosterPosition;
    this.#unsubscribeRecord?.();
    this.#unsubscribeRecord = undefined;
    this.#selectedId = undefined;
    this.#mode = "roster";
    this.#contentOffset = 0;
    this.#outputRevision += 1;
    this.#replaceRoster(id, position);
    this.tui.requestRender();
  }

  #close(): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    this.#outputRevision += 1;
    this.#unsubscribeRecord?.();
    this.#unsubscribeRecord = undefined;
    this.#unsubscribe();
    this.done();
  }
}

function sectionPrefix(entries: readonly Entry[], index: number): string {
  const entry = entries[index];
  if (!entry || (index > 0 && entries[index - 1]?.section === entry.section)) {
    return "";
  }
  return entry.section === "running" ? "Running · " : "Stopped · ";
}

function glyph(status: ProcessSnapshot["status"]): string {
  return { running: "●", completed: "✓", failed: "×", stopped: "■" }[status];
}

function rosterMetrics(snapshot: ProcessSnapshot): string {
  return [
    snapshot.status,
    duration(snapshot),
    snapshot.pid > 0 ? `pid ${snapshot.pid}` : undefined,
  ]
    .filter((part): part is string => Boolean(part))
    .join(" · ");
}

function detailLines(snapshot: ProcessSnapshot, output: string): string[] {
  return [
    `${glyph(snapshot.status)} ${bounded(snapshot.description, 240)}`,
    `Status: ${snapshot.status}`,
    `Command: ${bounded(snapshot.command, 2_048)}`,
    `Cwd: ${bounded(snapshot.cwd, 2_048)}`,
    `PID: ${snapshot.pid || "unavailable"}`,
    `Started: ${snapshot.startedAt}`,
    ...(snapshot.endedAt === undefined ? [] : [`Ended: ${snapshot.endedAt}`]),
    `Duration: ${duration(snapshot)}`,
    `Exit: ${snapshot.exitCode ?? "none"}`,
    `Signal: ${snapshot.signal ?? "none"}`,
    `Output retained: ${snapshot.retainedBytes} bytes`,
    `Output dropped: ${snapshot.droppedBytes} bytes`,
    `Final output: ${snapshot.outputComplete ? "complete" : "may be incomplete"}`,
    "Recent output:",
    ...output.split("\n"),
  ];
}

function duration(snapshot: ProcessSnapshot): string {
  const started = Date.parse(snapshot.startedAt);
  const ended = Date.parse(snapshot.endedAt ?? new Date().toISOString());
  return Number.isFinite(started) && Number.isFinite(ended)
    ? formatDuration(ended - started)
    : "unknown";
}

function bounded(value: string, maximum: number): string {
  const compact = value.replace(/\p{C}/gu, " ").replace(/\s+/g, " ").trim();
  return Array.from(compact).slice(0, maximum).join("");
}

function textComponent(lines: readonly string[]): Component {
  return {
    render: (width) =>
      lines.map((line) =>
        truncateToWidth(line, Math.max(1, width), "…", false),
      ),
    invalidate() {},
  };
}

function selectTheme(theme: Theme) {
  return {
    selectedPrefix: (text: string) => theme.fg("accent", text),
    selectedText: (text: string) => theme.bold(text),
    description: (text: string) => theme.fg("muted", text),
    scrollInfo: (text: string) => theme.fg("muted", text),
    noMatch: (text: string) => theme.fg("muted", text),
  };
}
