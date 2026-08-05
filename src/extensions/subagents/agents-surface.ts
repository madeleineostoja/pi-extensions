import {
  keyHint,
  rawKeyHint,
  type ExtensionCommandContext,
  type KeybindingsManager,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  Editor,
  Markdown,
  matchesKey,
  type Component,
  type EditorTheme,
  type Focusable,
  type TUI,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import {
  formatCompactTokens,
  formatDuration,
  formatUsdCost,
} from "#lib/ui/metrics";
import { Panel } from "#lib/ui/panel";
import { ScrollViewport } from "#lib/ui/scroll-viewport";
import {
  WideSelectList,
  type WideListEntry,
  type WideListItem,
} from "#lib/ui/wide-select-list";
import type { InspectionToolArguments } from "./inspection.js";
import type {
  RuntimeInspection,
  RuntimeSnapshot,
  SubagentRuntime,
} from "./runtime.js";

const terminal = new Set(["completed", "failed", "stopped"]);
type Action = "activity" | "result" | "stop" | "back";
type Selection = { runtime: SubagentRuntime; key: string; value: string };
type Entry = Selection & {
  snapshot: RuntimeSnapshot;
  depth: number;
  section: "active" | "retained";
};
type Mode = "roster" | "landing" | "activity" | "result";

export async function showAgentsSurface(
  input: SubagentRuntime | readonly SubagentRuntime[],
  ctx: ExtensionCommandContext,
): Promise<void> {
  const runtimes = [...new Set(Array.isArray(input) ? input : [input])];
  await ctx.ui.custom<void>(
    (tui, theme, keys, done) =>
      new AgentsSurface(runtimes, ctx, tui, theme, done, keys),
  );
}

export class AgentsSurface implements Component, Focusable {
  #selected: Selection | undefined;
  #mode: Mode = "roster";
  #roster: WideSelectList<Entry>;
  #rosterEntries: Entry[] = [];
  #rosterPosition = 0;
  #actions: WideSelectList<Action> | undefined;
  #actionValues: Action[] = [];
  #activityScroll: ScrollViewport | undefined;
  #resultScroll: ScrollViewport | undefined;
  #guidance: Editor | undefined;
  #generation = 0;
  #disposed = false;
  #unsubscribers: (() => void)[];
  #lastLost: string | undefined;
  #focused = false;

  get focused(): boolean {
    return this.#focused;
  }

  set focused(value: boolean) {
    this.#focused = value;
    if (this.#guidance) {
      this.#guidance.focused = value;
    }
  }

  constructor(
    private readonly runtimes: SubagentRuntime[],
    private readonly ctx: ExtensionCommandContext,
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly done: () => void,
    private readonly keybindings?: Pick<KeybindingsManager, "matches">,
  ) {
    this.#roster = this.#replaceRoster(undefined, 0);
    this.#unsubscribers = runtimes.map((runtime) =>
      runtime.subscribeSnapshots(() => this.#refresh()),
    );
  }

  dispose(): void {
    this.#close();
  }

  invalidate(): void {
    if (this.#disposed) {
      return;
    }
    this.#roster.invalidate();
    this.#actions?.invalidate();
    this.#activityScroll?.invalidate();
    this.#resultScroll?.invalidate();
    this.#guidance?.invalidate();
  }

  handleInput(data: string): void {
    if (this.#matches(data, "tui.select.cancel", "escape")) {
      if (this.#mode === "roster") {
        this.#close();
      } else if (this.#mode === "activity" || this.#mode === "result") {
        this.#mode = "landing";
        this.#activityScroll = undefined;
        this.#resultScroll = undefined;
        this.#guidance = undefined;
        this.tui.requestRender();
      } else {
        this.#back();
      }
      return;
    }
    if (this.#mode === "activity") {
      const up = this.#matches(data, "tui.select.up", "up");
      const down = this.#matches(data, "tui.select.down", "down");
      if (up || down) {
        this.#activityScroll?.handleInput(up ? "\x1b[A" : "\x1b[B");
      } else if (matchesKey(data, "home") || matchesKey(data, "end")) {
        this.#activityScroll?.handleInput(data, { homeEnd: true });
      } else {
        this.#guidance?.handleInput(data);
      }
      this.tui.requestRender();
      return;
    }
    if (this.#mode === "result") {
      const up = this.#matches(data, "tui.select.up", "up");
      const down = this.#matches(data, "tui.select.down", "down");
      this.#resultScroll?.handleInput(up ? "\x1b[A" : down ? "\x1b[B" : data, {
        homeEnd: true,
      });
      this.tui.requestRender();
      return;
    }
    (this.#mode === "roster" ? this.#roster : this.#actions)?.handleInput(data);
    this.tui.requestRender();
  }

  render(width: number): string[] {
    if (this.#mode !== "roster" && !this.#entry()) {
      this.#loseSelection();
    }
    const options =
      this.#mode === "roster"
        ? { title: "Agents", child: this.#roster as Component }
        : this.#mode === "landing"
          ? {
              title: `Agent · ${displayType(this.#entry()?.snapshot)}`,
              child: this.#landingComponent(),
            }
          : this.#mode === "activity"
            ? {
                title: `Agent activity · ${displayType(this.#entry()?.snapshot)}`,
                child: this.#activityComponent(),
              }
            : {
                title: `Agent result · ${displayType(this.#entry()?.snapshot)}`,
                child: this.#resultComponent(),
              };
    return new Panel({
      theme: this.theme,
      ...options,
      footer: this.#footer(),
    }).render(width);
  }

  #matches(
    data: string,
    binding: Parameters<KeybindingsManager["matches"]>[1],
    key: Parameters<typeof matchesKey>[1],
  ): boolean {
    return this.keybindings?.matches(data, binding) ?? matchesKey(data, key);
  }

  #footer(): Component {
    const hints =
      this.#mode === "roster" || this.#mode === "landing"
        ? `${rawKeyHint("↑↓", "navigate")}  ${keyHint("tui.select.confirm", "select")}  ${keyHint("tui.select.cancel", this.#mode === "roster" ? "close" : "back")}`
        : `${rawKeyHint("↑↓", "scroll")}  ${keyHint("tui.select.cancel", "back")}`;
    return { render: () => [hints], invalidate() {} };
  }

  #entries(): Entry[] {
    const active: Entry[] = [];
    const retained: Entry[] = [];
    for (const [runtimeIndex, runtime] of this.runtimes.entries()) {
      const entries = runtime
        .snapshots({ includeNested: true })
        .filter((snapshot) => snapshot.rosterVisibility !== "hide")
        .map((snapshot) => ({
          runtime,
          key: snapshotKey(runtime, snapshot),
          value: `${runtimeIndex}:${snapshotKey(runtime, snapshot)}`,
          snapshot,
          depth: 0,
          section: "active" as const,
        }));
      const byId = new Map(entries.map((entry) => [entry.snapshot.id, entry]));
      const children = new Map<string, Entry[]>();
      const roots: Entry[] = [];
      for (const entry of entries) {
        const parentId = nestedParent(entry.snapshot);
        if (parentId && byId.has(parentId)) {
          const group = children.get(parentId) ?? [];
          group.push(entry);
          children.set(parentId, group);
        } else {
          roots.push(entry);
        }
      }
      const seen = new Set<Entry>();
      const addGroup = (root: Entry) => {
        const group: Entry[] = [];
        const add = (entry: Entry, depth: number) => {
          if (seen.has(entry)) {
            return;
          }
          seen.add(entry);
          group.push({ ...entry, depth });
          for (const child of children.get(entry.snapshot.id) ?? []) {
            add(child, depth + 1);
          }
        };
        add(root, 0);
        const section: Entry["section"] = group.some(
          (entry) => !terminal.has(entry.snapshot.status),
        )
          ? "active"
          : "retained";
        (section === "active" ? active : retained).push(
          ...group.map((entry) => ({ ...entry, section })),
        );
      };
      for (const root of roots) {
        addGroup(root);
      }
      for (const entry of entries) {
        addGroup(entry);
      }
    }
    return [...active, ...retained];
  }

  #replaceRoster(
    preferredValue: string | undefined,
    preferredIndex: number,
  ): WideSelectList<Entry> {
    const entries = this.#entries();
    this.#rosterEntries = entries;
    const grouped: WideListEntry<Entry>[] = [];
    const prefixWidth = Math.max(
      0,
      ...entries.map((entry) => visibleWidth(rosterPrefix(entry))),
    );
    const typeWidth = Math.max(
      0,
      ...entries.map((entry) => visibleWidth(displayType(entry.snapshot))),
    );
    for (const entry of entries) {
      if (
        grouped.at(-1)?.kind !== "section" &&
        (grouped.length === 0 ||
          (grouped.at(-1) as WideListItem<Entry>).data.section !==
            entry.section)
      ) {
        grouped.push({
          kind: "section",
          label: entry.section === "active" ? "Active" : "Retained",
          style: (text) => this.theme.fg("muted", text),
        });
      }
      grouped.push(rosterItem(entry, this.theme, prefixWidth, typeWidth));
    }
    const list = new WideSelectList({
      entries: grouped,
      maxVisible: 12,
      selectedPrefix: (text) => this.theme.fg("accent", text),
      keybindings: this.keybindings,
      empty: {
        text: "No active or retained agents.",
        style: (text) => this.theme.fg("muted", text),
      },
      onSelect: (item) => {
        const index = this.#rosterEntries.findIndex(
          (entry) => entry.value === item.value,
        );
        if (index >= 0) {
          this.#open(item.data, index);
        }
      },
    });
    const fallbackValue =
      entries[
        Math.min(Math.max(0, preferredIndex), Math.max(0, entries.length - 1))
      ]?.value;
    list.setSelectedValue(
      entries.some((entry) => entry.value === preferredValue)
        ? preferredValue
        : fallbackValue,
      preferredIndex,
    );
    this.#rosterPosition = Math.max(0, preferredIndex);
    return list;
  }

  #open(entry: Entry, rosterPosition: number): void {
    this.#generation += 1;
    this.#selected = {
      runtime: entry.runtime,
      key: entry.key,
      value: entry.value,
    };
    this.#rosterPosition = rosterPosition;
    this.#lastLost = undefined;
    this.#mode = "landing";
    this.#makeActions(entry);
    this.tui.requestRender();
  }

  #entry(entries = this.#entries()): Entry | undefined {
    return this.#selected
      ? entries.find(
          (entry) =>
            entry.runtime === this.#selected?.runtime &&
            entry.key === this.#selected.key,
        )
      : undefined;
  }

  #operationIsCurrent(entry: Entry, generation: number): boolean {
    return (
      !this.#disposed &&
      generation === this.#generation &&
      this.#selected?.runtime === entry.runtime &&
      this.#selected.key === entry.key &&
      Boolean(this.#entry())
    );
  }

  #refresh(): void {
    if (this.#disposed) {
      return;
    }
    if (this.#mode === "roster") {
      const selected = this.#roster.getSelectedItem()?.value;
      const oldIndex = Math.max(
        0,
        this.#rosterEntries.findIndex((entry) => entry.value === selected),
      );
      const entries = this.#entries();
      if (selected && !entries.some((entry) => entry.value === selected)) {
        this.#notifySelectionLoss(selected);
      }
      this.#roster = this.#replaceRoster(selected, oldIndex);
    } else {
      const entry = this.#entry();
      if (!entry) {
        this.#loseSelection();
        return;
      }
      this.#rosterPosition = this.#entries().findIndex(
        (candidate) => candidate.value === entry.value,
      );
      this.#makeActions(entry);
      const inspection = entry.runtime.inspect(entry.snapshot.id);
      if (inspection && this.#mode === "activity") {
        this.#activityScroll?.setContent(
          new TimelineComponent(inspection, this.theme),
        );
        if (!eligibleGuidance(entry)) {
          this.#guidance = undefined;
        }
      }
      if (inspection && this.#mode === "result") {
        this.#resultScroll?.setContent(resultComponent(inspection, this.theme));
      }
    }
    this.tui.requestRender();
  }

  #notifySelectionLoss(value: string): void {
    if (this.#lastLost === value) {
      return;
    }
    this.#lastLost = value;
    this.ctx.ui.notify(
      "Selected agent is no longer available; showing nearest roster entry.",
      "warning",
    );
  }

  #loseSelection(): void {
    const lost = this.#selected?.value;
    if (lost) {
      this.#notifySelectionLoss(lost);
    }
    const position = this.#rosterPosition;
    this.#generation += 1;
    this.#selected = undefined;
    this.#mode = "roster";
    this.#actions = undefined;
    this.#activityScroll = undefined;
    this.#resultScroll = undefined;
    this.#guidance = undefined;
    this.#roster = this.#replaceRoster(lost, position);
    this.tui.requestRender();
  }

  #makeActions(entry: Entry): void {
    const inspection = entry.runtime.inspect(entry.snapshot.id);
    const values: Action[] = ["activity"];
    if (hasResult(inspection)) {
      values.push("result");
    }
    if (eligibleStop(entry)) {
      values.push("stop");
    }
    values.push("back");
    if (values.join("|") === this.#actionValues.join("|")) {
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
      maxVisible: 6,
      selectedPrefix: (text) => this.theme.fg("accent", text),
      keybindings: this.keybindings,
      onSelect: (item) => void this.#action(item.data),
    });
    this.#actions.setSelectedValue(
      selected,
      Math.max(0, values.indexOf(selected ?? "activity")),
    );
  }

  #landingComponent(): Component {
    const entry = this.#entry();
    if (!entry) {
      return textComponent(["Agent is no longer available."]);
    }
    return {
      render: (width) => [
        ...textComponent(landingLines(entry.snapshot)).render(width),
        "",
        ...(this.#actions?.render(width) ?? []),
      ],
      invalidate: () => this.#actions?.invalidate(),
    };
  }

  #activityComponent(): Component {
    const entry = this.#entry();
    const inspection = entry?.runtime.inspect(entry.snapshot.id);
    if (!entry || !inspection) {
      return textComponent(["Activity is unavailable."]);
    }
    if (!this.#activityScroll) {
      this.#activityScroll = new ScrollViewport({
        content: new TimelineComponent(inspection, this.theme),
        viewportHeight: 20,
      });
    }
    if (eligibleGuidance(entry) && !this.#guidance) {
      this.#guidance = this.#makeGuidance(entry);
      this.#guidance.focused = this.#focused;
    }
    return {
      render: (width) => [
        ...this.#activityScroll!.render(width),
        ...(this.#guidance ? ["", ...this.#guidance.render(width)] : []),
      ],
      invalidate: () => {
        this.#activityScroll?.invalidate();
        this.#guidance?.invalidate();
      },
    };
  }

  #resultComponent(): Component {
    const entry = this.#entry();
    const inspection = entry?.runtime.inspect(entry.snapshot.id);
    if (!inspection || !hasResult(inspection)) {
      return textComponent(["Result is unavailable."]);
    }
    if (!this.#resultScroll) {
      this.#resultScroll = new ScrollViewport({
        content: resultComponent(inspection, this.theme),
        viewportHeight: 24,
      });
    }
    return this.#resultScroll;
  }

  #makeGuidance(entry: Entry): Editor {
    const editor = new Editor(this.tui, editorTheme(this.theme));
    editor.onSubmit = (message) =>
      void this.#sendGuidance(entry, editor, message);
    return editor;
  }

  async #action(action: Action): Promise<void> {
    const entry = this.#entry();
    if (!entry) {
      return this.#loseSelection();
    }
    if (action === "back") {
      return this.#back();
    }
    if (action === "stop") {
      return this.#stop(entry);
    }
    const inspection = entry.runtime.inspect(entry.snapshot.id);
    if (action === "result") {
      if (!hasResult(inspection)) {
        return this.#warning("Result is no longer available.");
      }
      this.#mode = "result";
      this.#resultScroll = new ScrollViewport({
        content: resultComponent(inspection!, this.theme),
        viewportHeight: 24,
      });
    } else {
      this.#mode = "activity";
      this.#activityScroll = new ScrollViewport({
        content: new TimelineComponent(inspection!, this.theme),
        viewportHeight: 20,
      });
      this.#guidance = eligibleGuidance(entry)
        ? this.#makeGuidance(entry)
        : undefined;
      if (this.#guidance) {
        this.#guidance.focused = this.#focused;
      }
    }
    this.tui.requestRender();
  }

  async #sendGuidance(
    entry: Entry,
    editor: Editor,
    submitted: string,
  ): Promise<void> {
    const message = submitted.trim();
    if (!message || !eligibleGuidance(entry)) {
      return;
    }
    const generation = this.#generation;
    const current = this.#entry();
    if (
      !current ||
      !this.#operationIsCurrent(entry, generation) ||
      !eligibleGuidance(current)
    ) {
      return this.#warning("Guidance was not delivered; agent state changed.");
    }
    try {
      await current.runtime.steer(current.snapshot.id, message);
      if (this.#operationIsCurrent(entry, generation)) {
        editor.setText("");
      }
    } catch {
      if (this.#operationIsCurrent(entry, generation)) {
        this.#warning("Guidance was not delivered; agent state changed.");
      }
    }
  }

  async #stop(entry: Entry): Promise<void> {
    if (!eligibleStop(entry)) {
      return this.#warning("Agent already settled or is no longer available.");
    }
    const generation = this.#generation;
    const confirmed = await this.ctx.ui.confirm(
      "Stop agent",
      "Stop this running agent?",
    );
    if (!confirmed) {
      return;
    }
    const current = this.#entry();
    if (
      !current ||
      !this.#operationIsCurrent(entry, generation) ||
      !eligibleStop(current)
    ) {
      return this.#warning("Agent already settled or is no longer available.");
    }
    try {
      current.runtime.stop(current.snapshot.id);
    } catch {
      this.#warning("Agent already settled or is no longer available.");
    }
  }

  #warning(message: string): void {
    this.ctx.ui.notify(message, "warning");
    this.#refresh();
  }

  #back(): void {
    const value = this.#selected?.value;
    const position = this.#rosterPosition;
    this.#generation += 1;
    this.#selected = undefined;
    this.#mode = "roster";
    this.#actions = undefined;
    this.#activityScroll = undefined;
    this.#resultScroll = undefined;
    this.#guidance = undefined;
    this.#roster = this.#replaceRoster(value, position);
    this.tui.requestRender();
  }

  #close(): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    this.#generation += 1;
    for (const unsubscribe of this.#unsubscribers.splice(0)) {
      unsubscribe();
    }
    this.done();
  }
}

