import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Model, Api, AssistantMessage } from "@earendil-works/pi-ai";
import type { UsageSnapshot } from "./provider.js";
import { getUsage } from "./provider.js";
import { ICON } from "./constants.js";

const LIMIT_INDICATORS = [
  "limit",
  "quota",
  "rate_limit",
  "too many requests",
  "429",
];
const CODEX_INDICATORS = ["codex", "chatgpt", "openai", "wham"];

function hasLimitIndicator(text: string): boolean {
  const lower = text.toLowerCase();
  return LIMIT_INDICATORS.some((ind) => lower.includes(ind));
}

function hasCodexIndicator(text: string): boolean {
  const lower = text.toLowerCase();
  return CODEX_INDICATORS.some((ind) => lower.includes(ind));
}

function isLimitErrorText(text: string): boolean {
  return hasLimitIndicator(text) && hasCodexIndicator(text);
}

export function isCodexLimitError(message: unknown): boolean {
  const msg = message as { role?: string; errorMessage?: unknown };
  if (msg?.role !== "assistant") {
    return false;
  }
  if (typeof msg.errorMessage === "string" && msg.errorMessage.length > 0) {
    return isLimitErrorText(msg.errorMessage);
  }
  return false;
}

export function formatLimitReplacementText(
  snapshot: UsageSnapshot | null,
): string {
  let usageLine = "";

  if (snapshot) {
    const parts: string[] = [];
    if (snapshot.primary !== undefined) {
      parts.push(`5h ${Math.round(snapshot.primary.usedPercent)}%`);
    }
    if (snapshot.secondary !== undefined) {
      parts.push(`W ${Math.round(snapshot.secondary.usedPercent)}%`);
    }
    if (parts.length > 0) {
      usageLine = `\n${ICON} ${parts.join(" ")}`;
    }
  }

  return `🚫 Codex usage limit reached${usageLine}\n\nThe raw Codex error was JSON/escaped JSON. The footer usage snapshot was refreshed when possible.`;
}

export async function buildLimitReplacementMessage(
  original: AssistantMessage,
  model: Model<Api>,
  ctx: ExtensionContext,
): Promise<AssistantMessage> {
  const snapshot = await getUsage(model, ctx, true);
  const replacementText = formatLimitReplacementText(snapshot);

  const originalAssistant = original as unknown as Record<string, unknown>;

  const { errorMessage: _errorMessage, ...withoutErrorMessage } =
    originalAssistant;

  return {
    ...withoutErrorMessage,
    role: "assistant" as const,
    content: [{ type: "text", text: replacementText }],
  } as AssistantMessage;
}
