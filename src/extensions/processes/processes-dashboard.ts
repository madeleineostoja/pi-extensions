import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { ProcessRuntime } from "./runtime.js";
import { showProcessesSurface } from "./processes-surface.js";

export async function showProcessesDashboard(
  runtime: () => ProcessRuntime,
  ctx: ExtensionCommandContext,
): Promise<void> {
  let current: ProcessRuntime | undefined;
  try {
    current = runtime();
  } catch {
    ctx.ui.notify(
      "Managed processes are unavailable for this session.",
      "warning",
    );
    return;
  }
  if (ctx.mode === "tui" && ctx.hasUI && typeof ctx.ui.custom === "function") {
    await showProcessesSurface(current, ctx);
    return;
  }
  ctx.ui.notify(staticProcessesProjection(current), "info");
}

export function staticProcessesProjection(runtime: ProcessRuntime): string {
  const snapshots = runtime.snapshots();
  if (snapshots.length === 0) {
    return "No current-session managed processes.";
  }
  const running = snapshots.filter((snapshot) => snapshot.status === "running");
  const terminal = snapshots.filter(
    (snapshot) => snapshot.status !== "running",
  );
  return [
    ...staticSection("Running processes", running),
    ...staticSection("Stopped processes", terminal),
  ]
    .join("\n")
    .slice(0, 4096);
}

function staticSection(
  heading: string,
  snapshots: ReturnType<ProcessRuntime["snapshots"]>,
): string[] {
  if (snapshots.length === 0) {
    return [];
  }
  return [
    heading,
    ...snapshots
      .slice(0, 24)
      .map(
        (snapshot) =>
          `${snapshot.status} · ${bounded(snapshot.description, 180)}`,
      ),
  ];
}

function bounded(value: string, maximum: number): string {
  return value
    .replace(/\p{C}/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maximum);
}
