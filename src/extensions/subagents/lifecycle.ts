import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { SubagentActivityProjector } from "./activity-projector.js";
import type { SubagentRuntime } from "./runtime.js";

export function registerSubagentLifecycle({
  pi,
  runtime,
  activity,
}: {
  pi: ExtensionAPI;
  runtime: SubagentRuntime;
  activity: SubagentActivityProjector;
}): void {
  pi.on("session_shutdown", async (event: { reason?: string } = {}) => {
    activity.dispose();
    runtime.handleSessionShutdown(event.reason);
    await runtime.waitForShutdown();
  });

  pi.on("session_start", (event: { reason?: string } = {}, ctx) => {
    activity.dispose();
    runtime.beginSession(event.reason);
    activity.start((message, level) => ctx.ui.notify(message, level));
  });
}
