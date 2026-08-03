import type {
  ExtensionCommandContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import {
  Markdown,
  matchesKey,
  SelectList,
  type Component,
  type TUI,
  truncateToWidth,
} from "@earendil-works/pi-tui";
import { Panel } from "#lib/ui/panel";
import {
  formatCompactTokens,
  formatDuration,
  formatUsdCost,
} from "#lib/ui/metrics";
import type { InspectionToolArguments } from "./inspection.js";
import type {
  RuntimeInspection,
  RuntimeSnapshot,
  SubagentRuntime,
} from "./runtime.js";

const terminal = new Set(["completed", "failed", "stopped"]);
type Action = "details" | "summary" | "guidance" | "stop" | "back";
type Selection = { runtime: SubagentRuntime; key: string; value: string };
type Entry = Selection & {
  snapshot: RuntimeSnapshot;
  depth: number;
  section: "active" | "retained";
};
type Summary =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "result"; text: string }
  | { kind: "error"; text: string };

export async function showAgentsSurface(
  input: SubagentRuntime | readonly SubagentRuntime[],
  ctx: ExtensionCommandContext,
): Promise<void> {
  const runtimes = [...new Set(Array.isArray(input) ? input : [input])];
  await ctx.ui.custom<void>(
    (tui, theme, _keys, done) =>
      new AgentsSurface(runtimes, ctx, tui, theme, done),
  );
}

export class AgentsSurface implements Component {
  #selected: Selection | undefined;
  #mode: "roster" | "inspector" = "roster";
  #roster: SelectList;
  #rosterEntries: Entry[] = [];
  #rosterPosition = 0;
  #actions: SelectList | undefined;
  #actionValues: Action[] = [];
  #details = false;
  #summary: Summary = { kind: "idle" };
  #abort: AbortController | undefined;
  #generation = 0;
  #disposed = false;
  #unsubscribers: (() => void)[];
  #contentOffset = 0;
  #focus: "actions" | "content" = "actions";
  #expandedTools = new Set<string>();
  #inspectionPane: InspectionPane | undefined;
  #lastLost: string | undefined;