function rosterPrefix(entry: Entry): string {
  return `${"  ".repeat(Math.min(entry.depth, 3))}${entry.depth ? "└ " : ""}${glyph(entry.snapshot.status)} `;
}

function rosterItem(
  entry: Entry,
  theme: Theme,
  prefixWidth: number,
  typeWidth: number,
): WideListItem<Entry> {
  return {
    kind: "item",
    value: entry.value,
    data: entry,
    prefix: rosterPrefix(entry),
    prefixWidth,
    fixed: [{ text: displayType(entry.snapshot), width: typeWidth }],
    elastic: bounded(entry.snapshot.description, 180),
    right: duration(entry.snapshot),
    elasticStyle: (text) => theme.fg("muted", text),
    rightStyle: (text) => theme.fg("muted", text),
  };
}

function landingLines(snapshot: RuntimeSnapshot): string[] {
  const context = snapshot.health?.contextUsage?.tokens;
  const cost = snapshot.health?.estimatedCost;
  return [
    bounded(snapshot.description, 240),
    "",
    [
      snapshot.status,
      duration(snapshot),
      context === undefined || context === null
        ? undefined
        : `${formatCompactTokens(context)} context`,
      cost === undefined || !Number.isFinite(cost)
        ? undefined
        : formatUsdCost(cost),
    ]
      .filter((value): value is string => Boolean(value))
      .join(" · "),
    ...(snapshot.status === "failed" && snapshot.error
      ? [`Failure: ${bounded(snapshot.error, 240)}`]
      : []),
  ];
}

