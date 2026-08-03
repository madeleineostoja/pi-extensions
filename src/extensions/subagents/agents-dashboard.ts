import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { showAgentsSurface } from "./agents-surface.js";
import type { RuntimeSnapshot, SubagentRuntime } from "./runtime.js";

export async function showAgentsDashboard(
  runtimeOrRuntimes: SubagentRuntime | readonly SubagentRuntime[],
  ctx: ExtensionCommandContext,
): Promise<void> {
  if (ctx.mode === "tui" && ctx.hasUI && typeof ctx.ui.custom === "function") {
    await showAgentsSurface(runtimeOrRuntimes, ctx);
    return;
  }
  ctx.ui.notify(staticAgentsProjection(runtimeOrRuntimes), "info");
}

export function staticAgentsProjection(
  runtimeOrRuntimes: SubagentRuntime | readonly SubagentRuntime[],
): string {
  const runtimes = [
    ...new Set(
      Array.isArray(runtimeOrRuntimes)
        ? runtimeOrRuntimes
        : [runtimeOrRuntimes],
    ),
  ];
  const snapshots = runtimes.flatMap((runtime, runtimeIndex) =>
    runtime
      .snapshots({ includeNested: true })
      .map((snapshot: RuntimeSnapshot) => ({
        runtimeIndex,
        snapshot,
      })),
  );
  if (snapshots.length === 0) {
    return "No current-session agents.";
  }
  const active = snapshots.filter(
    ({ snapshot }) =>
      snapshot.status === "queued" || snapshot.status === "running",
  );
  const retained = snapshots.filter(
    ({ snapshot }) =>
      snapshot.status !== "queued" && snapshot.status !== "running",
  );
  return [
    ...staticSection("Active agents", active),
    ...staticSection("Retained agents", retained),
  ]
    .join("\n")
    .slice(0, 4096);
}

function staticSection(
  heading: string,
  entries: readonly { runtimeIndex: number; snapshot: RuntimeSnapshot }[],
): string[] {
  if (entries.length === 0) {
    return [];
  }
  return [
    heading,
    ...entries
      .slice(0, 24)
      .map(
        ({ runtimeIndex, snapshot }) =>
          `${runtimeIndex + 1}. ${snapshot.status} · ${displayType(snapshot)} · ${bounded(snapshot.description, 180)}`,
      ),
  ];
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

function bounded(value: string, maximum: number): string {
  return value
    .replace(/\p{C}/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maximum);
}