  constructor(
    private readonly runtimes: SubagentRuntime[],
    private readonly ctx: ExtensionCommandContext,
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly done: () => void,
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
    this.#inspectionPane?.invalidate();
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
      } else if (matchesKey(data, "e")) {
        const key = this.#inspectionPane?.expansionKeyAt(this.#contentOffset);
        if (key) {
          if (this.#expandedTools.has(key)) {
            this.#expandedTools.delete(key);
          } else {
            this.#expandedTools.add(key);
          }
          this.#inspectionPane?.setExpanded(this.#expandedTools);
        }
      } else {
        return;
      }
      this.tui.requestRender();
      return;
    }
    (this.#mode === "roster" ? this.#roster : this.#actions)?.handleInput(data);
  }

  render(width: number): string[] {
    if (this.#mode === "inspector" && !this.#entry()) {
      this.#loseSelection();
    }
    const child =
      this.#mode === "roster" ? this.#roster : this.#inspectorComponent();
    return new Panel({
      theme: this.theme,
      title: this.#mode === "roster" ? "Agents" : "Agent inspector",
      subtitle:
        this.#mode === "roster"
          ? "Active and retained agents"
          : this.#focus === "actions"
            ? "Actions focused · Tab: content"
            : "Content focused · Tab: actions · ↑↓: scroll · e: expand tool",
      footer:
        this.#mode === "roster"
          ? "Enter: inspect · Esc: close"
          : "Enter: action · Esc: back",
      child,
    }).render(width);
  }

  #entries(): Entry[] {
    const flattened: Entry[] = [];
    for (const [runtimeIndex, runtime] of this.runtimes.entries()) {
      const entries = runtime
        .snapshots({ includeNested: true })
        .map((snapshot) => {
          const key = snapshotKey(runtime, snapshot);
          return {
            runtime,
            key,
            value: `${runtimeIndex}:${key}`,
            snapshot,
            depth: 0,
            section: terminal.has(snapshot.status)
              ? ("retained" as const)
              : ("active" as const),
          };
        });
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
      const add = (entry: Entry, depth: number) => {
        if (seen.has(entry)) {
          return;
        }
        seen.add(entry);
        flattened.push({ ...entry, depth });
        for (const child of children.get(entry.snapshot.id) ?? []) {
          add(child, depth + 1);
        }
      };
      for (const root of roots) {
        add(root, 0);
      }
      for (const entry of entries) {
        add(entry, 0);
      }
    }
    return [
      ...flattened.filter((entry) => entry.section === "active"),
      ...flattened.filter((entry) => entry.section === "retained"),
    ];
  }

  #replaceRoster(
    preferredValue: string | undefined,
    preferredIndex: number,
  ): SelectList {
    const entries = this.#entries();
    this.#rosterEntries = entries;
    const list = new SelectList(
      entries.map((entry, index) => ({
        value: entry.value,
        label: `${sectionPrefix(entries, index)}${"  ".repeat(Math.min(entry.depth, 3))}${entry.depth ? "↳ " : ""}${rosterLabel(entry.snapshot)}`,
        description: rosterMetrics(entry.snapshot),
      })),
      12,
      selectTheme(this.theme),
    );
    list.onSelect = (item) => {
      const index = this.#rosterEntries.findIndex(
        (entry) => entry.value === item.value,
      );
      const entry = this.#rosterEntries[index];
      if (entry) {
        this.#openInspector(entry, index);
      }
    };
    if (entries.length > 0) {
      const stableIndex = entries.findIndex(
        (entry) => entry.value === preferredValue,
      );
      const nextIndex =
        stableIndex >= 0
          ? stableIndex
          : Math.min(Math.max(0, preferredIndex), entries.length - 1);
      list.setSelectedIndex(nextIndex);
      this.#rosterPosition = nextIndex;
    } else {
      this.#rosterPosition = 0;
    }
    return list;
  }

  #openInspector(entry: Entry, rosterPosition: number): void {
    this.#cancelPending();
    this.#selected = {
      runtime: entry.runtime,
      key: entry.key,
      value: entry.value,
    };
    this.#rosterPosition = rosterPosition;
    this.#lastLost = undefined;
    this.#mode = "inspector";
    this.#details = false;
    this.#summary = { kind: "idle" };
    this.#contentOffset = 0;
    this.#focus = "actions";
    this.#actions = undefined;
    this.#actionValues = [];
    this.#makeActions();
    this.#rebuildInspection();
    this.tui.requestRender();
  }

  #entry(entries = this.#entries()): Entry | undefined {
    if (!this.#selected) {
      return undefined;
    }
    return entries.find(
      (entry) =>
        entry.runtime === this.#selected?.runtime &&
        entry.key === this.#selected.key,
    );
  }

  #operationIsCurrent(entry: Entry, generation: number): boolean {
    return (
      this.#mode === "inspector" &&
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
      const selectedValue = this.#roster.getSelectedItem()?.value;
      const oldIndex = Math.max(
        0,
        this.#rosterEntries.findIndex((entry) => entry.value === selectedValue),
      );
      const nextEntries = this.#entries();
      if (
        selectedValue &&
        !nextEntries.some((entry) => entry.value === selectedValue)
      ) {
        this.#notifySelectionLoss(selectedValue);
      }
      this.#roster = this.#replaceRoster(selectedValue, oldIndex);
    } else {
      const entries = this.#entries();
      const entry = this.#entry(entries);
      if (!entry) {
        this.#loseSelection();
        return;
      }
      this.#rosterPosition = entries.findIndex(
        (candidate) => candidate.value === entry.value,
      );
      this.#makeActions();
      this.#rebuildInspection(entry);
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
    this.#cancelPending();
    this.#selected = undefined;
    this.#mode = "roster";
    this.#contentOffset = 0;
    this.#inspectionPane = undefined;
    this.#roster = this.#replaceRoster(lost, position);
    this.tui.requestRender();
  }

  #makeActions(): void {
    const snapshot = this.#entry()?.snapshot;
    if (!snapshot) {
      return;
    }
    const values: Action[] = ["details", "summary"];
    if (snapshot.status === "running" && snapshot.canSteer) {
      values.push("guidance");
    }
    if (snapshot.status === "running") {
      values.push("stop");
    }
    values.push("back");
    if (values.join("|") === this.#actionValues.join("|")) {
      return;
    }
    const selectedValue = this.#actions?.getSelectedItem()?.value as
      | Action
      | undefined;
    const oldIndex = Math.max(0, this.#actionValues.indexOf(selectedValue!));
    this.#actionValues = values;
    this.#actions = new SelectList(
      values.map((value) => ({ value, label: actionLabel(value) })),
      8,
      selectTheme(this.theme),
    );
    this.#actions.onSelect = (item) => void this.#action(item.value as Action);
    const stableIndex = selectedValue ? values.indexOf(selectedValue) : -1;
    this.#actions.setSelectedIndex(
      stableIndex >= 0 ? stableIndex : Math.min(oldIndex, values.length - 1),
    );
  }

  #rebuildInspection(entry = this.#entry()): void {
    const inspection = entry?.runtime.inspect(entry.snapshot.id);
    if (!entry || !inspection) {
      this.#inspectionPane = undefined;
      return;
    }
    if (
      !this.#inspectionPane ||
      this.#inspectionPane.identity !== entry.value
    ) {
      this.#inspectionPane = new InspectionPane(
        entry.value,
        inspection,
        this.#details,
        this.#summary,
        this.tui,
        this.theme,
        this.#expandedTools,
      );
      return;
    }
    this.#inspectionPane.update(
      inspection,
      this.#details,
      this.#summary,
      this.#expandedTools,
    );
  }

  #inspectorComponent(): Component {
    const content =
      this.#inspectionPane ?? textComponent(["Agent is no longer available."]);
    return {
      render: (width) => {
        const sidebarWidth = Math.min(28, Math.max(10, Math.floor(width / 3)));
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
          (_, index) => {
            const separator = this.#focus === "actions" ? " │ " : " · ";
            return `${truncateToWidth(actions[index] ?? "", sidebarWidth, "…", false)}${separator}${truncateToWidth(visible[index] ?? "", contentWidth, "…", false)}`;
          },
        );
      },
      invalidate: () => {
        this.#actions?.invalidate();
        content.invalidate();
      },
    };
  }

  async #action(action: Action): Promise<void> {
    const entry = this.#entry();
    if (!entry) {
      this.#loseSelection();
      return;
    }
    if (action === "back") {
      this.#back();
      return;
    }
    if (action === "details") {
      this.#details = !this.#details;
      this.#rebuildInspection(entry);
      this.tui.requestRender();
      return;
    }
    if (action === "guidance") {
      await this.#sendGuidance(entry);
      return;
    }
    if (action === "stop") {
      await this.#stop(entry);
      return;
    }
    await this.#summarise(entry);
  }

  async #sendGuidance(entry: Entry): Promise<void> {
    if (!eligibleGuidance(entry)) {
      this.#warning("Guidance is no longer available for this agent.");
      return;
    }
    const generation = this.#generation;
    const message = await this.ctx.ui.input(
      "Guidance (cooperatively queued after current tool calls)",
    );
    if (!message?.trim()) {
      return;
    }
    const current = this.#entry();
    if (
      !current ||
      !this.#operationIsCurrent(entry, generation) ||
      !eligibleGuidance(current)
    ) {
      if (this.#operationIsCurrent(entry, generation)) {
        this.#warning("Guidance was not delivered; agent state changed.");
      }
      return;
    }
    try {
      await current.runtime.steer(current.snapshot.id, message);
    } catch {
      if (this.#operationIsCurrent(entry, generation)) {
        this.#warning("Guidance was not delivered; agent state changed.");
      }
    }
  }

  async #stop(entry: Entry): Promise<void> {
    if (!eligibleStop(entry)) {
      this.#warning("Stop is no longer available for this agent.");
      return;
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
      if (this.#operationIsCurrent(entry, generation)) {
        this.#warning("Agent already settled before it could be stopped.");
      }
      return;
    }
    try {
      current.runtime.stop(current.snapshot.id);
    } catch {
      if (this.#operationIsCurrent(entry, generation)) {
        this.#warning("Agent already settled before it could be stopped.");
      }
    }
  }

  async #summarise(entry: Entry): Promise<void> {
    this.#abort?.abort();
    const controller = new AbortController();
    const generation = ++this.#generation;
    this.#abort = controller;
    this.#summary = { kind: "loading" };
    this.#rebuildInspection(entry);
    this.tui.requestRender();
    if (!this.ctx.model) {
      this.#setSummary(entry, generation, controller, {
        kind: "error",
        text: "No active model. Set a model first.",
      });
      return;
    }
    const auth = await this.ctx.modelRegistry.getApiKeyAndHeaders(
      this.ctx.model,
    );
    if (!this.#operationIsCurrent(entry, generation)) {
      return;
    }
    if (!auth.ok) {
      this.#setSummary(entry, generation, controller, {
        kind: "error",
        text: bounded(auth.error ?? "Unable to authenticate for a summary."),
      });
      return;
    }
    try {
      const result = await entry.runtime.summarise(
        entry.snapshot.id,
        this.ctx.model,
        { apiKey: auth.apiKey, headers: auth.headers, env: auth.env },
        undefined,
        controller.signal,
      );
      this.#setSummary(
        entry,
        generation,
        controller,
        result.ok
          ? { kind: "result", text: bounded(result.text) }
          : {
              kind: "error",
              text: bounded(result.message ?? "Unable to summarise activity."),
            },
      );
    } catch {
      this.#setSummary(entry, generation, controller, {
        kind: "error",
        text: "Unable to summarise activity.",
      });
    }
  }

  #setSummary(
    entry: Entry,
    generation: number,
    controller: AbortController,
    summary: Summary,
  ): void {
    if (
      this.#abort !== controller ||
      controller.signal.aborted ||
      !this.#operationIsCurrent(entry, generation)
    ) {
      return;
    }
    this.#abort = undefined;
    this.#summary = summary;
    this.#rebuildInspection();
    this.tui.requestRender();
  }

  #warning(message: string): void {
    this.ctx.ui.notify(message, "warning");
    this.#refresh();
  }

  #cancelPending(): void {
    this.#generation += 1;
    this.#abort?.abort();
    this.#abort = undefined;
  }

  #back(): void {
    const value = this.#selected?.value;
    const position = this.#rosterPosition;
    this.#cancelPending();
    this.#selected = undefined;
    this.#mode = "roster";
    this.#contentOffset = 0;
    this.#inspectionPane = undefined;
    this.#roster = this.#replaceRoster(value, position);
    this.tui.requestRender();
  }

  #close(): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    this.#cancelPending();
    this.#inspectionPane = undefined;
    this.#expandedTools.clear();
    for (const unsubscribe of this.#unsubscribers.splice(0)) {
      unsubscribe();
    }
    this.done();
  }
}

