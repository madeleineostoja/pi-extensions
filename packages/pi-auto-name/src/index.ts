import { completeSimple } from "@earendil-works/pi-ai";
import type { UserMessage } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
  SessionMessageEntry,
} from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { resolveEffectiveModel, readConfig, writeConfig } from "./config.js";
import { buildTitlePrompt, parseModelRef, sanitizeTitle } from "./utils.js";

export default function (pi: ExtensionAPI) {
  let warnedThisSession = false;
  let attemptedThisSession = false;
  let firstPromptText: string | undefined;

  function maybeWarn(ctx: ExtensionContext, message: string) {
    if (warnedThisSession) {
      return;
    }
    warnedThisSession = true;
    if (ctx.hasUI) {
      ctx.ui.notify(`[pi-auto-name] ${message}`, "warning");
    }
  }

  pi.on("session_start", async () => {
    warnedThisSession = false;
    attemptedThisSession = false;
    firstPromptText = undefined;
  });

  pi.on("before_agent_start", async (event, ctx) => {
    const prompt = event.prompt?.trim();
    if (prompt && !firstPromptText) {
      firstPromptText = prompt;
    }

    if (pi.getSessionName()) {
      return;
    }
    if (!prompt) {
      return;
    }
    if (attemptedThisSession) {
      return;
    }

    const agentDir = getAgentDir();
    void generateNameAsync(ctx, agentDir, prompt, maybeWarn).then((result) => {
      if (result.outcome === "success" && !pi.getSessionName()) {
        pi.setSessionName(result.title);
      }
      // Only block future attempts when we succeeded or hit a known
      // pre-flight failure. Transient/unknown errors stay retryable.
      if (result.outcome !== "unknown-error") {
        attemptedThisSession = true;
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

  pi.registerCommand("auto-name", {
    description: "Manage auto session naming",
    handler: async (args, ctx) => {
      const agentDir = getAgentDir();
      const tokens = args.trim().split(/\s+/).filter(Boolean);
      const subcommand = tokens[0];

      if (!subcommand) {
        const name = pi.getSessionName() ?? "(unnamed)";
        const effective = resolveEffectiveModel(agentDir);
        ctx.ui.notify(
          `Session: ${name}\nModel: ${effective.model} (${effective.source})`,
          "info",
        );
        return;
      }

      if (subcommand === "model") {
        const arg = tokens[1];

        if (!arg) {
          const effective = resolveEffectiveModel(agentDir);
          ctx.ui.notify(
            `Model: ${effective.model} (${effective.source})`,
            "info",
          );
          return;
        }

        if (arg === "reset") {
          const config = readConfig(agentDir);
          delete config.model;
          writeConfig(agentDir, config);
          const effective = resolveEffectiveModel(agentDir);
          ctx.ui.notify(`Model reset to default: ${effective.model}`, "info");
          return;
        }

        if (!parseModelRef(arg)) {
          ctx.ui.notify(
            `Invalid model reference: ${arg}. Expected format: provider/model-id`,
            "warning",
          );
          return;
        }

        const config = readConfig(agentDir);
        config.model = arg;
        writeConfig(agentDir, config);
        ctx.ui.notify(`Naming model set to: ${arg}`, "info");
        return;
      }

      if (subcommand === "rename") {
        const force = tokens.includes("--force");
        if (pi.getSessionName() && !force) {
          ctx.ui.notify(
            `Session already named: "${pi.getSessionName()}". Use --force to replace.`,
            "info",
          );
          return;
        }
        const prompt = firstPromptText ?? findFirstUserPrompt(ctx);
        if (!prompt) {
          ctx.ui.notify(
            "No user prompt available to generate a title from.",
            "warning",
          );
          return;
        }

        const result = await generateNameAsync(
          ctx,
          agentDir,
          prompt,
          (_c, msg) => ctx.ui.notify(`[pi-auto-name] ${msg}`, "warning"),
        );

        if (result.outcome === "success") {
          pi.setSessionName(result.title);
          ctx.ui.notify(`Session named: ${result.title}`, "info");
          return;
        }

        const msg =
          result.outcome === "unknown-error"
            ? `Failed to generate session name: ${result.message}`
            : result.outcome === "preflight-failure"
              ? result.message
              : result.outcome === "aborted"
                ? "Title generation was aborted."
                : result.message || "Model returned an invalid title.";
        ctx.ui.notify(`[pi-auto-name] ${msg}`, "warning");
        return;
      }

      ctx.ui.notify(
        "Usage: /auto-name | /auto-name model [<provider/id> | reset] | /auto-name rename [--force]",
        "warning",
      );
    },
  });
}

function findFirstUserPrompt(ctx: ExtensionContext): string | undefined {
  try {
    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type !== "message") {
        continue;
      }
      const msg = (entry as SessionMessageEntry).message;
      if (msg.role !== "user") {
        continue;
      }
      const user = msg as UserMessage;
      if (typeof user.content === "string") {
        const t = user.content.trim();
        if (t) {
          return t;
        }
      } else if (Array.isArray(user.content)) {
        const text = user.content
          .filter((c): c is { type: "text"; text: string } => c.type === "text")
          .map((c) => c.text)
          .join("\n")
          .trim();
        if (text) {
          return text;
        }
      }
    }
  } catch {
    // ignore
  }
  return undefined;
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
  promptText: string,
  warn: (ctx: ExtensionContext, msg: string) => void,
): Promise<GenerateResult> {
  try {
    const effective = resolveEffectiveModel(agentDir);
    const parsed = parseModelRef(effective.model);
    if (!parsed) {
      const message = `Invalid model reference: ${effective.model}`;
      warn(ctx, message);
      return { outcome: "preflight-failure", message };
    }

    const model = ctx.modelRegistry.find(parsed.provider, parsed.id);
    if (!model) {
      const message = `Model not found: ${effective.model}`;
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

    const response = await completeSimple(
      model,
      { systemPrompt, messages: [userMessage] },
      {
        apiKey: auth.apiKey,
        headers: auth.headers,
        maxTokens: 128,
        reasoning: "minimal",
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
