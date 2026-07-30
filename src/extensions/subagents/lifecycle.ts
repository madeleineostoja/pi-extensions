import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ForegroundInterruptGuard } from "./foreground-interrupt.js";
import type { SubagentRosterController } from "./roster.js";
import type { SubagentRuntime } from "./runtime.js";

export function registerSubagentLifecycle({
  pi,
  runtime,
  roster,
  foregroundInterrupt,
}: {
  pi: ExtensionAPI;
  runtime: SubagentRuntime;
  roster: SubagentRosterController;
  foregroundInterrupt: ForegroundInterruptGuard;
}): void {
  pi.on("session_shutdown", async (event: { reason?: string } = {}) => {
    roster.dispose();
    foregroundInterrupt.dispose();
    runtime.handleSessionShutdown(event.reason);
    await runtime.waitForShutdown();
  });

  pi.on("session_start", (event: { reason?: string } = {}, ctx) => {
    roster.dispose();
    runtime.beginSession(event.reason);
    foregroundInterrupt.install(ctx);
  });
}
