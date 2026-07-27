import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { makeContextHook } from "./elision.ts";
import { registerRecallTool } from "./recall.ts";
import { createStatsStore, formatStats } from "./stats.ts";
import { loadConfig } from "./config.ts";
import { createPruningState, resetPruningState } from "./policy.ts";
import {
  ingestAssistantUsage,
  formatTelemetryDiagnostics,
} from "./telemetry.ts";

export default function (pi: ExtensionAPI) {
  const stats = createStatsStore();
  const pruningState = createPruningState();

  const pendingWarnings: string[] = [];
  const config = loadConfig((msg, _level) => pendingWarnings.push(msg));

  pi.on("session_start", (_event, ctx: ExtensionContext) => {
    stats.reset();
    resetPruningState(pruningState);
    for (const msg of pendingWarnings) {
      ctx.ui.notify(msg, "warning");
    }
    pendingWarnings.length = 0;
  });

  pi.on("turn_end", (event) => {
    const msg = event.message as unknown as {
      role?: string;
      provider?: string;
      model?: string;
      timestamp?: number;
      usage?: {
        input?: number;
        output?: number;
        cacheRead?: number;
        cacheWrite?: number;
      };
    };
    ingestAssistantUsage(pruningState, msg, config.adaptivePolicyEnabled);
  });

  pi.on("agent_end", (event) => {
    for (const msg of event.messages as unknown as Array<{
      role?: string;
      provider?: string;
      model?: string;
      timestamp?: number;
      usage?: {
        input?: number;
        output?: number;
        cacheRead?: number;
        cacheWrite?: number;
      };
    }>) {
      ingestAssistantUsage(pruningState, msg, config.adaptivePolicyEnabled);
    }
  });

  pi.on(
    "context",
    makeContextHook(
      config,
      (result) => stats.onElisionPass(result),
      pruningState,
    ),
  );
  registerRecallTool(
    pi,
    (toolName, toolCallId, reason) =>
      stats.onRecall(toolName, toolCallId, reason),
    pruningState,
  );

  pi.registerCommand("context-prune", {
    description: "Show context elision and recall statistics for this session",
    handler: async (_args, ctx) => {
      ctx.ui.notify(
        [
          formatStats(stats.snapshot()),
          "",
          formatTelemetryDiagnostics(pruningState),
        ].join("\n"),
        "info",
      );
    },
  });
}
