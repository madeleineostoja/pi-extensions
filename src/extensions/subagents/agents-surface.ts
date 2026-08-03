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
  #lastLost: string | undefined;

  constructor(
    private readonly runtimes: SubagentRuntime[],
    private readonly ctx: ExtensionCommandContext,
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly done: () => void,
  ) {
    this.#roster = this.#newRoster();
    this.#unsubscribers = runtimes.map((runtime) =>
      runtime.subscribeSnapshots(() => this.#refresh()),
    );
  }

  dispose(): void {
    this.#close();
  }

  invalidate(): void {
    if (!this.#disposed) {
      this.tui.requestRender();
    }
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
        const key = this.#entry()?.value;
        if (key) {
          this.#expandedTools.has(key)
            ? this.#expandedTools.delete(key)
            : this.#expandedTools.add(key);
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
    const selected = this.#entry();
    if (this.#mode === "inspector" && !selected) {
      this.#loseSelection();
    }
    const child =
      this.#mode === "roster" ? this.#roster : this.#inspector(this.#entry());
    return new Panel({
      theme: this.theme,
      title: this.#mode === "roster" ? "Agents" : "Agent inspector",
      subtitle:
        this.#mode === "roster"
          ? "Active and retained agents"
          : this.#focus === "actions"
            ? "Actions focused · Tab: content"
            : "Content focused · Tab: actions · ↑↓: scroll",
      footer:
        this.#mode === "roster"
          ? "Enter: inspect · Esc: close"
          : "Enter: action · Esc: back",
      child,
    }).render(width);
  }

  #entries(): Entry[] {
    const all = this.runtimes.flatMap((runtime, runtimeIndex) =>
      runtime.snapshots({ includeNested: true }).map((snapshot) => {
        const key = snapshot.key ?? `${runtime.scope}:${snapshot.id}`;
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
      }),
    );
    const byRuntime = new Map<SubagentRuntime, Entry[]>();
    for (const entry of all) {
      const entries = byRuntime.get(entry.runtime) ?? [];
      entries.push(entry);
      byRuntime.set(entry.runtime, entries);
    }
    const compare = (left: Entry, right: Entry) =>
      Number(terminal.has(left.snapshot.status)) -
        Number(terminal.has(right.snapshot.status)) ||
      left.key.localeCompare(right.key);
    const flattened: Entry[] = [];
    for (const entries of byRuntime.values()) {
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
      const add = (
        entry: Entry,
        depth: number,
        section: "active" | "retained",
      ) => {
        flattened.push({ ...entry, depth, section });
        for (const child of (children.get(entry.snapshot.id) ?? []).sort(
          compare,
        )) {
          add(child, depth + 1, section);
        }
      };
      for (const root of roots.sort(compare)) {
        add(
          root,
          0,
          terminal.has(root.snapshot.status) ? "retained" : "active",
        );
      }
    }
    const active = flattened.filter((entry) => entry.section === "active");
    const retained = flattened.filter((entry) => entry.section === "retained");
    return [...active, ...retained];
  }

  #newRoster(): SelectList {
    const entries = this.#entries();
    const items = entries.map((entry, index) => ({
      value: entry.value,
      label: `${sectionPrefix(entries, index)}${"  ".repeat(Math.min(entry.depth, 3))}${entry.depth ? "↳ " : ""}${rosterLabel(entry.snapshot)}`,
      description: rosterMetrics(entry.snapshot),
    }));
    const list = new SelectList(items, 12, selectTheme(this.theme));
    list.onSelect = (item) => {
      const entry = this.#entries().find(
        (candidate) => candidate.value === item.value,
      );
      if (!entry) {
        return;
      }
      this.#selected = entry;
      this.#mode = "inspector";
      this.#details = false;
      this.#summary = { kind: "idle" };
      this.#contentOffset = 0;
      this.#makeActions();
      this.tui.requestRender();
    };
    return list;
  }

  #entry(): Entry | undefined {
    if (!this.#selected) {
      return undefined;
    }
    return this.#entries().find(
      (entry) =>
        entry.runtime === this.#selected?.runtime &&
        entry.key === this.#selected?.key,
    );
  }

  #sameSelection(entry: Entry): boolean {
    return (
      this.#mode === "inspector" &&
      !this.#disposed &&
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
      const oldIndex = this.#entries().findIndex(
        (entry) => entry.value === selected,
      );
      this.#roster = this.#newRoster();
      const next = this.#entries().findIndex(
        (entry) => entry.value === selected,
      );
      this.#roster.setSelectedIndex(next >= 0 ? next : Math.max(0, oldIndex));
    } else if (!this.#entry()) {
      this.#loseSelection();
      return;
    } else {
      this.#makeActions();
    }
    this.tui.requestRender();
  }

  #loseSelection(): void {
    const lost = this.#selected?.value;
    if (lost && this.#lastLost !== lost) {
      this.#lastLost = lost;
      this.ctx.ui.notify(
        "Selected agent is no longer available; showing nearest roster entry.",
        "warning",
      );
    }
    this.#back();
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
    const selectedIndex = this.#actions
      ? this.#actionValues.indexOf(
          this.#actions.getSelectedItem()?.value as Action,
        )
      : 0;
    this.#actionValues = values;
    this.#actions = new SelectList(
      values.map((value) => ({ value, label: actionLabel(value) })),
      8,
      selectTheme(this.theme),
    );
    this.#actions.onSelect = (item) => void this.#action(item.value as Action);
    this.#actions.setSelectedIndex(
      Math.max(0, Math.min(selectedIndex, values.length - 1)),
    );
  }

  #inspector(entry: Entry | undefined): Component {
    this.#makeActions();
    const inspection = entry && entry.runtime.inspect(entry.snapshot.id);
    const content = inspection
      ? new InspectionPane(
          inspection,
          this.#details,
          this.#summary,
          this.tui,
          this.theme,
          this.#expandedTools,
        )
      : textComponent(["Agent is no longer available."]);
    return {
      render: (width) => {
        const sidebarWidth = Math.min(28, Math.max(10, Math.floor(width / 3)));
        const contentWidth = Math.max(1, width - sidebarWidth - 3);
        const actions = this.#actions?.render(sidebarWidth) ?? [];
        const lines = content.render(contentWidth);
        const visible = lines.slice(
          this.#contentOffset,
          this.#contentOffset + 24,
        );
        this.#contentOffset = Math.min(
          this.#contentOffset,
          Math.max(0, lines.length - 1),
        );
        return Array.from(
          { length: Math.max(actions.length, visible.length) },
          (_, index) => {
            const separator = this.#focus === "actions" ? " │ " : " · ";
            return `${truncateToWidth(actions[index] ?? "", sidebarWidth, "…", false)}${separator}${truncateToWidth(visible[index] ?? "", contentWidth, "…", false)}`;
          },
        );
      },
      invalidate() {},
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
      this.tui.requestRender();
      return;
    }
    if (action === "guidance") {
      if (!eligibleGuidance(entry)) {
        this.#warning("Guidance is no longer available for this agent.");
        return;
      }
      const message = await this.ctx.ui.input(
        "Guidance (cooperatively queued after current tool calls)",
      );
      const current = this.#entry();
      if (
        !message?.trim() ||
        !current ||
        !this.#sameSelection(current) ||
        !eligibleGuidance(current)
      ) {
        if (message?.trim()) {
          this.#warning("Guidance was not delivered; agent state changed.");
        }
        return;
      }
      try {
        await current.runtime.steer(current.snapshot.id, message);
      } catch {
        this.#warning("Guidance was not delivered; agent state changed.");
      }
      return;
    }
    if (action === "stop") {
      if (!eligibleStop(entry)) {
        this.#warning("Stop is no longer available for this agent.");
        return;
      }
      const confirmed = await this.ctx.ui.confirm(
        "Stop agent",
        "Stop this running agent?",
      );
      const current = this.#entry();
      if (!confirmed) {
        return;
      }
      if (!current || !this.#sameSelection(current) || !eligibleStop(current)) {
        this.#warning("Agent already settled before it could be stopped.");
        return;
      }
      try {
        current.runtime.stop(current.snapshot.id);
      } catch {
        this.#warning("Agent already settled before it could be stopped.");
      }
      return;
    }
    this.#abort?.abort();
    const generation = ++this.#generation;
    this.#summary = { kind: "loading" };
    this.tui.requestRender();
    if (!this.ctx.model) {
      this.#setSummary(entry, generation, {
        kind: "error",
        text: "No active model. Set a model first.",
      });
      return;
    }
    const auth = await this.ctx.modelRegistry.getApiKeyAndHeaders(
      this.ctx.model,
    );
    if (!this.#sameSelection(entry) || generation !== this.#generation) {
      return;
    }
    if (!auth.ok) {
      this.#setSummary(entry, generation, {
        kind: "error",
        text: bounded(auth.error ?? "Unable to authenticate for a summary."),
      });
      return;
    }
    const controller = new AbortController();
    this.#abort = controller;
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
        result.ok
          ? { kind: "result", text: bounded(result.text) }
          : {
              kind: "error",
              text: bounded(result.message ?? "Unable to summarise activity."),
            },
      );
    } catch {
      this.#setSummary(entry, generation, {
        kind: "error",
        text: "Unable to summarise activity.",
      });
    }
  }

  #setSummary(entry: Entry, generation: number, summary: Summary): void {
    if (
      !this.#sameSelection(entry) ||
      generation !== this.#generation ||
      this.#abort?.signal.aborted
    ) {
      return;
    }
    this.#summary = summary;
    this.tui.requestRender();
  }

  #warning(message: string): void {
    this.ctx.ui.notify(message, "warning");
    this.#refresh();
  }

  #back(): void {
    this.#generation += 1;
    this.#abort?.abort();
    this.#abort = undefined;
    this.#selected = undefined;
    this.#mode = "roster";
    this.#contentOffset = 0;
    this.#roster = this.#newRoster();
    this.tui.requestRender();
  }

  #close(): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    this.#generation += 1;
    this.#abort?.abort();
    for (const unsubscribe of this.#unsubscribers.splice(0)) {
      unsubscribe();
    }
    this.done();
  }
}

