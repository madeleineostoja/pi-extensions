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
} from "@pi-extensions/lib";
import type {
  RuntimeInspection,
  RuntimeOwner,
  RuntimeSnapshot,
  SubagentRuntime,
  SubagentRuntimeStatus,
} from "./runtime.js";

const terminalStatuses = new Set<SubagentRuntimeStatus>([
  "completed",
  "failed",
  "stopped",
]);

type DashboardEntry = {
  runtime: SubagentRuntime;
  snapshot: RuntimeSnapshot;
};

export async function showAgentsDashboard(
  runtimeOrRuntimes: SubagentRuntime | readonly SubagentRuntime[],
  ctx: ExtensionCommandContext,
): Promise<void> {
  const entries = dashboardEntries(runtimeOrRuntimes);
  if (entries.length === 0) {
    ctx.ui.notify("No current-session agents.", "info");
    return;
  }

  const rows = formatListRows(entries.map((entry) => entry.snapshot));
  const selected = await ctx.ui.select("Current-session agents", rows);
  if (!selected) {
    ctx.ui.notify(formatList(entries), "info");
    return;
  }
  const index = rows.indexOf(selected);
  const entry = entries[index];
  if (!entry) {
    return;
  }
  await showAgentDetail(entry.runtime, ctx, entry.snapshot.id);
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
      if (!nestedOwner(snapshot.owner)) {
        entries.push({ runtime, snapshot });
      }
    }
  }
  return entries;
}

function formatList(entries: DashboardEntry[]): string {
  return [
    "Current-session agents",
    ...formatListRows(entries.map((entry) => entry.snapshot)),
  ].join("\n");
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
  if (inspection.snapshot.status === "running" && canShowLiveInspector(ctx)) {
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

export function formatListRow(snapshot: RuntimeSnapshot): string {
  return formatListRows([snapshot])[0] ?? "";
}

export function formatListRows(snapshots: RuntimeSnapshot[]): string[] {
  const rows = snapshots.map((snapshot) => ({
    id: snapshot.id,
    status: snapshot.status,
    type: `${snapshot.type}${roleLabel(snapshot.owner)}`,
    elapsed: elapsedLabel(snapshot),
    usage: usageLabel(snapshot),
    tool: snapshot.health?.activeTool ?? "-",
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
      "turns/tokens",
      rows.map((row) => row.usage),
    ),
    tool: maxWidth(
      "tool",
      rows.map((row) => row.tool),
    ),
  };
  return rows.map((row) =>
    [
      row.id.padEnd(widths.id),
      row.status.padEnd(widths.status),
      row.type.padEnd(widths.type),
      row.elapsed.padStart(widths.elapsed),
      row.usage.padStart(widths.usage),
      row.tool.padEnd(widths.tool),
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
    : { snapshot: inspectionOrSnapshot, messages: [] };
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
    `Thinking: ${snapshot.thinking ?? "unknown"}`,
    `CWD: ${snapshot.cwd}`,
    `Extension binding: ${snapshot.extensionBinding}`,
    `Elapsed: ${elapsedLabel(snapshot)}`,
    `Turns/tokens: ${usageLabel(snapshot)}`,
    `Active tool: ${snapshot.health?.activeTool ?? "none"}`,
    `Last activity: ${snapshot.health?.lastActivity ?? "unknown"}`,
  ];
  const preview = previewText(
    snapshot.health?.lastAssistantText ?? snapshot.health?.resultPreview,
  );
  if (preview) {
    lines.push(`Last assistant/result: ${preview}`);
  }
  const result = previewText(snapshot.health?.resultPreview ?? snapshot.result);
  if (result) {
    lines.push(`Result: ${result}`);
  }
  if (snapshot.error) {
    lines.push(`Error: ${snapshot.error}`);
  }
  lines.push(transcriptLabel(snapshot));
  const messageTail = formatMessageTail(inspection.messages, 6);
  if (messageTail.length > 0) {
    lines.push("Message tail:", ...messageTail.map((line) => `- ${line}`));
  }
  lines.push("Nested explore children:");
  if (children.length === 0) {
    lines.push("- none");
  } else {
    lines.push(...formatListRows(children).map((child) => `- ${child}`));
  }
  return lines.join("\n");
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
      `Elapsed: ${elapsedLabel(snapshot)} · Turns/tokens: ${usageLabel(snapshot)} · Active tool: ${snapshot.health?.activeTool ?? "none"}`,
      `Owner: ${ownerLabel(snapshot.owner)}`,
      `Last activity: ${snapshot.health?.lastActivity ?? "unknown"}`,
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
      lines.push("", this.theme.bold("[Assistant]"));
      lines.push(...this.wrap(assistant, width));
    }
    const result = previewText(
      snapshot.health?.resultPreview ?? snapshot.result,
      2000,
    );
    if (result) {
      lines.push("", this.theme.fg("success", "[Result]"));
      lines.push(...this.wrap(result, width));
    }
    if (snapshot.error) {
      lines.push("", this.theme.fg("error", "[Error]"));
      lines.push(...this.wrap(snapshot.error, width, "error"));
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
  if (owner.kind === "pi-implement") {
    return `/${owner.role}`;
  }
  if (owner.kind === "nested") {
    return `/${owner.tool}`;
  }
  if (owner.kind === "internal" && owner.name === "pi-implement") {
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
  if (owner.kind === "pi-implement") {
    return `pi-implement:${owner.runId}/${owner.role}${owner.taskId ? `/${owner.taskId}` : ""}`;
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

function elapsedLabel(snapshot: RuntimeSnapshot): string {
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

function usageLabel(snapshot: RuntimeSnapshot): string {
  const turns = snapshot.health?.turns;
  const tokens = snapshot.health?.tokensTotal;
  return `${turns ?? "-"}/${tokens ?? "-"}`;
}

function transcriptLabel(snapshot: RuntimeSnapshot): string {
  if (
    snapshot.health?.transcript?.sessionFile ||
    snapshot.health?.transcript?.sessionId
  ) {
    return `Transcript: ${[
      snapshot.health.transcript.sessionFile,
      snapshot.health.transcript.sessionId,
    ]
      .filter(Boolean)
      .join(" · ")}`;
  }
  return "Transcript: unavailable";
}

function formatMessageTail(
  messages: readonly unknown[],
  count: number,
): string[] {
  return messages.slice(-count).map((message) => {
    const role = messageRole(message);
    const text = previewText(messageText(message) ?? message, 240) ?? "";
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
    const text = previewText(messageText(message) ?? message, 1200);
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