function sectionPrefix(entries: readonly Entry[], index: number): string {
  const entry = entries[index];
  if (!entry || (index > 0 && entries[index - 1]?.section === entry.section)) {
    return "";
  }
  return entry.section === "active" ? "Active · " : "Retained · ";
}

function rosterLabel(snapshot: RuntimeSnapshot): string {
  return `${glyph(snapshot.status)} ${displayType(snapshot)} · ${bounded(snapshot.description, 180)}`;
}

function rosterMetrics(snapshot: RuntimeSnapshot): string {
  const started = Date.parse(
    snapshot.timestamps.startedAt ?? snapshot.timestamps.queuedAt,
  );
  const ended = Date.parse(
    snapshot.timestamps.completedAt ?? new Date().toISOString(),
  );
  const elapsed =
    Number.isFinite(started) && Number.isFinite(ended)
      ? formatDuration(ended - started)
      : "unknown";
  const turns = snapshot.health?.turns;
  const context = snapshot.health?.contextUsage?.tokens;
  const cost = snapshot.health?.estimatedCost;
  return [
    elapsed,
    turns === undefined ? undefined : `${turns} turns`,
    context === undefined || context === null
      ? undefined
      : `${formatCompactTokens(context)} context`,
    cost === undefined || !Number.isFinite(cost)
      ? undefined
      : formatUsdCost(cost),
  ]
    .filter((part): part is string => Boolean(part))
    .join(" · ");
}