function sectionPrefix(entries: readonly Entry[], index: number): string {
  if (index === 0) {
    return "Active · ";
  }
  if (
    entries[index - 1]?.section !== "retained" &&
    entries[index]?.section === "retained"
  ) {
    return "Retained · ";
  }
  return "";
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
    current?.key === entry.snapshot.key &&
    current?.status === "running" &&
    current.canSteer === true
  );
}

function eligibleStop(entry: Entry): boolean {
  const current = entry.runtime.snapshot(entry.snapshot.id);
  return current?.key === entry.snapshot.key && current?.status === "running";
}

class InspectionPane implements Component {
  #components: Component[];

  constructor(
    inspection: RuntimeInspection,
    details: boolean,
    summary: Summary,
    tui: TUI,
    theme: Theme,
    expanded: ReadonlySet<string>,
  ) {
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
    this.#components = [textComponent(header)];
    for (const item of chronologicalItems(inspection)) {
      if (item.kind === "assistant") {
        this.#components.push(
          new Markdown(item.text, 0, 0, markdownTheme(theme)),
        );
      } else if (item.kind === "user") {
        this.#components.push(
          textComponent([theme.bold(`User: ${item.text}`)]),
        );
      } else if (item.kind === "tool" && safeTool(item.toolName)) {
        const tool = new ToolExecutionComponent(
          item.toolName,
          item.toolCallId,
          toolArguments(item.arguments),
          undefined,
          undefined,
          tui,
          inspection.snapshot.cwd,
        );
        tool.markExecutionStarted();
        tool.setArgsComplete();
        if (item.status !== "running") {
          tool.updateResult({
            content: item.result ? [{ type: "text", text: item.result }] : [],
            isError: item.status === "failed" || item.status === "interrupted",
          });
        }
        tool.setExpanded(expanded.has(item.toolCallId));
        this.#components.push(tool);
      } else if (item.kind === "tool") {
        this.#components.push(
          textComponent([
            `Tool ${bounded(item.toolName)}: ${item.status}${item.toolName === "edit" || item.toolName === "write" ? " · body omitted" : " · retained output unavailable"}`,
          ]),
        );
      } else {
        this.#components.push(
          textComponent([
            activityLine(
              item as Exclude<
                RuntimeInspection["activity"][number],
                { kind: "tool" }
              >,
            ),
          ]),
        );
      }
    }
    if (
      inspection.omittedMessages ||
      inspection.omittedActivity ||
      inspection.compactedHistory
    ) {
      this.#components.push(
        textComponent([
          `Retention: ${inspection.omittedMessages + inspection.omittedActivity} records omitted${inspection.compactedHistory ? " · compacted history" : ""}`,
        ]),
      );
    }
  }

  invalidate(): void {
    for (const component of this.#components) {
      component.invalidate();
    }
  }

  render(width: number): string[] {
    return this.#components.flatMap((component) =>
      component
        .render(Math.max(1, width))
        .map((line) => truncateToWidth(line, Math.max(1, width), "…", false)),
    );
  }
}

type TimelineItem =
  | { kind: "user" | "assistant"; text: string; timestamp?: string }
  | Extract<RuntimeInspection["activity"][number], { kind: "tool" }>
  | Exclude<RuntimeInspection["activity"][number], { kind: "tool" }>;

function chronologicalItems(inspection: RuntimeInspection): TimelineItem[] {
  return inspection.records.map((record) => {
    if (record.kind !== "message") {
      return record;
    }
    return {
      kind: record.role === "final" ? "assistant" : record.role,
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

function safeTool(name: string): boolean {
  return ["read", "search", "list", "bash"].includes(name);
}

function toolArguments(value: string | undefined): Record<string, unknown> {
  if (!value) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : { detail: value };
  } catch {
    return { detail: value };
  }
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
