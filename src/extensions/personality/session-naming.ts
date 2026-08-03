import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  generateSessionName,
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

  function maybeWarn(ctx: ExtensionContext, message: string) {
    if (warnedThisSession) {
      return;
    }
    warnedThisSession = true;
    if (ctx.mode === "tui") {
      ctx.ui.notify(`[Personality] ${message}`, "warning");
    }
  }

  pi.on("session_start", async () => {
    sessionGeneration++;
    titleAbortController?.abort();
    titleAbortController = undefined;
    titlePromptsThisSession.length = 0;
    warnedThisSession = false;
    attemptedThisSession = false;
  });

  pi.on("session_shutdown", async () => {
    sessionGeneration++;
    titleAbortController?.abort();
    titleAbortController = undefined;
  });

  pi.on("before_agent_start", async (event, ctx) => {
    if (ctx.mode === "print") {
      return;
    }

    const prompt = event.prompt?.trim();
    if (pi.getSessionName() || !prompt) {
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

    void generateSessionName(
      ctx,
      { utility, utilityIssue, configPath },
      { kind: "ordinary", promptText: [...titlePromptsThisSession] },
      signal,
    ).then((result) => {
      if (generation !== sessionGeneration) {
        return;
      }
      titleAbortController = undefined;
      if (result.outcome === "success" && !pi.getSessionName()) {
        pi.setSessionName(result.title);
      }
      if (result.outcome === "unknown-error") {
        attemptedThisSession = false;
      }
      if (result.outcome !== "success") {
        const message =
          result.outcome === "preflight-failure"
            ? result.message
            : result.outcome === "unknown-error"
              ? result.message
              : result.outcome === "aborted"
                ? "Title generation was aborted."
                : result.message || "Model returned an invalid title.";
        maybeWarn(ctx, message);
      }
    });
  });
}
