import type {
  ExtensionCommandContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import {
  Key,
  matchesKey,
  truncateToWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
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

export async function showAgentsDashboard(
  runtime: SubagentRuntime,
  ctx: ExtensionCommandContext,
): Promise<void> {
  const snapshots = runtime.snapshots({ includeNested: true });
  const topLevel = snapshots.filter((snapshot) => !nestedOwner(snapshot.owner));
  if (topLevel.length === 0) {
    ctx.ui.notify("No current-session agents.", "info");
    return;
  }

  const rows = formatListRows(topLevel);
  const selected = await ctx.ui.select("Current-session agents", rows);
  if (!selected) {
    ctx.ui.notify(formatList(topLevel), "info");
    return;
  }
  const index = rows.indexOf(selected);
  const snapshot = topLevel[index];
  if (!snapshot) {
    return;
  }
  await showAgentDetail(runtime, ctx, snapshot.id);
}

function formatList(snapshots: RuntimeSnapshot[]): string {
  return ["Current-session agents", ...formatListRows(snapshots)].join("\n");
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
  await ctx.ui.custom<void>(
    (tui, theme, _kb, done) => {
      let unsubscribe: (() => void) | undefined;
      const overlay = new AgentInspectorOverlay(
        runtime,
        id,
        tui,
        theme,
        done,
        () => {
          unsubscribe?.();
          unsubscribe = undefined;
        },
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

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      this.disposeOnce();
      this.done();
      return;
    }
    if (matchesKey(data, Key.up)) {
      this.scrollOffset += 1;
      this.invalidate();
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.scrollOffset = Math.max(0, this.scrollOffset - 1);
      this.invalidate();
      return;
    }
    if (matchesKey(data, "s")) {
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
    }
  }

  render(width: number): string[] {
    this.lastWidth = width;
    const inspection = this.runtime.inspect(this.id);
    if (!inspection) {
      return [
        this.theme.bold(`/agents ${this.id}`),
        this.theme.fg(
          "warning",
          "Agent is no longer available in this session.",
        ),
        this.theme.fg("muted", "esc: close"),
      ];
    }

    const contentLines = this.contentLines(inspection, width);
    const maxContentRows = this.maxContentRows();
    const maxScroll = Math.max(0, contentLines.length - maxContentRows);
    this.scrollOffset = Math.min(this.scrollOffset, maxScroll);
    const start = Math.max(0, maxScroll - this.scrollOffset);
    const visible = contentLines.slice(start, start + maxContentRows);
    return [
      this.title(inspection.snapshot, width),
      ...visible,
      this.footer(inspection.snapshot),
    ];
  }

  private title(snapshot: RuntimeSnapshot, width: number): string {
    const title = `/agents ${snapshot.id} ${snapshot.status} ${snapshot.type}${roleLabel(snapshot.owner)}`;
    return this.theme.bold(
      truncateToWidth(title, Math.max(1, width), "...", false),
    );
  }

  private footer(snapshot: RuntimeSnapshot): string {
    const actions = terminalStatuses.has(snapshot.status)
      ? "esc: close | ↑/↓: scroll"
      : this.stopArmed
        ? "s: confirm stop | esc: close | ↑/↓: scroll"
        : "s: stop | esc: close | ↑/↓: scroll";
    return this.theme.fg("muted", actions);
  }

  private contentLines(inspection: RuntimeInspection, width: number): string[] {
    const { snapshot } = inspection;
    const lines = [
      `Status: ${snapshot.status}`,
      `Elapsed: ${elapsedLabel(snapshot)}`,
      `Turns/tokens: ${usageLabel(snapshot)}`,
      `Active tool: ${snapshot.health?.activeTool ?? "none"}`,
      `Last activity: ${snapshot.health?.lastActivity ?? "unknown"}`,
      `Owner: ${ownerLabel(snapshot.owner)}`,
      `Description: ${snapshot.description}`,
      transcriptLabel(snapshot),
    ];
    if (this.stopArmed && !terminalStatuses.has(snapshot.status)) {
      lines.push(this.theme.fg("warning", "Press s again to stop this agent."));
    }
    const assistant = previewText(snapshot.health?.lastAssistantText, 1000);
    if (assistant) {
      lines.push("", "Rolling assistant text:");
      lines.push(
        ...wrapTextWithAnsi(assistant, Math.max(1, width - 2)).map(
          (line) => `  ${line}`,
        ),
      );
    }
    const result = previewText(
      snapshot.health?.resultPreview ?? snapshot.result,
      1000,
    );
    if (result) {
      lines.push("", "Result preview:");
      lines.push(
        ...wrapTextWithAnsi(result, Math.max(1, width - 2)).map(
          (line) => `  ${line}`,
        ),
      );
    }
    if (snapshot.error) {
      lines.push("", "Error:");
      lines.push(
        ...wrapTextWithAnsi(snapshot.error, Math.max(1, width - 2)).map(
          (line) => this.theme.fg("error", `  ${line}`),
        ),
      );
    }
    const tail = formatMessageTail(inspection.messages, 8);
    if (tail.length > 0) {
      lines.push("", "Message tail:");
      lines.push(
        ...tail.flatMap((line) =>
          wrapTextWithAnsi(line, Math.max(1, width - 4)).map(
            (wrapped) => `  ${wrapped}`,
          ),
        ),
      );
    }
    return lines;
  }

  private maxContentRows(): number {
    return Math.max(1, this.maxRows - 2);
  }

  private clampScrollOffset(): void {
    const inspection = this.runtime.inspect(this.id);
    const length = inspection
      ? this.contentLines(inspection, this.lastWidth).length
      : 1;
    this.scrollOffset = Math.min(
      this.scrollOffset,
      Math.max(0, length - this.maxContentRows()),
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
  return `${minutes}m${remainder.toString().padStart(2, "0")}s`;
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

function maxWidth(label: string, values: string[]): number {
  return Math.max(label.length, ...values.map((value) => value.length));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
