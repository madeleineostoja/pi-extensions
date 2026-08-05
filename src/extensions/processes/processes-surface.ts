import type {
  ExtensionCommandContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import {
  matchesKey,
  truncateToWidth,
  type Component,
  type TUI,
} from "@earendil-works/pi-tui";
import { formatDuration } from "#lib/ui/metrics";
import { Panel } from "#lib/ui/panel";
import { ScrollViewport } from "#lib/ui/scroll-viewport";
import {
  WideSelectList,
  type WideListEntry,
  type WideListItem,
} from "#lib/ui/wide-select-list";
import type { ProcessSnapshot, ProcessRuntime } from "./runtime.js";

type Action = "output" | "stop" | "back";
type Entry = {
  id: string;
  snapshot: ProcessSnapshot;
  section: "running" | "settled";
};
type Mode = "roster" | "landing" | "output";

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
  #mode: Mode = "roster";
  #selectedId: string | undefined;
  #roster: WideSelectList<Entry>;
  #rosterEntries: Entry[] = [];
  #rosterPosition = 0;
  #actions: WideSelectList<Action> | undefined;
  #actionValues: Action[] = [];
  #outputScroll: ScrollViewport | undefined;
  #output:
    | {
        id: string;
        content: string;
        firstRetainedLine: number;
        prefixLines: number;
      }
    | undefined;
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
    this.#roster = this.#replaceRoster(undefined, 0);
    this.#unsubscribe = runtime.subscribe(() => this.#scheduleRefresh());
  }

  dispose(): void {
    this.#close();
  }

  invalidate(): void {
    this.#roster.invalidate();
    this.#actions?.invalidate();
    this.#outputScroll?.invalidate();
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "q")) {
      if (this.#mode === "output") {
        this.#mode = "landing";
        this.#outputScroll = undefined;
        this.tui.requestRender();
      } else if (this.#mode === "landing") {
        this.#back();
      } else {
        this.#close();
      }
      return;
    }
    if (this.#mode === "output") {
      this.#outputScroll?.handleInput(data, { homeEnd: true });
      this.tui.requestRender();
      return;
    }
    (this.#mode === "roster" ? this.#roster : this.#actions)?.handleInput(data);
    this.tui.requestRender();
  }

  render(width: number): string[] {
    if (this.#mode !== "roster" && !this.#selectedSnapshot()) {
      this.#loseSelection();
    }
    const options =
      this.#mode === "roster"
        ? { title: "Processes", child: this.#roster as Component }
        : this.#mode === "landing"
          ? { title: "Process", child: this.#landingComponent() }
          : { title: "Process output", child: this.#outputComponent() };
    return new Panel({ theme: this.theme, ...options }).render(width);
  }

  #entries(): Entry[] {
    const running: Entry[] = [];
    const settled: Entry[] = [];
    for (const snapshot of this.runtime.snapshots()) {
      const entry: Entry = {
        id: snapshot.id,
        snapshot,
        section: snapshot.status === "running" ? "running" : "settled",
      };
      (entry.section === "running" ? running : settled).push(entry);
    }
    return [...running, ...settled];
  }

  #replaceRoster(
    preferredId: string | undefined,
    preferredIndex: number,
  ): WideSelectList<Entry> {
    const entries = this.#entries();
    this.#rosterEntries = entries;
    const grouped: WideListEntry<Entry>[] = [];
    for (const entry of entries) {
      if (
        grouped.at(-1)?.kind !== "section" &&
        (grouped.length === 0 ||
          (grouped.at(-1) as WideListItem<Entry>).data.section !==
            entry.section)
      ) {
        grouped.push({
          kind: "section",
          label: entry.section === "running" ? "Running" : "Settled",
          style: (text) => this.theme.fg("muted", text),
        });
      }
      grouped.push(rosterItem(entry, this.theme));
    }
    const list = new WideSelectList({
      entries: grouped,
      maxVisible: 12,
      selectedPrefix: (text) => this.theme.fg("accent", text),
      onSelect: (item) => {
        const index = this.#rosterEntries.findIndex(
          (entry) => entry.id === item.value,
        );
        if (index >= 0) {
          this.#open(item.data, index);
        }
      },
    });
    const fallback =
      entries[
        Math.min(Math.max(0, preferredIndex), Math.max(0, entries.length - 1))
      ]?.id;
    list.setSelectedValue(
      entries.some((entry) => entry.id === preferredId)
        ? preferredId
        : fallback,
      preferredIndex,
    );
    this.#rosterPosition = Math.max(0, preferredIndex);
    return list;
  }

  #open(entry: Entry, rosterPosition: number): void {
    this.#outputRevision += 1;
    this.#output = undefined;
    this.#outputScroll = undefined;
    this.#selectedId = entry.id;
    this.#rosterPosition = rosterPosition;
    this.#lastLost = undefined;
    this.#mode = "landing";
    this.#bindSelectedRecord(entry.id);
    this.#makeActions(entry.snapshot);
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
      "output",
      ...(snapshot.status === "running" ? (["stop"] as const) : []),
      "back",
    ];
    if (this.#actions && values.join("|") === this.#actionValues.join("|")) {
      return;
    }
    const selected = this.#actions?.getSelectedItem()?.value as
      | Action
      | undefined;
    this.#actionValues = values;
    this.#actions = new WideSelectList({
      entries: values.map((value) => ({
        kind: "item" as const,
        value,
        data: value,
        elastic: actionLabel(value),
      })),
      maxVisible: 4,
      selectedPrefix: (text) => this.theme.fg("accent", text),
      onSelect: (item) => void this.#action(item.data),
    });
    this.#actions.setSelectedValue(selected, 0);
  }

  #landingComponent(): Component {
    const snapshot = this.#selectedSnapshot();
    if (!snapshot) {
      return textComponent(["Selected process is no longer available."]);
    }
    return {
      render: (width) => [
        ...textComponent(landingLines(snapshot)).render(width),
        "",
        ...(this.#actions?.render(width) ?? []),
      ],
      invalidate: () => this.#actions?.invalidate(),
    };
  }

  #outputComponent(): Component {
    if (!this.#outputScroll) {
      const cached = this.#output;
      const output =
        cached !== undefined && cached.id === this.#selectedId
          ? cached.content
          : "Loading retained output…";
      this.#outputScroll = new ScrollViewport({
        content: textComponent(output.split("\n")),
        viewportHeight: 24,
        followBottom: true,
      });
      if (this.#selectedId) {
        this.#loadOutput(this.#selectedId);
      }
    }
    return this.#outputScroll;
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
      this.#roster = this.#replaceRoster(selected, index);
    } else {
      const snapshot = this.#selectedSnapshot();
      if (!snapshot) {
        this.#loseSelection();
        return;
      }
      this.#makeActions(snapshot);
      if (this.#mode === "output") {
        this.#loadOutput(snapshot.id);
      }
    }
    this.tui.requestRender();
  }

  #loadOutput(id: string): void {
    const revision = ++this.#outputRevision;
    void this.runtime
      .inspectionOutput(id)
      .then(({ output, firstRetainedLine, prefixLines }) => {
        if (
          !this.#disposed &&
          revision === this.#outputRevision &&
          this.#selectedId === id &&
          this.#selectedSnapshot()?.id === id
        ) {
          const previous = this.#output;
          // Keep a manually viewed retained line fixed when output eviction
          // replaces prefix lines, including its dropped-output notice.
          const offsetDelta =
            previous?.id === id
              ? prefixLines -
                previous.prefixLines -
                (firstRetainedLine - previous.firstRetainedLine)
              : 0;
          this.#output = {
            id,
            content: output,
            firstRetainedLine,
            prefixLines,
          };
          this.#outputScroll?.setContent(textComponent(output.split("\n")), {
            offsetDelta,
          });
          this.tui.requestRender();
        }
      })
      .catch(() => {
        if (
          !this.#disposed &&
          revision === this.#outputRevision &&
          this.#selectedId === id
        ) {
          this.#output = {
            id,
            content: "Retained output is unavailable.",
            firstRetainedLine: 0,
            prefixLines: 0,
          };
          this.#outputScroll?.setContent(textComponent([this.#output.content]));
          this.tui.requestRender();
        }
      });
  }

  async #action(action: Action): Promise<void> {
    if (action === "back") {
      this.#back();
      return;
    }
    if (action === "output") {
      if (!this.#selectedSnapshot()) {
        this.#loseSelection();
        return;
      }
      this.#mode = "output";
      this.#outputScroll = undefined;
      this.tui.requestRender();
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
    this.#actions = undefined;
    this.#outputScroll = undefined;
    this.#output = undefined;
    this.#outputRevision += 1;
    this.#roster = this.#replaceRoster(id, position);
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
    this.#actions = undefined;
    this.#outputScroll = undefined;
    this.#output = undefined;
    this.#outputRevision += 1;
    this.#roster = this.#replaceRoster(id, position);
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

function rosterItem(entry: Entry, theme: Theme): WideListItem<Entry> {
  return {
    kind: "item",
    value: entry.id,
    data: entry,
    prefix: `${glyph(entry.snapshot.status)} `,
    prefixWidth: 2,
    elastic: bounded(entry.snapshot.description, 180),
    right: duration(entry.snapshot),
    elasticStyle: (text) => theme.fg("muted", text),
    rightStyle: (text) => theme.fg("muted", text),
  };
}

function landingLines(snapshot: ProcessSnapshot): string[] {
  const settlement = [
    `Settlement: ${snapshot.status}`,
    ...(snapshot.exitCode === null ? [] : [`exit ${snapshot.exitCode}`]),
    ...(snapshot.signal === null ? [] : [`signal ${snapshot.signal}`]),
  ].join(" · ");
  return [
    bounded(snapshot.description, 240),
    "",
    [
      snapshot.status,
      duration(snapshot),
      ...(snapshot.pid > 0 ? [`pid ${snapshot.pid}`] : []),
    ].join(" · "),
    bounded(snapshot.command, 2_048),
    bounded(snapshot.cwd, 2_048),
    settlement,
    ...(snapshot.droppedBytes > 0
      ? [`Older output dropped: ${snapshot.droppedBytes} bytes.`]
      : []),
    ...(!snapshot.outputComplete ? ["Final output may be incomplete."] : []),
  ];
}

function glyph(status: ProcessSnapshot["status"]): string {
  return { running: "●", completed: "✓", failed: "×", stopped: "■" }[status];
}

function actionLabel(action: Action): string {
  return {
    output: "View output",
    stop: "Stop process",
    back: "Back",
  }[action];
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
