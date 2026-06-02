import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { makeContextHook } from "./elision.ts";
import { registerRecallTool } from "./recall.ts";
import { createStatsStore, formatStats } from "./stats.ts";
import { loadConfig } from "./config.ts";
import { createPruningState, resetPruningState } from "./policy.ts";

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
      ctx.ui.notify(formatStats(stats.snapshot()), "info");
    },
  });
}
