import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Model, Api, AssistantMessage } from "@earendil-works/pi-ai";
import type { UsageSnapshot } from "./usage.js";
import { getUsage } from "./usage.js";
import { ICON } from "./constants.js";

const LIMIT_INDICATORS = [
  "limit",
  "quota",
  "rate_limit",
  "too many requests",
  "429",
];
const CODEX_INDICATORS = ["codex", "chatgpt", "openai", "wham"];
const LEAF_NAMES = new Set(["message", "error", "detail", "details", "code"]);

function extractTextFromMessage(message: unknown): string {
  const msg = message as {
    role?: string;
    content?: unknown;
    errorMessage?: unknown;
  };

  let text = "";

  const content = msg?.content;
  if (Array.isArray(content)) {
    for (const part of content) {
      const p = part as { type?: string; text?: string };
      if (p?.type === "text" && typeof p.text === "string") {
        text += p.text;
      }
    }
  } else if (typeof content === "string") {
    text = content;
  }

  if (typeof msg?.errorMessage === "string") {
    text += msg.errorMessage;
  }

  return text;
}

function tryParseJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

function tryUnescapeAndParse(s: string): unknown {
  // Handle a JSON string that contains an escaped JSON object, e.g. "{\"key\":\"value\"}"
  const unquoted = tryParseJson(s);
  if (typeof unquoted === "string") {
    return tryParseJson(unquoted);
  }
  return undefined;
}

function extractBalancedJsonSubstrings(text: string): unknown[] {
  const results: unknown[] = [];
  let i = 0;
  while (i < text.length) {
    const start = text.indexOf("{", i);
    if (start === -1) break;

    let depth = 0;
    let j = start;
    while (j < text.length) {
      if (text[j] === "{") depth++;
      else if (text[j] === "}") {
        depth--;
        if (depth === 0) {
          const candidate = text.slice(start, j + 1);
          const parsed = tryParseJson(candidate);
          if (parsed !== undefined) {
            results.push(parsed);
          }
          break;
        }
      }
      j++;
    }
    i = start + 1;
  }
  return results;
}

function collectLeafStrings(obj: unknown, depth = 0): string[] {
  if (depth > 10) return [];
  if (typeof obj === "string") return [obj];
  if (Array.isArray(obj)) {
    return obj.flatMap((item) => collectLeafStrings(item, depth + 1));
  }
  if (obj !== null && typeof obj === "object") {
    const record = obj as Record<string, unknown>;
    const leaves: string[] = [];
    for (const [key, val] of Object.entries(record)) {
      const lowerKey = key.toLowerCase();
      const isRelevantKey =
        LEAF_NAMES.has(lowerKey) ||
        lowerKey.includes("rate limit") ||
        lowerKey.includes("quota") ||
        lowerKey.includes("usage limit") ||
        lowerKey.includes("limit reached") ||
        lowerKey.includes("too many requests") ||
        lowerKey.includes("429") ||
        lowerKey.includes("codex") ||
        lowerKey.includes("chatgpt");

      if (isRelevantKey && typeof val === "string") {
        leaves.push(val);
      }
      leaves.push(...collectLeafStrings(val, depth + 1));
    }
    return leaves;
  }
  return [];
}

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

function checkParsedObject(parsed: unknown): boolean {
  const leaves = collectLeafStrings(parsed);
  for (const leaf of leaves) {
    if (isLimitErrorText(leaf)) return true;
  }
  // Also check if the combined stringified content looks like a limit error
  const combined = leaves.join(" ");
  return hasLimitIndicator(combined) && hasCodexIndicator(combined);
}

export function isCodexLimitError(message: unknown): boolean {
  const msg = message as { role?: string };
  if (msg?.role !== "assistant") return false;

  const rawText = extractTextFromMessage(message);
  if (!rawText) return false;

  // Fast path: plain text match
  if (isLimitErrorText(rawText)) return true;

  // Try direct JSON parse
  const direct = tryParseJson(rawText.trim());
  if (direct !== undefined && checkParsedObject(direct)) return true;

  // Try quoted/escaped JSON parse (JSON string containing JSON)
  const unescaped = tryUnescapeAndParse(rawText.trim());
  if (unescaped !== undefined && checkParsedObject(unescaped)) return true;

  // Try extracting balanced JSON substrings from the text
  const substrings = extractBalancedJsonSubstrings(rawText);
  for (const sub of substrings) {
    if (checkParsedObject(sub)) return true;
    // Also try nested extraction from string values within the parsed object
    const leaves = collectLeafStrings(sub);
    for (const leaf of leaves) {
      const nestedDirect = tryParseJson(leaf);
      if (nestedDirect !== undefined && checkParsedObject(nestedDirect))
        return true;
      const nestedUnescaped = tryUnescapeAndParse(leaf);
      if (nestedUnescaped !== undefined && checkParsedObject(nestedUnescaped))
        return true;
    }
  }

  return false;
}

export function formatLimitReplacementText(
  snapshot: UsageSnapshot | null,
): string {
  let usageLine = "";

  if (snapshot) {
    const parts: string[] = [];
    if (snapshot.fiveHour !== undefined) {
      parts.push(`5h ${Math.round(snapshot.fiveHour.usedPercent)}%`);
    }
    if (snapshot.weekly !== undefined) {
      parts.push(`W ${Math.round(snapshot.weekly.usedPercent)}%`);
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
