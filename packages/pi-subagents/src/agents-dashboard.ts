import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type {
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

  const rows = topLevel.map((snapshot) => formatListRow(snapshot));
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
  return ["Current-session agents", ...snapshots.map(formatListRow)].join("\n");
}

async function showAgentDetail(
  runtime: SubagentRuntime,
  ctx: ExtensionCommandContext,
  id: string,
): Promise<void> {
  const snapshot = runtime.snapshot(id);
  if (!snapshot) {
    ctx.ui.notify(`Agent ${id} is no longer available.`, "warning");
    return;
  }
  const all = runtime.snapshots({ includeNested: true });
  const children = all.filter(
    (child) => nestedOwner(child.owner)?.parentId === id,
  );
  const detail = formatDetail(snapshot, children);
  if (!terminalStatuses.has(snapshot.status)) {
    const choice = await ctx.ui.select(detail, ["Stop agent", "Close"]);
    if (choice === "Stop agent") {
      runtime.stop(snapshot.id);
      ctx.ui.notify(`Stopped agent ${snapshot.id}.`, "warning");
    }
    return;
  }
  ctx.ui.notify(detail, "info");
}

export function formatListRow(snapshot: RuntimeSnapshot): string {
  return [
    `${snapshot.id} ${snapshot.status}`,
    `${snapshot.type}${roleLabel(snapshot)}`,
    ownerLabel(snapshot.owner),
    elapsedLabel(snapshot),
    healthLabel(snapshot),
    activityLabel(snapshot),
    snapshot.description,
  ]
    .filter(Boolean)
    .join(" · ");
}

export function formatDetail(
  snapshot: RuntimeSnapshot,
  children: RuntimeSnapshot[] = [],
): string {
  const owner = nestedOwner(snapshot.owner);
  const lines = [
    `Agent ${snapshot.id}`,
    `Type/role: ${snapshot.type}${roleLabel(snapshot)}`,
    `Owner: ${ownerLabel(snapshot.owner)}`,
    `Parent id: ${owner?.parentId ?? "none"}`,
    `Status: ${snapshot.status}`,
    `Description: ${snapshot.description}`,
    `Model: ${snapshot.model ?? "unknown"}`,
    `Thinking: ${snapshot.thinking ?? "unknown"}`,
    `CWD: ${snapshot.cwd}`,
    `Sandbox: ${snapshot.sandboxMode ?? "inherit"}`,
    `Extension binding: ${snapshot.extensionBinding}`,
    `Elapsed: ${elapsedLabel(snapshot)}`,
    `Health: ${healthLabel(snapshot) || "unavailable"}`,
    `Active tool/last activity: ${activityLabel(snapshot) || "none"}`,
  ];
  const preview =
    snapshot.health?.lastAssistantText ?? snapshot.health?.resultPreview;
  if (preview) {
    lines.push(`Last assistant/result: ${preview}`);
  }
  if (snapshot.error) {
    lines.push(`Error: ${snapshot.error}`);
  }
  if (
    snapshot.health?.transcript?.sessionFile ||
    snapshot.health?.transcript?.sessionId
  ) {
    lines.push(
      `Transcript: ${[
        snapshot.health.transcript.sessionFile,
        snapshot.health.transcript.sessionId,
      ]
        .filter(Boolean)
        .join(" · ")}`,
    );
  } else {
    lines.push("Transcript: unavailable");
  }
  lines.push("Nested explore children:");
  if (children.length === 0) {
    lines.push("- none");
  } else {
    lines.push(...children.map((child) => `- ${formatListRow(child)}`));
  }
  return lines.join("\n");
}

function roleLabel(snapshot: RuntimeSnapshot): string {
  const lowerDescription = snapshot.description.toLowerCase();
  const knownRoles = ["implementer", "reviewer", "planner", "triage"];
  const role = knownRoles.find((candidate) =>
    lowerDescription.includes(candidate),
  );
  if (role) {
    return `/${role}`;
  }
  const owner = snapshot.owner;
  if (
    typeof owner === "object" &&
    owner.kind === "internal" &&
    owner.name === "pi-implement"
  ) {
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
    return "elapsed unknown";
  }
  const seconds = Math.max(0, Math.round((end - start) / 1000));
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}m${remainder.toString().padStart(2, "0")}s`;
}

function healthLabel(snapshot: RuntimeSnapshot): string {
  const health = snapshot.health;
  if (!health) {
    return "";
  }
  return [
    health.turns === undefined ? undefined : `${health.turns} turns`,
    health.toolUses === undefined ? undefined : `${health.toolUses} tools`,
    health.tokensTotal === undefined
      ? undefined
      : `${health.tokensTotal} tokens`,
  ]
    .filter(Boolean)
    .join(" · ");
}

function activityLabel(snapshot: RuntimeSnapshot): string {
  const health = snapshot.health;
  if (!health?.activeTool && !health?.lastActivity) {
    return "";
  }
  return [
    health.activeTool ? `tool ${health.activeTool}` : undefined,
    health.lastActivity ? `activity ${health.lastActivity}` : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
}
