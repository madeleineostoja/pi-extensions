import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  addExchange,
  clearHistory,
  getHistory,
  getSessionKey,
} from "./state.js";
import { buildPrompt } from "./prompt.js";
import { completeText } from "#lib/complete";
import { BtwPanel } from "./panel.js";

type ActiveBtw = {
  abort: () => void;
  close: () => void;
};

function completionError(result: { reason: string; message?: string }): string {
  if (result.reason === "aborted") {
    return "Aborted";
  }
  if (result.reason === "empty" || result.reason === "length") {
    return "Model returned an empty response";
  }
  return result.message || "Provider returned an error";
}

export function registerBtwCommand(pi: ExtensionAPI): void {
  let active: ActiveBtw | undefined;

  const closeActive = () => {
    active?.abort();
    active?.close();
    active = undefined;
  };

  pi.on("session_start", closeActive);
  pi.on("session_shutdown", closeActive);

  pi.registerCommand("btw", {
    description: "Ask a side question about the current session",
    handler: async (args, ctx) => {
      const question = args.trim();
      if (!question) {
        ctx.ui.notify("usage: /btw <question>", "warning");
        return;
      }
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/btw requires a TUI session", "warning");
        return;
      }
      const model = ctx.model;
      if (!model) {
        ctx.ui.notify("No active model. Set a model first.", "warning");
        return;
      }

      closeActive();
      const sessionKey = getSessionKey(ctx.sessionManager);
      const priorExchanges = [...getHistory(sessionKey)];

      await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
        const abortController = new AbortController();
        let panel: BtwPanel | undefined;
        let startTimer: NodeJS.Timeout | undefined;
        let closed = false;
        const isCurrent = () =>
          !closed && active?.close === close && !abortController.signal.aborted;
        const close = () => {
          if (closed) {
            return;
          }
          closed = true;
          if (startTimer) {
            clearTimeout(startTimer);
            startTimer = undefined;
          }
          abortController.abort();
          if (active?.close === close) {
            active = undefined;
          }
          done();
        };
        panel = new BtwPanel(
          tui,
          theme,
          close,
          {
            question,
            history: priorExchanges,
            status: "pending",
            answerText: "",
            errorText: "",
            scrollOffset: 0,
          },
          abortController,
        );
        panel.onClearHistory = () => clearHistory(sessionKey);
        active = { abort: () => abortController.abort(), close };

        const run = async () => {
          try {
            const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
            if (!isCurrent()) {
              return;
            }
            if (!auth.ok || !auth.apiKey) {
              panel?.setState({
                status: "error",
                errorText: auth.ok
                  ? `No API key for ${model.provider}`
                  : `Auth error: ${auth.error}`,
              });
              return;
            }
            const prompt = buildPrompt(
              ctx.sessionManager,
              priorExchanges,
              question,
              model,
            );
            const result = await completeText(model, prompt.context, {
              apiKey: auth.apiKey,
              headers: auth.headers,
              maxTokens: prompt.maxTokens,
              signal: abortController.signal,
            });
            if (!isCurrent()) {
              return;
            }
            if (!result.ok) {
              panel?.setState({
                status: "error",
                errorText: completionError(result),
              });
              return;
            }
            addExchange(sessionKey, { question, answer: result.text });
            panel?.setState({ status: "answer", answerText: result.text });
          } catch (error) {
            if (!isCurrent()) {
              return;
            }
            panel?.setState({
              status: "error",
              errorText: error instanceof Error ? error.message : String(error),
            });
          }
        };
        startTimer = setTimeout(() => {
          startTimer = undefined;
          void run();
        }, 0);
        return panel;
      });
    },
  });
}
