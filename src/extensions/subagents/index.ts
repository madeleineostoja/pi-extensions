import {
  getAgentDir,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { loadPipkinConfig } from "#lib/config";
import { showAgentsDashboard } from "./agents-dashboard.js";
import { ForegroundInterruptGuard } from "./foreground-interrupt.js";
import { registerSubagentLifecycle } from "./lifecycle.js";
import { registerPublicAgentTools } from "./public-tools.js";
import { SubagentRosterController } from "./roster.js";
import { getSubagentRuntime } from "./runtime.js";

export default function (pi: ExtensionAPI): void {
  const config = loadPipkinConfig(getAgentDir());
  const runtime = getSubagentRuntime(pi, {
    low: config.config.models.low,
    high: config.config.models.high,
  });
  const roster = new SubagentRosterController(runtime);
  const foregroundInterrupt = new ForegroundInterruptGuard();

  registerSubagentLifecycle({ pi, runtime, roster, foregroundInterrupt });
  pi.registerCommand("agents", {
    description: "Inspect and stop current-session subagents",
    handler: async (_args, ctx) => showAgentsDashboard(runtime, ctx),
  });
  registerPublicAgentTools({
    pi,
    runtime,
    roster,
    foregroundInterrupt,
    configPath: config.path,
    modelPresets: config.config.models,
  });
}
