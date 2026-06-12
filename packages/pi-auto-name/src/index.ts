import {
  completeSimple,
  getSupportedThinkingLevels,
} from "@earendil-works/pi-ai";
import type { UserMessage } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  CONFIG_RELATIVE_PATH,
  resolveConfiguredModel,
  writeConfig,
} from "./config.js";
import { buildTitlePrompt, parseModelRef, sanitizeTitle } from "./utils.js";

export default function (pi: ExtensionAPI) {
  const titlePromptsThisSession: string[] = [];
  let warnedThisSession = false;
  let attemptedThisSession = false;

  function maybeWarn(ctx: ExtensionContext, message: string) {
    if (warnedThisSession) {
      return;
    }
    warnedThisSession = true;
    if (ctx.mode === "tui") {
      ctx.ui.notify(`[pi-auto-name] ${message}`, "warning");
    }
  }

  pi.on("session_start", async () => {
    titlePromptsThisSession.length = 0;
    warnedThisSession = false;
    attemptedThisSession = false;
  });

  pi.registerCommand("auto-name", {
    description: "Set the pi-auto-name model",
    handler: async (args, ctx) => {
      const modelRef = args.trim();
      if (!modelRef) {
        const current = resolveConfiguredModel(getAgentDir());
        ctx.ui.notify(
          current
            ? `pi-auto-name model: ${current}`
            : `usage: /auto-name provider/model-id`,
          "info",
        );
        return;
      }
      if (/\s/.test(modelRef)) {
        ctx.ui.notify("usage: /auto-name provider/model-id", "warning");
        return;
      }

      const parsed = parseModelRef(modelRef);
      if (!parsed) {
        ctx.ui.notify(`Invalid model reference: ${modelRef}`, "warning");
        return;
      }

      const model = ctx.modelRegistry.find(parsed.provider, parsed.id);
      if (!model) {
        ctx.ui.notify(`Model not found: ${modelRef}`, "warning");
        return;
      }

      writeConfig(getAgentDir(), { model: modelRef });
      warnedThisSession = false;
      attemptedThisSession = false;
      ctx.ui.notify(`pi-auto-name model set: ${modelRef}`, "info");
    },
  });

  pi.on("before_agent_start", async (event, ctx) => {
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

    const agentDir = getAgentDir();
    void generateNameAsync(
      ctx,
      agentDir,
      [...titlePromptsThisSession],
      maybeWarn,
    ).then((result) => {
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
  agentDir: string,
  promptText: string | readonly string[],
  warn: (ctx: ExtensionContext, msg: string) => void,
): Promise<GenerateResult> {
  const localTitle = fallbackTitle(promptText);

  try {
    const configuredModel = resolveConfiguredModel(agentDir);
    if (!configuredModel) {
      if (localTitle) {
        return { outcome: "success", title: localTitle };
      }
      const message = `No model configured. Set ${CONFIG_RELATIVE_PATH} with { "model": "provider/model-id" }.`;
      warn(ctx, message);
      return { outcome: "preflight-failure", message };
    }

    const parsed = parseModelRef(configuredModel);
    if (!parsed) {
      const message = `Invalid model reference: ${configuredModel}`;
      warn(ctx, message);
      return { outcome: "preflight-failure", message };
    }

    const model = ctx.modelRegistry.find(parsed.provider, parsed.id);
    if (!model) {
      const message = `Model not found: ${configuredModel}`;
      warn(ctx, message);
      return { outcome: "preflight-failure", message };
    }

    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok || !auth.apiKey) {
      const message = auth.ok
        ? `No API key for ${model.provider}`
        : `Auth error: ${auth.error}`;
      warn(ctx, message);
      return { outcome: "preflight-failure", message };
    }

    const { systemPrompt, userText } = buildTitlePrompt(promptText);

    const userMessage: UserMessage = {
      role: "user",
      content: [{ type: "text", text: userText }],
      timestamp: Date.now(),
    };

    const supportsReasoningOff =
      getSupportedThinkingLevels(model).includes("off");

    const response = await completeSimple(
      model,
      { systemPrompt, messages: [userMessage] },
      {
        apiKey: auth.apiKey,
        headers: auth.headers,
        maxTokens: supportsReasoningOff ? 96 : 1024,
        ...(supportsReasoningOff ? {} : { reasoning: "minimal" as const }),
        signal: ctx.signal,
      },
    );

    if (response.stopReason === "aborted") {
      return { outcome: "aborted" };
    }
    if (response.stopReason === "error") {
      return {
        outcome: "unknown-error",
        message: response.errorMessage || "Provider returned an error",
      };
    }

    const text = response.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("\n");

    const title = sanitizeTitle(text);
    if (!title) {
      if (localTitle) {
        return { outcome: "success", title: localTitle };
      }
      if (response.stopReason === "length") {
        return {
          outcome: "invalid-output",
          raw: text,
          message: "Model hit token limit without producing text",
        };
      }
      return { outcome: "invalid-output", raw: text };
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
