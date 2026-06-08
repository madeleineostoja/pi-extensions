import { completeSimple } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { addExchange, getHistory, getSessionKey } from "./state.js";
import { buildPrompt } from "./prompt.js";

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
      const abortController = new AbortController();

      try {
        const context = buildPrompt(
          ctx.sessionManager,
          priorExchanges,
          question,
        );
        const response = await completeSimple(ctx.model, context, {
          apiKey: auth.apiKey,
          headers: auth.headers,
          signal: abortController.signal,
        });

        if (response.stopReason === "aborted") {
          ctx.ui.notify("Aborted", "warning");
          return;
        }
        if (response.stopReason === "error") {
          ctx.ui.notify(
            response.errorMessage || "Provider returned an error",
            "error",
          );
          return;
        }

        const text = response.content
          .filter((c): c is { type: "text"; text: string } => c.type === "text")
          .map((c) => c.text)
          .join("\n");

        if (!text.trim()) {
          ctx.ui.notify("Model returned an empty response", "error");
          return;
        }

        addExchange(sessionKey, { question, answer: text });
        ctx.ui.notify(text, "info");
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") {
          ctx.ui.notify("Aborted", "warning");
          return;
        }
        ctx.ui.notify(
          err instanceof Error ? err.message : String(err),
          "error",
        );
      }
    },
  });
}