function displayType(snapshot: RuntimeSnapshot): string {
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
    details: "View / Hide details",
    summary: "Summarise activity",
    guidance: "Send guidance",
    stop: "Stop",
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

type PanePart = { component: Component; expansionKey?: string };
type ToolRange = { key: string; start: number; end: number };

class InspectionPane implements Component {
  #parts: PanePart[] = [];
  #tools = new Map<string, ToolExecutionComponent>();
  #toolOrder: string[] = [];
  #toolRanges: ToolRange[] = [];

  constructor(
    readonly identity: string,
    inspection: RuntimeInspection,
    details: boolean,
    summary: Summary,
    private readonly tui: TUI,
    private readonly theme: Theme,
    expanded: ReadonlySet<string>,
  ) {
    this.update(inspection, details, summary, expanded);
  }

  update(
    inspection: RuntimeInspection,
    details: boolean,
    summary: Summary,
    expanded: ReadonlySet<string>,
  ): void {
    const summaryLines =
      summary.kind === "idle"
        ? []
        : [
            summary.kind === "loading"
              ? "Summary: loading…"
              : `Summary: ${summary.text}`,
          ];
    const header = [
      `${glyph(inspection.snapshot.status)} ${displayType(inspection.snapshot)}`,
      bounded(inspection.snapshot.description),
      rosterMetrics(inspection.snapshot),
      ...summaryLines,
      ...(details
        ? [
            `Model: ${bounded(inspection.snapshot.model ?? "unknown", 120)}`,
            `Retained: ${inspection.omittedMessages + inspection.omittedActivity ? `${inspection.omittedMessages + inspection.omittedActivity} records omitted` : "complete window"}`,
          ]
        : []),
    ];
    const parts: PanePart[] = [{ component: textComponent(header) }];
    const seenTools = new Set<string>();
    const duplicateCalls = new Map<string, number>();
    for (const item of chronologicalItems(inspection)) {
      if (item.kind === "assistant") {
        parts.push({
          component: new Markdown(item.text, 0, 0, markdownTheme(this.theme)),
        });
      } else if (item.kind === "final") {
        parts.push({
          component: styledTextComponent([`Final: ${item.text}`], (line) =>
            this.theme.bold(line),
          ),
        });
      } else if (item.kind === "user") {
        parts.push({
          component: styledTextComponent([`User: ${item.text}`], (line) =>
            this.theme.bold(line),
          ),
        });
      } else if (item.kind === "tool") {
        const occurrence = duplicateCalls.get(item.toolCallId) ?? 0;
        duplicateCalls.set(item.toolCallId, occurrence + 1);
        const expansionKey = `${this.identity}\u0000${item.toolCallId}\u0000${occurrence}`;
        const argumentsValue = nativeToolArguments(
          item.toolName,
          item.arguments,
        );
        if (argumentsValue) {
          let tool = this.#tools.get(expansionKey);
          if (!tool) {
            tool = new ToolExecutionComponent(
              item.toolName,
              item.toolCallId,
              argumentsValue,
              undefined,
              undefined,
              this.tui,
              inspection.snapshot.cwd,
            );
            this.#tools.set(expansionKey, tool);
          } else {
            tool.updateArgs(argumentsValue);
          }
          if (item.status !== "running") {
            const output = item.result ?? item.error;
            tool.updateResult({
              content: output ? [{ type: "text", text: output }] : [],
              isError:
                item.status === "failed" || item.status === "interrupted",
            });
          }
          tool.setExpanded(expanded.has(expansionKey));
          seenTools.add(expansionKey);
          parts.push({ component: tool, expansionKey });
        } else {
          parts.push({ component: textComponent([fallbackToolLine(item)]) });
        }
      } else {
        parts.push({ component: textComponent([activityLine(item)]) });
      }
    }
    if (
      inspection.omittedMessages ||
      inspection.omittedActivity ||
      inspection.compactedHistory
    ) {
      parts.push({
        component: textComponent([
          `Retention: ${inspection.omittedMessages + inspection.omittedActivity} records omitted${inspection.compactedHistory ? " · compacted history" : ""}`,
        ]),
      });
    }
    for (const key of this.#tools.keys()) {
      if (!seenTools.has(key)) {
        this.#tools.delete(key);
      }
    }
    this.#parts = parts;
    this.#toolOrder = parts.flatMap((part) =>
      part.expansionKey ? [part.expansionKey] : [],
    );
    this.#toolRanges = [];
  }

  setExpanded(expanded: ReadonlySet<string>): void {
    for (const [key, tool] of this.#tools) {
      tool.setExpanded(expanded.has(key));
    }
    this.#toolRanges = [];
  }

  expansionKeyAt(offset: number): string | undefined {
    const containing = this.#toolRanges.find(
      (range) => offset >= range.start && offset <= range.end,
    );
    if (containing) {
      return containing.key;
    }
    return (
      this.#toolRanges.find((range) => range.start >= offset)?.key ??
      this.#toolRanges.at(-1)?.key ??
      this.#toolOrder[0]
    );
  }

  invalidate(): void {
    for (const part of this.#parts) {
      part.component.invalidate();
    }
    this.#toolRanges = [];
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    const lines: string[] = [];
    const ranges: ToolRange[] = [];
    for (const part of this.#parts) {
      const start = lines.length;
      const rendered = part.component
        .render(safeWidth)
        .map((line) => truncateToWidth(line, safeWidth, "…", false));
      lines.push(...rendered);
      if (part.expansionKey && rendered.length > 0) {
        ranges.push({
          key: part.expansionKey,
          start,
          end: lines.length - 1,
        });
      }
    }
    this.#toolRanges = ranges;
    return lines;
  }
}

