import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { makeContextHook, restoreEpochs } from "./elision.ts";
import { createPruningState, resetPruningState } from "./policy.ts";
import { appendEpochAtomically } from "./session-append.ts";

export function createPruningFlow(pi: ExtensionAPI) {
  const state = createPruningState();

  return {
    sessionStart(ctx: ExtensionContext): void {
      resetPruningState(state);
      restoreEpochs(state, ctx.sessionManager.getBranch());
    },
    context: makeContextHook(state, (type, data, ctx) =>
      appendEpochAtomically(pi, ctx, type, data),
    ),
  };
}