class TimelineComponent implements Component {
  constructor(
    private readonly inspection: RuntimeInspection,
    private readonly theme: Theme,
  ) {}

  render(width: number): string[] {
    const lines: string[] = [];
    for (const record of this.inspection.records) {
      if (record.kind === "message") {
        if (record.role === "assistant") {
          if (lines.length > 0) {
            lines.push("");
          }
          lines.push(
            ...new Markdown(
              record.text,
              0,
              0,
              markdownTheme(this.theme),
            ).render(width),
          );
          lines.push("");
        }
        continue;
      }
      if (record.kind === "tool") {
        lines.push(...toolLines(record, this.theme, width));
      } else if (record.kind === "steering") {
        lines.push(
          this.theme.fg(
            "muted",
            truncateToWidth(`> ${bounded(record.text, 300)}`, width),
          ),
        );
      } else if (record.kind === "retry") {
        lines.push(
          this.theme.fg(
            "warning",
            truncateToWidth(
              `↻ Retry ${record.status}${record.error ? ` · ${bounded(record.error, 180)}` : ""}`,
              width,
            ),
          ),
        );
      } else {
        lines.push(
          this.theme.fg(
            "muted",
            truncateToWidth(
              `↻ Compaction ${record.status}${record.reason ? ` · ${record.reason}` : ""}${record.error ? ` · ${bounded(record.error, 180)}` : ""}`,
              width,
            ),
          ),
        );
      }
    }
    if (
      this.inspection.omittedMessages ||
      this.inspection.omittedActivity ||
      this.inspection.compactedHistory
    ) {
      lines.push(
        this.theme.fg(
          "muted",
          `Earlier activity omitted: ${this.inspection.omittedMessages + this.inspection.omittedActivity}${this.inspection.compactedHistory ? " · compacted history" : ""}`,
        ),
      );
    }
    return lines.length > 0
      ? lines
      : [this.theme.fg("muted", "No activity yet.")];
  }

