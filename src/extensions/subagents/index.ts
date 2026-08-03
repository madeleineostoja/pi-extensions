import {
  getAgentDir,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { loadPipkinConfig } from "#lib/config";
import { showAgentsDashboard } from "./agents-dashboard.js";
import { SubagentActivityProjector } from "./activity-projector.js";
import { ForegroundInterruptGuard } from "./foreground-interrupt.js";
import { registerSubagentLifecycle } from "./lifecycle.js";
import { registerPublicAgentTools } from "./public-tools.js";
import { getSubagentRuntime } from "./runtime.js";

export default function (pi: ExtensionAPI): void {
  const config = loadPipkinConfig(getAgentDir());
  const runtime = getSubagentRuntime(pi, {
    low: config.config.models.low,
    high: config.config.models.high,
  });
  const activity = new SubagentActivityProjector(runtime, pi.events);
  const foregroundInterrupt = new ForegroundInterruptGuard();

  registerSubagentLifecycle({ pi, runtime, activity, foregroundInterrupt });
  pi.registerCommand("agents", {
    description: "Inspect and stop current-session subagents",
    handler: async (_args, ctx) => showAgentsDashboard(runtime, ctx),
  });
  registerPublicAgentTools({
    pi,
    runtime,
    foregroundInterrupt,
    configPath: config.path,
    modelPresets: config.config.models,
  });
}
