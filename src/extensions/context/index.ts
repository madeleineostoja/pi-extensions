import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { renderEpochEntry } from "./epoch-renderer.ts";
import { EPOCH_TYPE } from "./policy.ts";
import { createPruningFlow } from "./pruning.ts";
import { registerRecallTool } from "./recall.ts";

export default function (pi: ExtensionAPI): void {
  const pruning = createPruningFlow(pi);

  pi.registerEntryRenderer(EPOCH_TYPE, renderEpochEntry);
  pi.on("session_start", (_event, ctx) => pruning.sessionStart(ctx));
  pi.on("context", pruning.context);
  registerRecallTool(pi);
}