type TimelineItem =
  | { kind: "user"; text: string; timestamp?: string }
  | { kind: "assistant"; text: string; timestamp?: string }
  | { kind: "final"; text: string; timestamp?: string }
  | RuntimeInspection["activity"][number];

function chronologicalItems(inspection: RuntimeInspection): TimelineItem[] {
  return inspection.records.map((record) => {
    if (record.kind !== "message") {
      return record;
    }
    return {
      kind: record.role,
      text: bounded(record.text),
      ...(record.timestamp === undefined
        ? {}
        : { timestamp: record.timestamp }),
    };
  });
}

function activityLine(
  item: Exclude<RuntimeInspection["activity"][number], { kind: "tool" }>,
): string {
  if (item.kind === "steering") {
    return `Guidance ${item.status}: ${bounded(item.text)}`;
  }
  if (item.kind === "retry") {
    return `Retry ${item.status}${item.error ? `: ${bounded(item.error)}` : ""}`;
  }
  return `Compaction ${item.status}${item.reason ? `: ${item.reason}` : ""}${item.error ? ` · ${bounded(item.error)}` : ""}`;
}

function fallbackToolLine(
  item: Extract<RuntimeInspection["activity"][number], { kind: "tool" }>,
): string {
  const reason =
    item.toolName === "edit" || item.toolName === "write"
      ? "body omitted"
      : "native replay unavailable";
  return `Tool ${bounded(item.toolName)}: ${item.status} · ${reason}`;
}

