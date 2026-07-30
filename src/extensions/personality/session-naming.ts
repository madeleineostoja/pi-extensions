import type { UserMessage } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { completeText } from "#lib/complete";
import type { ModelPreset } from "#lib/config";
import { parseModelRef } from "#lib/model-ref";
import { buildTitlePrompt, sanitizeTitle } from "./utils.js";

export type SessionNamingOptions = {
  utility: ModelPreset | undefined;
  utilityIssue: string | undefined;
  configPath: string;
};

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

    if (pi.getSessionName()) {
      return;
    }
    if (!prompt) {
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

    void generateNameAsync(
      ctx,
      utility,
      utilityIssue,
      configPath,
      [...titlePromptsThisSession],
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
        const msg =
          result.outcome === "preflight-failure"
            ? result.message
            : result.outcome === "unknown-error"
              ? result.message
              : result.outcome === "aborted"
                ? "Title generation was aborted."
                : result.message || "Model returned an invalid title.";
        maybeWarn(ctx, msg);
      }
    });
  });
}

type GenerateResult =
  | { outcome: "success"; title: string }
  | { outcome: "preflight-failure"; message: string }
  | { outcome: "aborted" }
  | { outcome: "invalid-output"; raw?: string; message?: string }
  | { outcome: "unknown-error"; message: string };

async function generateNameAsync(
  ctx: ExtensionContext,
  utility: ModelPreset | undefined,
  utilityIssue: string | undefined,
  configPath: string,
  promptText: string | readonly string[],
  signal: AbortSignal,
): Promise<GenerateResult> {
  const localTitle = fallbackTitle(promptText);

  try {
    if (!utility) {
      if (localTitle) {
        return { outcome: "success", title: localTitle };
      }
      return {
        outcome: "preflight-failure",
        message: `Pipkin config ${configPath}: utility preset ${utilityIssue ?? "is unavailable"}.`,
      };
    }

    const parsed = parseModelRef(utility.model);
    if (!parsed) {
      return {
        outcome: "preflight-failure",
        message: `Pipkin config ${configPath}: utility preset is invalid.`,
      };
    }

    const model = ctx.modelRegistry.find(parsed.provider, parsed.id);
    if (!model) {
      const message = `Model not found: ${utility.model}`;
      return { outcome: "preflight-failure", message };
    }

    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok || !auth.apiKey) {
      const message = auth.ok
        ? `No API key for ${model.provider}`
        : `Auth error: ${auth.error}`;
      return { outcome: "preflight-failure", message };
    }

    const { systemPrompt, userText } = buildTitlePrompt(promptText);

    const userMessage: UserMessage = {
      role: "user",
      content: [{ type: "text", text: userText }],
      timestamp: Date.now(),
    };

    const result = await completeText(
      model,
      { systemPrompt, messages: [userMessage] },
      {
        apiKey: auth.apiKey,
        headers: auth.headers,
        maxTokens: 1024,
        reasoning: utility.thinking as never,
        signal,
      },
    );

    if (!result.ok) {
      if (result.reason === "aborted") {
        return { outcome: "aborted" };
      }
      if (result.reason === "error") {
        return {
          outcome: "unknown-error",
          message: result.message || "Provider returned an error",
        };
      }
      if (localTitle) {
        return { outcome: "success", title: localTitle };
      }
      if (result.reason === "length") {
        return {
          outcome: "invalid-output",
          raw: result.text,
          message: "Model hit token limit without producing text",
        };
      }
      return { outcome: "invalid-output", raw: result.text };
    }

    const title = sanitizeTitle(result.text);
    if (!title) {
      if (localTitle) {
        return { outcome: "success", title: localTitle };
      }
      return { outcome: "invalid-output", raw: result.text };
    }

    return { outcome: "success", title };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { outcome: "unknown-error", message };
  }
}

function fallbackTitle(promptText: string | readonly string[]): string | null {
  const prompt = (Array.isArray(promptText) ? promptText : [promptText])
    .map((p) => p.trim())
    .find(Boolean);
  return prompt ? sanitizeTitle(prompt) : null;
}
