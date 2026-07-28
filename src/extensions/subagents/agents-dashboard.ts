import type {
  ExtensionCommandContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { matchesKey, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import {
  isModalCloseInput,
  nextModalScrollOffset,
  registerModalCloseInput,
  renderModalView,
} from "#lib/modal-view";
import type {
  RuntimeInspection,
  RuntimeOwner,
  RuntimeSnapshot,
  SubagentRuntime,
  SubagentRuntimeStatus,
} from "./runtime.js";
import {
  contextUsageLabel,
  costLabel,
  elapsedLabel,
  tokenLabel,
} from "./formatters.js";
import { truncateUtf8 } from "./inspection.js";

const terminalStatuses = new Set<SubagentRuntimeStatus>([
  "completed",
  "failed",
  "stopped",
]);

type DashboardEntry = {
  runtime: SubagentRuntime;
  snapshot: RuntimeSnapshot;
};

type DashboardSelection = {
  runtime: SubagentRuntime;
  key: string;
};

export async function showAgentsDashboard(
  runtimeOrRuntimes: SubagentRuntime | readonly SubagentRuntime[],
  ctx: ExtensionCommandContext,
): Promise<void> {
  let filter: "Running" | "Stopped" = "Running";
  let selected: DashboardSelection | undefined;
  while (true) {
    const all = dashboardEntries(runtimeOrRuntimes);
    if (all.length === 0) {
      ctx.ui.notify("No current-session agents.", "info");
      return;
    }
    if (selected) {
      const entry = resolveSelection(all, selected);
      if (!entry) {
        selected = undefined;
        ctx.ui.notify(
          "Selected agent is no longer available; refreshed.",
          "warning",
        );
        continue;
      }
      const inspection = entry.runtime.inspect(entry.snapshot.id);
      if (!inspection) {
        selected = undefined;
        ctx.ui.notify(
          "Selected agent is no longer available; refreshed.",
          "warning",
        );
        continue;
      }
      const action = await ctx.ui.select(
        `Agent ${inspection.snapshot.id}`,
        actionsFor(inspection.snapshot),
      );
      if (!action || action === "Back") {
        selected = undefined;
        continue;
      }
      try {
        if (action === "Inspect activity") {
          await showAgentDetail(entry.runtime, ctx, inspection.snapshot.id);
        } else if (action === "Send guidance") {
          const message = await (
            ctx.ui as unknown as {
              input?: (title: string) => Promise<string | undefined>;
            }
          ).input?.("Guidance (cooperatively queued after current tool calls)");
          if (message?.trim()) {
            await entry.runtime.steer(inspection.snapshot.id, message);
          }
        } else if (action === "Stop agent") {
          const confirm = await (
            ctx.ui as unknown as {
              confirm?: (title: string, message: string) => Promise<boolean>;
            }
          ).confirm?.("Stop agent", "Stop this running agent?");
          if (confirm) {
            entry.runtime.stop(inspection.snapshot.id);
            selected = undefined;
          }
        } else if (action === "Summarise activity") {
          await showAgentSummary(entry.runtime, ctx, inspection.snapshot.id);
        }
      } catch {
        selected = undefined;
        ctx.ui.notify(
          "Selected agent is no longer available; refreshed.",
          "warning",
        );
      }
      continue;
    }

    const view = await ctx.ui.select("Agent view", ["Running", "Stopped"]);
    if (!view) {
      return;
    }
    filter = view === "Stopped" ? "Stopped" : "Running";
    const topLevel = all.filter((entry) => !nestedOwner(entry.snapshot.owner));
    const visible = topLevel.filter((entry) =>
      filter === "Running"
        ? entry.snapshot.status === "running" ||
          entry.snapshot.status === "queued"
        : terminalStatuses.has(entry.snapshot.status),
    );
    if (visible.length === 0) {
      ctx.ui.notify(
        filter === "Running"
          ? "No running agents. Choose Stopped to inspect retained records."
          : "No stopped agents.",
        "info",
      );
      return;
    }
    const choices = new Map<string, DashboardSelection>();
    const labels: string[] = [];
    const rows = formatListRows(visible.map((entry) => entry.snapshot));
    for (const [index, entry] of visible.entries()) {
      const choice = `${rows[index] ?? ""}${
        nestedChildren(all, entry).length
          ? `\n  ↳ ${nestedChildren(all, entry)
              .map((child) => child.snapshot.description)
              .join(" · ")}`
          : ""
      }`;
      labels.push(choice);
      choices.set(choice, selectionFor(entry));
    }
    const choice = await ctx.ui.select(
      `${filter} agents · id  status  type  elapsed  turns/context  task`,
      labels,
    );
    if (!choice) {
      return;
    }
    selected = choices.get(choice);
  }
}

function selectionFor(entry: DashboardEntry): DashboardSelection {
  return { runtime: entry.runtime, key: entryKey(entry) };
}

function entryKey(entry: DashboardEntry): string {
  return entry.snapshot.key ?? `${entry.runtime.scope}:${entry.snapshot.id}`;
}

function resolveSelection(
  entries: DashboardEntry[],
  selection: DashboardSelection,
): DashboardEntry | undefined {
  return entries.find(
    (entry) =>
      entry.runtime === selection.runtime && entryKey(entry) === selection.key,
  );
}

function actionsFor(snapshot: RuntimeSnapshot): string[] {
  const actions = ["Inspect activity", "Summarise activity"];
  if (snapshot.status === "running" && snapshot.canSteer === true) {
    actions.push("Send guidance");
  }
  if (snapshot.status === "running") {
    actions.push("Stop agent");
  }
  actions.push("Back");
  return actions;
}

function dashboardEntries(
  runtimeOrRuntimes: SubagentRuntime | readonly SubagentRuntime[],
): DashboardEntry[] {
  const runtimes = Array.isArray(runtimeOrRuntimes)
    ? runtimeOrRuntimes
    : [runtimeOrRuntimes];
  const seen = new Set<SubagentRuntime>();
  const entries: DashboardEntry[] = [];
  for (const runtime of runtimes) {
    if (seen.has(runtime)) {
      continue;
    }
    seen.add(runtime);
    for (const snapshot of runtime.snapshots({ includeNested: true })) {
      entries.push({ runtime, snapshot });
    }
  }
  return entries;
}

function nestedChildren(
  entries: DashboardEntry[],
  entry: DashboardEntry,
): DashboardEntry[] {
  return entries.filter(
    (candidate) =>
      candidate.runtime === entry.runtime &&
      nestedOwner(candidate.snapshot.owner)?.parentId === entry.snapshot.id,
  );
}

async function showAgentDetail(
  runtime: SubagentRuntime,
  ctx: ExtensionCommandContext,
  id: string,
): Promise<void> {
  const inspection = runtime.inspect(id);
  if (!inspection) {
    ctx.ui.notify(`Agent ${id} is no longer available.`, "warning");
    return;
  }
  if (canShowLiveInspector(ctx)) {
    await showLiveInspector(runtime, ctx, id);
    return;
  }
  showStaticDetail(runtime, ctx, inspection);
}

function canShowLiveInspector(ctx: ExtensionCommandContext): boolean {
  return ctx.mode === "tui" && ctx.hasUI && typeof ctx.ui.custom === "function";
}

async function showLiveInspector(
  runtime: SubagentRuntime,
  ctx: ExtensionCommandContext,
  id: string,
): Promise<void> {
  let cleanupTerminalInput: (() => void) | undefined;
  await ctx.ui.custom<void>(
    (tui, theme, _kb, done) => {
      let unsubscribe: (() => void) | undefined;
      const finish = () => {
        cleanupTerminalInput?.();
        cleanupTerminalInput = undefined;
        unsubscribe?.();
        unsubscribe = undefined;
        done();
      };
      const overlay = new AgentInspectorOverlay(
        runtime,
        id,
        tui,
        theme,
        finish,
        () => {
          cleanupTerminalInput?.();
          cleanupTerminalInput = undefined;
          unsubscribe?.();
          unsubscribe = undefined;
        },
      );
      cleanupTerminalInput = registerModalCloseInput(ctx.ui, () =>
        overlay.close(),
      );
      unsubscribe = runtime.subscribe(id, () => {
        if (!runtime.inspect(id)) {
          tui.requestRender();
          overlay.close();
          return;
        }
        tui.requestRender();
      });
      return overlay;
    },
    {
      overlay: true,
      overlayOptions: { width: "90%", maxHeight: "80%" },
    },
  );
}

function showStaticDetail(
  runtime: SubagentRuntime,
  ctx: ExtensionCommandContext,
  inspection: RuntimeInspection,
): void {
  const all = runtime.snapshots({ includeNested: true });
  const children = all.filter(
    (child) => nestedOwner(child.owner)?.parentId === inspection.snapshot.id,
  );
  ctx.ui.notify(formatDetail(inspection, children), "info");
}

type SummaryResult = Awaited<ReturnType<SubagentRuntime["summarise"]>>;

async function showAgentSummary(
  runtime: SubagentRuntime,
  ctx: ExtensionCommandContext,
  id: string,
): Promise<void> {
  if (!ctx.model) {
    ctx.ui.notify("No active model. Set a model first.", "warning");
    return;
  }
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
  if (!auth.ok) {
    ctx.ui.notify(`Unable to summarise activity: ${auth.error}`, "warning");
    return;
  }
  const summaryAuth = {
    apiKey: auth.apiKey,
    headers: auth.headers,
    env: auth.env,
  };
  if (!canShowLiveInspector(ctx)) {
    const result = await runtime.summarise(id, ctx.model, summaryAuth);
    ctx.ui.notify(summaryText(result), result.ok ? "info" : "warning");
    return;
  }
  await ctx.ui.custom<void>(
    (tui, theme, _kb, done) => {
      const controller = new AbortController();
      const overlay = new SummaryOverlay(tui, theme, () => {
        controller.abort();
        done();
      });
      void runtime
        .summarise(id, ctx.model, summaryAuth, undefined, controller.signal)
        .then((result) => overlay.setResult(result))
        .catch(() =>
          overlay.setResult({
            ok: false,
            reason: "error",
            message: "Unable to summarise this agent activity.",
          }),
        );
      return overlay;
    },
    {
      overlay: true,
      overlayOptions: { width: "90%", maxHeight: "80%" },
    },
  );
}

function summaryText(result: SummaryResult): string {
  if (result.ok) {
    return truncateUtf8(result.text, 12 * 1024);
  }
  return truncateUtf8(
    result.message ??
      (result.reason === "aborted"
        ? "Summary cancelled."
        : "Unable to summarise this agent activity."),
    12 * 1024,
  );
}

export function formatListRow(snapshot: RuntimeSnapshot): string {
  return formatListRows([snapshot])[0] ?? "";
}

export function formatListRows(snapshots: RuntimeSnapshot[]): string[] {
  const rows = snapshots.map((snapshot) => ({
    id: snapshot.id,
    status: snapshot.status,
    type: `${snapshot.type}${roleLabel(snapshot.owner)}`,
    elapsed: elapsedLabel(snapshot),
    usage: turnsContextLabel(snapshot),
    description: snapshot.description,
  }));
  const widths = {
    id: maxWidth(
      "id",
      rows.map((row) => row.id),
    ),
    status: maxWidth(
      "status",
      rows.map((row) => row.status),
    ),
    type: maxWidth(
      "type",
      rows.map((row) => row.type),
    ),
    elapsed: maxWidth(
      "elapsed",
      rows.map((row) => row.elapsed),
    ),
    usage: maxWidth(
      "turns/context",
      rows.map((row) => row.usage),
    ),
  };
  return rows.map((row) =>
    [
      row.id.padEnd(widths.id),
      row.status.padEnd(widths.status),
      row.type.padEnd(widths.type),
      row.elapsed.padStart(widths.elapsed),
      row.usage.padStart(widths.usage),
      row.description,
    ].join("  "),
  );
}

export function formatDetail(
  inspectionOrSnapshot: RuntimeInspection | RuntimeSnapshot,
  children: RuntimeSnapshot[] = [],
): string {
  const inspection = isInspection(inspectionOrSnapshot)
    ? inspectionOrSnapshot
    : {
        snapshot: inspectionOrSnapshot,
        messages: [],
        activity: [],
        omittedMessages: 0,
        omittedActivity: 0,
        compactedHistory: false,
      };
  const { snapshot } = inspection;
  const owner = nestedOwner(snapshot.owner);
  const lines = [
    `Agent ${snapshot.id}`,
    `Type/role: ${snapshot.type}${roleLabel(snapshot.owner)}`,
    `Owner: ${ownerLabel(snapshot.owner)}`,
    `Parent id: ${owner?.parentId ?? "none"}`,
    `Status: ${snapshot.status}`,
    `Description: ${snapshot.description}`,
    `Model: ${snapshot.model ?? "unknown"}`,
    `Thinking: ${snapshot.effectiveThinking ?? snapshot.thinking ?? "unknown"}`,
    `CWD: ${snapshot.cwd}`,
    `Extension binding: ${snapshot.extensionBinding}`,
    `Elapsed: ${elapsedLabel(snapshot)}`,
    `Turns/context: ${turnsContextLabel(snapshot)}`,
    usageDetailLabel(snapshot),
    `Last activity: ${snapshot.health?.lastActivity ?? "unknown"}`,
    compactionLabel(snapshot),
    `Pending guidance: ${snapshot.health?.pendingSteering ?? 0}`,
    inspectionDisclosure(inspection),
    transcriptLabel(snapshot),
  ];
  const preview = previewText(
    snapshot.health?.lastAssistantText ?? snapshot.health?.resultPreview,
  );
  if (preview) {
    lines.push(`Last assistant/result preview: ${preview}`);
  }
  const messageTail = formatMessageTail(inspection.messages, 6);
  if (messageTail.length > 0) {
    lines.push("Message tail:", ...messageTail.map((line) => `- ${line}`));
  }
  if (inspection.activity.length > 0) {
    lines.push(
      "Recent activity:",
      ...inspection.activity
        .slice(-6)
        .map((activity) => `- ${activityLabel(activity)}`),
    );
  }
  lines.push("Nested explore children:");
  if (children.length === 0) {
    lines.push("- none");
  } else {
    lines.push(...formatListRows(children).map((child) => `- ${child}`));
  }
  return truncateUtf8(lines.join("\n"), 12 * 1024);
}

class SummaryOverlay implements Component {
  private result: SummaryResult | undefined;
  private scrollOffset = 0;
  private lastMaxScroll = 0;
  private lastViewportRows = 1;
  private closed = false;

  constructor(
    private tui: TUI,
    private theme: Theme,
    private onClose: () => void,
    private maxRows = Math.floor((tui.terminal.rows ?? 24) * 0.8),
  ) {}

  invalidate(): void {
    this.tui.requestRender();
  }

  dispose(): void {
    this.close();
  }

  setResult(result: SummaryResult): void {
    if (this.closed) {
      return;
    }
    this.result = result;
    this.tui.requestRender();
  }

  handleInput(data: string): void {
    if (isModalCloseInput(data) || matchesKey(data, "q")) {
      this.close();
      return;
    }
    const nextScroll = nextModalScrollOffset(
      data,
      this.scrollOffset,
      this.lastMaxScroll,
      this.lastViewportRows,
    );
    if (nextScroll !== undefined) {
      this.scrollOffset = nextScroll;
      this.tui.requestRender();
    }
  }

  render(width: number): string[] {
    const content = this.contentLines(Math.max(1, width - 4));
    const rendered = renderModalView({
      theme: this.theme,
      width,
      maxRows: this.maxRows,
      title: "Agent activity summary",
      status: this.result
        ? {
            label: this.result.ok ? "ready" : this.result.reason,
            kind: this.result.ok ? "completed" : "warning",
          }
        : { label: "summarising", kind: "pending" },
      contentLines: content,
      scrollOffset: this.scrollOffset,
      footerControls: this.result
        ? "esc/q: close · ↑↓/kj scroll · Pg/Home/End"
        : "esc/q: cancel",
    });
    this.scrollOffset = rendered.scrollOffset;
    this.lastMaxScroll = rendered.maxScroll;
    this.lastViewportRows = rendered.viewportRows;
    return rendered.lines;
  }

  private contentLines(width: number): string[] {
    if (!this.result) {
      return ["Generating a point-in-time, tool-free activity summary…"];
    }
    return wrapTextWithAnsi(summaryText(this.result), width);
  }

  private close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.onClose();
  }
}

class AgentInspectorOverlay implements Component {
  private scrollOffset = 0;
  private lastWidth = 80;
  private lastMaxScroll = 0;
  private lastViewportRows = 1;
  private stopArmed = false;
  private disposed = false;

  constructor(
    private runtime: SubagentRuntime,
    private id: string,
    private tui: TUI,
    private theme: Theme,
    private done: () => void,
    private cleanup: () => void,
    private maxRows = Math.floor((tui.terminal.rows ?? 24) * 0.8),
  ) {}

  invalidate(): void {
    this.clampScrollOffset();
    this.tui.requestRender();
  }

  dispose(): void {
    this.disposeOnce();
  }

  close(): void {
    this.disposeOnce();
    this.done();
  }

  handleInput(data: string): void {
    if (isModalCloseInput(data) || matchesKey(data, "q")) {
      this.close();
      return;
    }

    const nextScroll = nextModalScrollOffset(
      data,
      this.scrollOffset,
      this.lastMaxScroll,
      this.lastViewportRows,
    );
    if (nextScroll !== undefined) {
      this.scrollOffset = nextScroll;
      this.invalidate();
      return;
    }

    if (matchesKey(data, "s") || matchesKey(data, "x")) {
      const inspection = this.runtime.inspect(this.id);
      if (!inspection || terminalStatuses.has(inspection.snapshot.status)) {
        this.stopArmed = false;
        this.invalidate();
        return;
      }
      if (!this.stopArmed) {
        this.stopArmed = true;
        this.invalidate();
        return;
      }
      this.runtime.stop(this.id);
      this.stopArmed = false;
      this.invalidate();
      return;
    }

    if (this.stopArmed) {
      this.stopArmed = false;
      this.invalidate();
    }
  }

  render(width: number): string[] {
    this.lastWidth = width;
    const inspection = this.runtime.inspect(this.id);
    if (!inspection) {
      const rendered = renderModalView({
        theme: this.theme,
        width,
        maxRows: this.maxRows,
        title: `/agents ${this.id}`,
        status: { label: "unavailable", kind: "warning" },
        contentLines: [
          this.theme.fg(
            "warning",
            "Agent is no longer available in this session.",
          ),
        ],
        scrollOffset: 0,
        footerControls: "esc/q: close",
      });
      return rendered.lines;
    }

    const contentLines = this.contentLines(
      inspection,
      this.contentWidth(width),
    );
    const rendered = renderModalView({
      theme: this.theme,
      width,
      maxRows: this.maxRows,
      title: `/agents ${inspection.snapshot.id}`,
      status: {
        label: `${inspection.snapshot.status} · ${inspection.snapshot.type}${roleLabel(inspection.snapshot.owner)}`,
        kind: statusKind(inspection.snapshot.status),
      },
      subtitle: inspection.snapshot.description,
      contentLines,
      scrollOffset: this.scrollOffset,
      footerControls: this.footer(inspection.snapshot),
    });
    this.scrollOffset = rendered.scrollOffset;
    this.lastMaxScroll = rendered.maxScroll;
    this.lastViewportRows = rendered.viewportRows;
    return rendered.lines;
  }

  private footer(snapshot: RuntimeSnapshot): string {
    const scroll = "↑↓/kj scroll · Pg/Home/End";
    if (terminalStatuses.has(snapshot.status)) {
      return `esc/q: close · ${scroll}`;
    }
    if (this.stopArmed) {
      return `s/x again: STOP · esc/q: close · ${scroll}`;
    }
    return `s/x: stop · esc/q: close · ${scroll}`;
  }

  private contentLines(inspection: RuntimeInspection, width: number): string[] {
    const { snapshot } = inspection;
    const lines = [
      this.theme.fg("dim", "[Status]"),
      `Owner: ${ownerLabel(snapshot.owner)}`,
      `Model: ${snapshot.model ?? "unknown"}`,
      `Thinking: ${snapshot.effectiveThinking ?? snapshot.thinking ?? "unknown"}`,
      `CWD: ${snapshot.cwd}`,
      `Last activity: ${snapshot.health?.lastActivity ?? "unknown"}`,
      `Elapsed: ${elapsedLabel(snapshot)} · Turns/context: ${turnsContextLabel(snapshot)}`,
      usageDetailLabel(snapshot),
      compactionLabel(snapshot),
      `Pending guidance: ${snapshot.health?.pendingSteering ?? 0}`,
      inspectionDisclosure(inspection),
      transcriptLabel(snapshot),
    ];
    if (this.stopArmed && !terminalStatuses.has(snapshot.status)) {
      lines.push(
        "",
        this.theme.fg("error", "Press s or x again to stop this agent."),
      );
    }
    const assistant = previewText(snapshot.health?.lastAssistantText, 2000);
    if (assistant) {
      lines.push("", this.theme.bold("[Assistant preview]"));
      lines.push(...this.wrap(assistant, width));
    }
    const result = previewText(snapshot.health?.resultPreview, 2000);
    if (result) {
      lines.push("", this.theme.fg("success", "[Result preview]"));
      lines.push(...this.wrap(result, width));
    }
    if (inspection.activity.length > 0) {
      lines.push("", this.theme.fg("dim", "[Recent activity]"));
      for (const activity of inspection.activity.slice(-12)) {
        lines.push(...this.wrap(activityLabel(activity), width));
      }
    }
    const transcript = formatTranscriptTail(inspection.messages, width, 12);
    if (transcript.length > 0) {
      lines.push("", this.theme.fg("dim", "───"), ...transcript);
    }
    return lines;
  }

  private wrap(
    text: string,
    width: number,
    color?: "dim" | "muted" | "error",
  ): string[] {
    return wrapTextWithAnsi(text, Math.max(1, width)).map((line) =>
      color ? this.theme.fg(color, line) : line,
    );
  }

  private contentWidth(width: number): number {
    return Math.max(1, width - 4);
  }

  private clampScrollOffset(): void {
    const inspection = this.runtime.inspect(this.id);
    const length = inspection
      ? this.contentLines(inspection, this.contentWidth(this.lastWidth)).length
      : 1;
    this.scrollOffset = Math.min(
      this.scrollOffset,
      Math.max(0, length - this.lastViewportRows),
    );
  }

  private disposeOnce(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.cleanup();
  }
}

function isInspection(
  value: RuntimeInspection | RuntimeSnapshot,
): value is RuntimeInspection {
  return "snapshot" in value && "messages" in value;
}

function roleLabel(owner: RuntimeOwner): string {
  if (typeof owner !== "object") {
    return "";
  }
  if (owner.kind === "pipkin:implement") {
    return `/${owner.role}`;
  }
  if (owner.kind === "nested") {
    return `/${owner.tool}`;
  }
  if (owner.kind === "internal" && owner.name === "pipkin:implement") {
    return "/worker";
  }
  return "";
}

function ownerLabel(owner: RuntimeOwner): string {
  if (typeof owner === "string") {
    return owner;
  }
  if (owner.kind === "nested") {
    return `nested:${owner.tool} parent=${owner.parentId}`;
  }
  if (owner.kind === "pipkin:implement") {
    return `pipkin:implement:${owner.runId}/${owner.role}${owner.taskId ? `/${owner.taskId}` : ""}`;
  }
  return `${owner.kind}:${owner.name}`;
}

function nestedOwner(
  owner: RuntimeOwner,
): Extract<RuntimeOwner, { kind: "nested" }> | undefined {
  return typeof owner === "object" && owner.kind === "nested"
    ? owner
    : undefined;
}

function compactionLabel(snapshot: RuntimeSnapshot): string {
  const compaction = snapshot.health?.compaction;
  if (!compaction) {
    return `Compactions: ${snapshot.health?.compactions ?? 0} · Current: none`;
  }
  const retry = compaction.retry
    ? ` · Retry: ${compaction.retry.status}${
        compaction.retry.error
          ? ` (${previewText(compaction.retry.error, 240)})`
          : ""
      }`
    : "";
  const error = compaction.error
    ? ` · ${previewText(compaction.error, 240)}`
    : "";
  return `Compactions: ${snapshot.health?.compactions ?? 0} · Current: ${compaction.status}${
    compaction.reason ? ` (${compaction.reason})` : ""
  }${compaction.willRetry ? " · retrying" : ""}${retry}${error}`;
}

function inspectionDisclosure(inspection: RuntimeInspection): string {
  const omissions = [
    inspection.omittedMessages && `${inspection.omittedMessages} messages`,
    inspection.omittedActivity &&
      `${inspection.omittedActivity} activity records`,
  ].filter(Boolean);
  return `Inspection retention: ${
    omissions.length > 0
      ? `omitted ${omissions.join(" and ")}`
      : "complete retained window"
  } · Compacted history: ${inspection.compactedHistory ? "yes" : "no"}`;
}

function activityLabel(
  activity: RuntimeInspection["activity"][number],
): string {
  if (activity.kind === "tool") {
    const detail = activity.error ?? activity.result ?? activity.arguments;
    return `Tool ${previewText(activity.toolName, 120) ?? "unknown"}: ${activity.status}${
      detail ? ` · ${previewText(detail, 480)}` : ""
    }`;
  }
  if (activity.kind === "compaction") {
    return `Compaction: ${activity.status}${
      activity.reason ? ` (${previewText(activity.reason, 120)})` : ""
    }${activity.willRetry ? " · retrying" : ""}${
      activity.error ? ` · ${previewText(activity.error, 480)}` : ""
    }`;
  }
  if (activity.kind === "retry") {
    return `Compaction retry: ${activity.status}${
      activity.error ? ` · ${previewText(activity.error, 480)}` : ""
    }`;
  }
  return `Guidance: ${activity.status} · ${previewText(activity.text, 480) ?? ""}`;
}

function turnsContextLabel(snapshot: RuntimeSnapshot): string {
  return `${snapshot.health?.turns ?? "-"}/${contextUsageLabel(snapshot)}`;
}

function usageDetailLabel(snapshot: RuntimeSnapshot): string {
  const health = snapshot.health;
  const cost = costLabel(health?.estimatedCost);
  const peak = tokenLabel(health?.peakContextTokens);
  const cumulative = tokenLabel(health?.tokensTotal);
  return `Estimated API cost: ${cost} · Peak context: ${peak} · Cumulative tokens: ${cumulative}`;
}

function transcriptLabel(snapshot: RuntimeSnapshot): string {
  const transcript = snapshot.health?.transcript;
  if (transcript?.sessionFile) {
    return `Transcript: ${[transcript.sessionFile, transcript.sessionId]
      .filter(Boolean)
      .join(" · ")}`;
  }
  if (transcript?.sessionId) {
    return `Transcript: in-memory child · ${transcript.sessionId}`;
  }
  return "Transcript: in-memory child";
}

function formatMessageTail(
  messages: readonly unknown[],
  count: number,
): string[] {
  return messages.slice(-count).map((message) => {
    const role = messageRole(message);
    const text =
      previewText(
        inspectionMessageText(message) ?? messageText(message) ?? message,
        240,
      ) ?? "";
    return `${role}: ${text}`;
  });
}

function formatTranscriptTail(
  messages: readonly unknown[],
  width: number,
  count: number,
): string[] {
  return messages.slice(-count).flatMap((message) => {
    const role = messageRole(message);
    const label = roleLabelForTranscript(role);
    const text = previewText(
      inspectionMessageText(message) ?? messageText(message) ?? message,
      1200,
    );
    if (!text) {
      return [];
    }
    return [
      label,
      ...wrapTextWithAnsi(text, Math.max(1, width)).map((line) =>
        role === "toolResult" ? `  ${line}` : line,
      ),
    ];
  });
}

function roleLabelForTranscript(role: string): string {
  if (role === "assistant") {
    return "[Assistant]";
  }
  if (role === "user") {
    return "[User]";
  }
  if (role === "toolResult") {
    return "[Result]";
  }
  return `[${role}]`;
}

function messageRole(message: unknown): string {
  return isObject(message) && typeof message.role === "string"
    ? message.role
    : "message";
}

function inspectionMessageText(message: unknown): string | undefined {
  return isObject(message) && typeof message.text === "string"
    ? message.text
    : undefined;
}

function messageText(message: unknown): string | undefined {
  if (!isObject(message)) {
    return undefined;
  }
  const content = message.content;
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    if (typeof message.toolName === "string") {
      return `tool ${message.toolName}`;
    }
    return undefined;
  }
  const parts = content
    .map((part) => {
      if (!isObject(part)) {
        return "";
      }
      if (typeof part.text === "string") {
        return part.text;
      }
      if (part.type === "toolCall" && typeof part.name === "string") {
        return `tool call ${part.name}`;
      }
      return "";
    })
    .filter(Boolean);
  return parts.length > 0 ? parts.join(" | ") : undefined;
}

function previewText(value: unknown, max = 600): string | undefined {
  let text: string;
  if (typeof value === "string") {
    text = value;
  } else if (value === undefined || value === null) {
    return undefined;
  } else {
    try {
      text = JSON.stringify(value);
    } catch {
      text = String(value);
    }
  }
  const compact = text.replace(/\s+/g, " ").trim();
  if (!compact) {
    return undefined;
  }
  return compact.length > max ? `${compact.slice(0, max - 1)}…` : compact;
}

function statusKind(status: SubagentRuntimeStatus) {
  if (status === "running" || status === "queued") {
    return "running" as const;
  }
  if (status === "completed") {
    return "completed" as const;
  }
  if (status === "failed") {
    return "failed" as const;
  }
  return "stopped" as const;
}

function maxWidth(label: string, values: string[]): number {
  return Math.max(label.length, ...values.map((value) => value.length));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