function nativeToolArguments(
  name: string,
  value: InspectionToolArguments | undefined,
): Record<string, unknown> | undefined {
  if (!value) {
    return undefined;
  }
  if (name === "read" && typeof value.path === "string") {
    return compactObject({
      path: value.path,
      offset: numberArgument(value.offset),
      limit: numberArgument(value.limit),
    });
  }
  if (name === "grep" && typeof value.pattern === "string") {
    return compactObject({
      pattern: value.pattern,
      path: stringArgument(value.path),
      glob: stringArgument(value.glob),
      ignoreCase: booleanArgument(value.ignoreCase),
      literal: booleanArgument(value.literal),
      context: numberArgument(value.context),
      limit: numberArgument(value.limit),
    });
  }
  if (name === "find" && typeof value.pattern === "string") {
    return compactObject({
      pattern: value.pattern,
      path: stringArgument(value.path),
      limit: numberArgument(value.limit),
    });
  }
  if (name === "bash" && typeof value.command === "string") {
    return compactObject({
      command: value.command,
      timeout: numberArgument(value.timeout),
    });
  }
  return undefined;
}

function compactObject(
  value: Record<string, string | number | boolean | undefined>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter((entry) => entry[1] !== undefined),
  );
}

function stringArgument(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberArgument(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function booleanArgument(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
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

function styledTextComponent(
  lines: readonly string[],
  style: (line: string) => string,
): Component {
  return {
    render: (width) =>
      lines.map((line) =>
        truncateToWidth(style(line), Math.max(1, width), "…", false),
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

function selectTheme(theme: Theme) {
  return {
    selectedPrefix: (text: string) => theme.fg("accent", text),
    selectedText: (text: string) => theme.bold(text),
    description: (text: string) => theme.fg("muted", text),
    scrollInfo: (text: string) => theme.fg("muted", text),
    noMatch: (text: string) => theme.fg("muted", text),
  };
}

function bounded(value: string, maximum = 600): string {
  return value
    .replace(/\p{C}/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maximum);
}
