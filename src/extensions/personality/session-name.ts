import type { UserMessage } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { completeText } from "#lib/complete";
import type { ModelPreset } from "#lib/config";
import { parseModelRef } from "#lib/model-ref";
import {
  buildImplementTitlePrompt,
  buildTitlePrompt,
  sanitizeTitle,
} from "./utils.js";

export type SessionNameOptions = {
  utility: ModelPreset | undefined;
  utilityIssue: string | undefined;
  configPath: string;
};

type OrdinaryNamingInput = {
  kind: "ordinary";
  promptText: string | readonly string[];
};

type ImplementNamingInput = {
  kind: "implement";
  planExcerpt: string;
};

export type SessionNameResult =
  | { outcome: "success"; title: string }
  | { outcome: "preflight-failure"; message: string }
  | { outcome: "aborted" }
  | { outcome: "invalid-output"; raw?: string; message?: string }
  | { outcome: "unknown-error"; message: string };

export async function generateSessionName(
  ctx: ExtensionContext,
  { utility, utilityIssue, configPath }: SessionNameOptions,
  input: OrdinaryNamingInput | ImplementNamingInput,
  signal: AbortSignal,
): Promise<SessionNameResult> {
  const fallback = fallbackTitle(input);
  if (input.kind === "implement" && !input.planExcerpt.trim()) {
    return { outcome: "success", title: fallback! };
  }

  try {
    if (!utility) {
      return fallback
        ? { outcome: "success", title: fallback }
        : {
            outcome: "preflight-failure",
            message: `Pipkin config ${configPath}: utility preset ${utilityIssue ?? "is unavailable"}.`,
          };
    }

    const parsed = parseModelRef(utility.model);
    if (!parsed) {
      return withImplementFallback(
        input,
        fallback,
        `Pipkin config ${configPath}: utility preset is invalid.`,
      );
    }

    const model = ctx.modelRegistry.find(parsed.provider, parsed.id);
    if (!model) {
      return withImplementFallback(
        input,
        fallback,
        `Model not found: ${utility.model}`,
      );
    }

    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok || !auth.apiKey) {
      return withImplementFallback(
        input,
        fallback,
        auth.ok
          ? `No API key for ${model.provider}`
          : `Auth error: ${auth.error}`,
      );
    }

    const { systemPrompt, userText } = titlePrompt(input);
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
        return input.kind === "implement" && fallback
          ? { outcome: "success", title: fallback }
          : {
              outcome: "unknown-error",
              message: result.message || "Provider returned an error",
            };
      }
      if (fallback) {
        return { outcome: "success", title: fallback };
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
    if (
      !title ||
      (input.kind === "implement" && !/^Implement(?:\s|$)/.test(title))
    ) {
      return fallback
        ? { outcome: "success", title: fallback }
        : { outcome: "invalid-output", raw: result.text };
    }
    return { outcome: "success", title };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return input.kind === "implement" && fallback
      ? { outcome: "success", title: fallback }
      : { outcome: "unknown-error", message };
  }
}

function withImplementFallback(
  input: OrdinaryNamingInput | ImplementNamingInput,
  fallback: string | null,
  message: string,
): SessionNameResult {
  return input.kind === "implement" && fallback
    ? { outcome: "success", title: fallback }
    : { outcome: "preflight-failure", message };
}

function titlePrompt(input: OrdinaryNamingInput | ImplementNamingInput) {
  return input.kind === "ordinary"
    ? buildTitlePrompt(input.promptText)
    : buildImplementTitlePrompt(input.planExcerpt);
}

function fallbackTitle(
  input: OrdinaryNamingInput | ImplementNamingInput,
): string | null {
  if (input.kind === "implement") {
    return "Implement run";
  }
  const prompt = (
    Array.isArray(input.promptText) ? input.promptText : [input.promptText]
  )
    .map((value) => value.trim())
    .find(Boolean);
  return prompt ? sanitizeTitle(prompt) : null;
}