  invalidate(): void {}
}

function toolLines(
  tool: Extract<RuntimeInspection["activity"][number], { kind: "tool" }>,
  theme: Theme,
  width: number,
): string[] {
  const status =
    tool.status === "running"
      ? "●"
      : tool.status === "failed"
        ? "×"
        : tool.status === "interrupted"
          ? "■"
          : "✓";
  const details = toolArguments(tool.toolName, tool.arguments);
  const title = `  ${status} ${tool.toolName}`;
  const suffix = ` · ${tool.status}`;
  const detail = details
    ? truncateToWidth(
        details,
        Math.max(0, width - visibleWidth(title) - visibleWidth(suffix) - 2),
      )
    : "";
  const lines = [
    truncateToWidth(
      `${theme.fg("toolTitle", title)}${detail ? theme.fg("muted", `  ${detail}`) : ""}${theme.fg("muted", suffix)}`,
      width,
    ),
  ];
  if (tool.status === "failed" && tool.error) {
    lines.push(
      theme.fg(
        "error",
        truncateToWidth(`    ${bounded(tool.error, 240)}`, width),
      ),
    );
  }
  return lines;
}

function resultComponent(
  inspection: RuntimeInspection,
  theme: Theme,
): Component {
  const result = inspection.records.find(
    (record): record is Extract<typeof record, { kind: "message" }> =>
      record.kind === "message" && record.role === "final",
  );
  return new Markdown(
    result?.text ?? "Result is unavailable.",
    0,
    0,
    markdownTheme(theme),
  );
}

