import { completeSimple } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  addExchange,
  clearHistory,
  getHistory,
  getSessionKey,
} from "./state.js";
import { buildPrompt } from "./prompt.js";
import { registerModalCloseInput } from "@pi-extensions/lib";
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
              const response = await completeSimple(ctx.model!, context, {
                apiKey: auth.apiKey,
                headers: auth.headers,
                signal: abortController.signal,
              });

              if (response.stopReason === "aborted") {
                overlay.setState({ status: "error", errorText: "Aborted" });
                return;
              }
              if (response.stopReason === "error") {
                overlay.setState({
                  status: "error",
                  errorText:
                    response.errorMessage || "Provider returned an error",
                });
                return;
              }

              const text = response.content
                .filter(
                  (c): c is { type: "text"; text: string } => c.type === "text",
                )
                .map((c) => c.text)
                .join("\n");

              if (!text.trim()) {
                overlay.setState({
                  status: "error",
                  errorText: "Model returned an empty response",
                });
                return;
              }

              addExchange(sessionKey, { question, answer: text });
              overlay.setState({ status: "answer", answerText: text });
            } catch (err) {
              if (err instanceof Error && err.name === "AbortError") {
                overlay.setState({ status: "error", errorText: "Aborted" });
                return;
              }
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
