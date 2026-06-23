import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  addExchange,
  clearHistory,
  getHistory,
  getSessionKey,
} from "./state.js";
import { buildPrompt } from "./prompt.js";
import { completeText, registerModalCloseInput } from "@pi-extensions/lib";
import { BtwOverlay } from "./overlay.js";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("btw", {
    description: "Ask a side question about the current session",
    handler: async (args, ctx) => {
      const question = args.trim();
      if (!question) {
        ctx.ui.notify("usage: /btw <question>", "warning");
        return;
      }
      if (!ctx.hasUI) {
        ctx.ui.notify("/btw requires an interactive session", "warning");
        return;
      }
      if (!ctx.model) {
        ctx.ui.notify("No active model. Set a model first.", "warning");
        return;
      }

      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
      if (!auth.ok || !auth.apiKey) {
        const message = auth.ok
          ? `No API key for ${ctx.model.provider}`
          : `Auth error: ${auth.error}`;
        ctx.ui.notify(message, "warning");
        return;
      }

      const sessionKey = getSessionKey(ctx.sessionManager);
      const priorExchanges = [...getHistory(sessionKey)];

      let cleanupTerminalInput: (() => void) | undefined;
      await ctx.ui.custom<void>(
        (tui, theme, _kb, done) => {
          const abortController = new AbortController();
          const finish = () => {
            cleanupTerminalInput?.();
            cleanupTerminalInput = undefined;
            done();
          };
          const overlay = new BtwOverlay(
            tui,
            theme,
            finish,
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

          cleanupTerminalInput = registerModalCloseInput(ctx.ui, () =>
            overlay.close(),
          );
          overlay.onClearHistory = () => clearHistory(sessionKey);

          const run = async () => {
            try {
              const context = buildPrompt(
                ctx.sessionManager,
                priorExchanges,
                question,
              );
              const result = await completeText(ctx.model!, context, {
                apiKey: auth.apiKey,
                headers: auth.headers,
                signal: abortController.signal,
              });

              if (!result.ok) {
                overlay.setState({
                  status: "error",
                  errorText:
                    result.reason === "aborted"
                      ? "Aborted"
                      : result.reason === "empty" || result.reason === "length"
                        ? "Model returned an empty response"
                        : result.message || "Provider returned an error",
                });
                return;
              }

              addExchange(sessionKey, { question, answer: result.text });
              overlay.setState({ status: "answer", answerText: result.text });
            } catch (err) {
              overlay.setState({
                status: "error",
                errorText: err instanceof Error ? err.message : String(err),
              });
            }
          };

          run();

          return overlay;
        },
        { overlay: true },
      );
    },
  });
}