function hasResult(inspection: RuntimeInspection | undefined): boolean {
  return (
    inspection?.records.some(
      (record) => record.kind === "message" && record.role === "final",
    ) ?? false
  );
}

function toolArguments(
  name: string,
  value: InspectionToolArguments | undefined,
): string | undefined {
  if (!value) {
    return undefined;
  }
  if (name === "read" && typeof value.path === "string") {
    return toolSummaryArgument(
      `${value.path}${typeof value.offset === "number" || typeof value.limit === "number" ? ` · lines ${value.offset ?? "?"}–${value.limit ?? "?"}` : ""}`,
    );
  }
  if (name === "grep" || name === "find") {
    return toolSummaryArgument(
      [
        typeof value.pattern === "string" ? value.pattern : undefined,
        typeof value.path === "string" ? value.path : undefined,
      ]
        .filter(Boolean)
        .join(" · "),
    );
  }
  if (name === "bash" && typeof value.command === "string") {
    return toolSummaryArgument(value.command);
  }
  if ((name === "edit" || name === "write") && typeof value.path === "string") {
    return toolSummaryArgument(value.path);
  }
  return undefined;
}

function toolSummaryArgument(value: string): string | undefined {
  const normalized = bounded(value, 240);
  return normalized || undefined;
}

function duration(snapshot: RuntimeSnapshot): string {
  const started = Date.parse(
    snapshot.timestamps.startedAt ?? snapshot.timestamps.queuedAt,
  );
  const ended = Date.parse(
    snapshot.timestamps.completedAt ?? new Date().toISOString(),
  );
  return Number.isFinite(started) && Number.isFinite(ended)
    ? formatDuration(ended - started)
    : "unknown";
}

