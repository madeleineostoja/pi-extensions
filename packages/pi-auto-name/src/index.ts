import { complete } from "@earendil-works/pi-ai";
import type { UserMessage } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { resolveEffectiveModel } from "./config.js";
import { buildTitlePrompt, parseModelRef, sanitizeTitle } from "./utils.js";

export default function (pi: ExtensionAPI) {
  let warnedThisSession = false;
  let firstPromptText: string | undefined;

  function maybeWarn(ctx: ExtensionContext, message: string) {
    if (warnedThisSession) return;
    warnedThisSession = true;
    if (ctx.hasUI) {
      ctx.ui.notify(`[pi-auto-name] ${message}`, "warning");
    }
  }

  pi.on("session_start", async () => {
    warnedThisSession = false;
    firstPromptText = undefined;
  });

  pi.on("before_agent_start", async (event, ctx) => {
    const prompt = event.prompt?.trim();
    if (prompt && !firstPromptText) {
      firstPromptText = prompt;
    }

    if (pi.getSessionName()) return;
    if (!prompt) return;

    const agentDir = getAgentDir();
    const effective = resolveEffectiveModel(agentDir);
    const parsed = parseModelRef(effective.model);
    if (!parsed) {
      maybeWarn(ctx, `Invalid model reference: ${effective.model}`);
      return;
    }

    const model = ctx.modelRegistry.find(parsed.provider, parsed.id);
    if (!model) {
      maybeWarn(ctx, `Model not found: ${effective.model}`);
      return;
    }

    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok || !auth.apiKey) {
      maybeWarn(
        ctx,
        auth.ok
          ? `No API key for ${model.provider}`
          : `Auth error: ${auth.error}`,
      );
      return;
    }

    void generateNameAsync(
      pi,
      ctx,
      model,
      auth.apiKey,
      auth.headers,
      prompt,
      false,
    );
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

      if (subcommand === "regen") {
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

        const effective = resolveEffectiveModel(agentDir);
        const parsed = parseModelRef(effective.model);
        if (!parsed) {
          ctx.ui.notify(
            `Invalid model reference: ${effective.model}`,
            "warning",
          );
          return;
        }

        const model = ctx.modelRegistry.find(parsed.provider, parsed.id);
        if (!model) {
          ctx.ui.notify(`Model not found: ${effective.model}`, "warning");
          return;
        }

        const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
        if (!auth.ok || !auth.apiKey) {
          ctx.ui.notify(
            auth.ok
              ? `No API key for ${model.provider}`
              : `Auth error: ${auth.error}`,
            "warning",
          );
          return;
        }

        const title = await generateNameAsync(
          pi,
          ctx,
          model,
          auth.apiKey,
          auth.headers,
          prompt,
          force,
        );

        if (title) {
          ctx.ui.notify(`Session named: ${title}`, "info");
        } else {
          ctx.ui.notify("Failed to generate a valid session name.", "warning");
        }
        return;
      }

      ctx.ui.notify(
        "Unknown subcommand. Usage: /auto-name [regen [--force]]",
        "warning",
      );
    },
  });
}

function findFirstUserPrompt(ctx: ExtensionContext): string | undefined {
  try {
    for (const entry of ctx.sessionManager.getEntries()) {
      if (
        entry.type === "message" &&
        (entry.message as { role?: string }).role === "user"
      ) {
        const msg = entry.message as {
          content?: Array<{ type: string; text?: string }> | string;
          text?: string;
        };
        if (typeof msg.content === "string") {
          return msg.content.trim();
        }
        if (Array.isArray(msg.content)) {
          const text = msg.content
            .filter(
              (c): c is { type: "text"; text: string } =>
                c.type === "text" && typeof c.text === "string",
            )
            .map((c) => c.text)
            .join("\n");
          if (text.trim()) return text.trim();
        }
        if (typeof msg.text === "string") {
          return msg.text.trim();
        }
      }
    }
  } catch {
    // ignore
  }
  return undefined;
}

async function generateNameAsync(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  model: Parameters<typeof complete>[0],
  apiKey: string,
  headers: Record<string, string> | undefined,
  promptText: string,
  force: boolean,
): Promise<string | null> {
  try {
    const { systemPrompt, userText } = buildTitlePrompt(promptText);

    const userMessage: UserMessage = {
      role: "user",
      content: [{ type: "text", text: userText }],
      timestamp: Date.now(),
    };

    const response = await complete(
      model,
      { systemPrompt, messages: [userMessage] },
      {
        apiKey,
        headers,
        maxTokens: 64,
        temperature: 0.3,
        signal: ctx.signal,
      },
    );

    if (response.stopReason === "aborted") return null;

    const text = response.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("\n");

    const title = sanitizeTitle(text);
    if (!title) return null;

    if (!force && pi.getSessionName()) return null;

    pi.setSessionName(title);
    return title;
  } catch {
    return null;
  }
}
