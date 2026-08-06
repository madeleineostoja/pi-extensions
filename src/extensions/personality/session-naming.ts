import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { collectPersonalityContext } from "./context.js";
import {
  generateSessionName,
  onImplementNamingClaim,
  type SessionNameOptions,
} from "./session-name.js";

export type SessionNamingOptions = SessionNameOptions;

export function registerSessionNaming(
  pi: ExtensionAPI,
  { utility, utilityIssue, configPath }: SessionNamingOptions,
): void {
  const titlePromptsThisSession: string[] = [];
  let warnedThisSession = false;
  let attemptedThisSession = false;
  let sessionGeneration = 0;
  let titleAbortController: AbortController | undefined;
  let ownershipClaimed = false;
  let removeClaimListener: (() => void) | undefined;

  function maybeWarn(ctx: ExtensionContext, message: string) {
    if (warnedThisSession) {
      return;
    }
    warnedThisSession = true;
    if (ctx.mode === "tui") {
      ctx.ui.notify(`[Personality] ${message}`, "warning");
    }
  }

  function cancelOrdinaryNaming(): void {
    titleAbortController?.abort();
    titleAbortController = undefined;
  }

  pi.on("session_start", async () => {
    sessionGeneration++;
    cancelOrdinaryNaming();
    titlePromptsThisSession.length = 0;
    warnedThisSession = false;
    attemptedThisSession = false;
    ownershipClaimed = false;
    removeClaimListener?.();
    removeClaimListener = onImplementNamingClaim(pi.events, () => {
      ownershipClaimed = true;
      cancelOrdinaryNaming();
    });
  });

  pi.on("session_shutdown", async () => {
    sessionGeneration++;
    cancelOrdinaryNaming();
    removeClaimListener?.();
    removeClaimListener = undefined;
  });

  pi.on("before_agent_start", async (event, ctx) => {
    if (ctx.mode === "print") {
      return;
    }

    const prompt = event.prompt?.trim();
    if (ownershipClaimed || pi.getSessionName() || !prompt) {
      return;
    }
    if (titlePromptsThisSession.length < 3) {
      titlePromptsThisSession.push(prompt);
    }
    if (attemptedThisSession) {
      return;
    }
    attemptedThisSession = true;

    const generation = sessionGeneration;
    const abortController = new AbortController();
    titleAbortController = abortController;
    const signal = ctx.signal
      ? AbortSignal.any([ctx.signal, abortController.signal])
      : abortController.signal;

    const contextPromise =
      ctx.cwd && ctx.sessionManager
        ? collectPersonalityContext(ctx, signal).catch(() => undefined)
        : Promise.resolve(undefined);
    void contextPromise
      .then((context) => {
        if (
          signal.aborted ||
          ownershipClaimed ||
          generation !== sessionGeneration ||
          titleAbortController !== abortController
        ) {
          return undefined;
        }
        return generateSessionName(
          ctx,
          { utility, utilityIssue, configPath },
          {
            kind: "ordinary",
            promptText: [...titlePromptsThisSession],
            context,
          },
          signal,
        );
      })
      .then((result) => {
        if (!result) {
          return;
        }
        if (
          signal.aborted ||
          ownershipClaimed ||
          generation !== sessionGeneration ||
          titleAbortController !== abortController
        ) {
          return;
        }
        titleAbortController = undefined;
        if (result.outcome === "success" && !pi.getSessionName()) {
          pi.setSessionName(result.title);
          if (ctx.mode === "tui" && pi.getSessionName() === result.title) {
            ctx.ui.notify(
              `(•ᴗ•)ゞ I’m calling this one “${result.title}”.`,
              "info",
            );
          }
        }
        if (result.outcome === "unknown-error") {
          attemptedThisSession = false;
        }
        if (result.outcome !== "success" && result.outcome !== "aborted") {
          const message =
            result.outcome === "preflight-failure"
              ? result.message
              : result.outcome === "unknown-error"
                ? result.message
                : result.message || "Model returned an invalid title.";
          maybeWarn(ctx, message);
        }
      })
      .catch((error) => {
        if (
          !signal.aborted &&
          !ownershipClaimed &&
          generation === sessionGeneration
        ) {
          attemptedThisSession = false;
          maybeWarn(
            ctx,
            error instanceof Error ? error.message : String(error),
          );
        }
      });
  });
}