function displayType(snapshot: RuntimeSnapshot | undefined): string {
  if (!snapshot) {
    return "Agent";
  }
  if (
    typeof snapshot.owner === "object" &&
    snapshot.owner.kind === "pipkin:implement"
  ) {
    const roles = {
      planner: "Planner",
      implementer: "Implementer",
      reviewer: "Reviewer",
    } as const;
    return `Implement: ${roles[snapshot.owner.role]}`;
  }
  return bounded(snapshot.type, 80);
}

function snapshotKey(
  runtime: SubagentRuntime,
  snapshot: RuntimeSnapshot,
): string {
  return snapshot.key ?? `${runtime.scope}:${snapshot.id}`;
}

function nestedParent(snapshot: RuntimeSnapshot): string | undefined {
  return typeof snapshot.owner === "object" && snapshot.owner.kind === "nested"
    ? snapshot.owner.parentId
    : undefined;
}

function glyph(status: RuntimeSnapshot["status"]): string {
  return {
    queued: "○",
    running: "●",
    completed: "✓",
    failed: "×",
    stopped: "■",
  }[status];
}

function actionLabel(action: Action): string {
  return {
    activity: "View activity",
    result: "View result",
    stop: "Stop agent",
    back: "Back",
  }[action];
}

function eligibleGuidance(entry: Entry): boolean {
  const current = entry.runtime.snapshot(entry.snapshot.id);
  return (
    current !== undefined &&
    snapshotKey(entry.runtime, current) === entry.key &&
    current.status === "running" &&
    current.canSteer === true
  );
}

