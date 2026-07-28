import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { makeContextHook, restoreEpochs } from "./elision.ts";
import { createPruningState, resetPruningState } from "./policy.ts";
import { registerRecallTool } from "./recall.ts";
import { appendEpochAtomically } from "./session-append.ts";

export default function (pi: ExtensionAPI) {
  const state = createPruningState();

  pi.on("session_start", (_event, ctx: ExtensionContext) => {
    resetPruningState(state);
    restoreEpochs(state, ctx.sessionManager.getBranch());
  });

  pi.on(
    "context",
    makeContextHook(state, (type, data, ctx) =>
      appendEpochAtomically(pi, ctx, type, data),
    ),
  );
  registerRecallTool(pi);
}