function eligibleStop(entry: Entry): boolean {
  const current = entry.runtime.snapshot(entry.snapshot.id);
  return (
    current !== undefined &&
    snapshotKey(entry.runtime, current) === entry.key &&
    current.status === "running"
  );
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

function markdownTheme(theme: Theme) {
  return {
    heading: (text: string) => theme.bold(text),
    link: (text: string) => theme.fg("accent", text),
    linkUrl: (text: string) => theme.fg("muted", text),
    code: (text: string) => theme.fg("accent", text),
    codeBlock: (text: string) => text,
    codeBlockBorder: (text: string) => theme.fg("muted", text),
    quote: (text: string) => text,
    quoteBorder: (text: string) => theme.fg("muted", text),
    hr: (text: string) => theme.fg("muted", text),
    listBullet: (text: string) => text,
    bold: (text: string) => theme.bold(text),
    italic: (text: string) => text,
    strikethrough: (text: string) => text,
    underline: (text: string) => text,
  };
}

function editorTheme(theme: Theme): EditorTheme {
  return {
    borderColor: (text) => theme.fg("border", text),
    selectList: {
      selectedPrefix: (text) => text,
      selectedText: (text) => text,
      description: (text) => text,
      scrollInfo: (text) => text,
      noMatch: (text) => text,
    },
  };
}

function bounded(value: string | undefined, maximum = 600): string {
  return (value ?? "")
    .replace(/\p{C}/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maximum);
}
