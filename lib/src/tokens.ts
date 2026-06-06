export function estimateTextBlockChars(content: unknown): number {
  if (typeof content === "string") {
    return content.length;
  }
  if (!Array.isArray(content)) {
    return 0;
  }
  let chars = 0;
  for (const block of content) {
    if (block?.type === "text" && typeof block.text === "string") {
      chars += block.text.length;
    }
  }
  return chars;
}

export function estimateContentTokens(content: unknown): number {
  return Math.ceil(estimateTextBlockChars(content) / 4);
}

export function estimateMessageTextChars(message: {
  role?: string;
  content?: unknown;
}): number {
  if (
    message.role === "user" ||
    message.role === "assistant" ||
    message.role === "toolResult"
  ) {
    return estimateTextBlockChars(message.content);
  }
  return 0;
}

export function estimateMessageTokens(message: {
  role?: string;
  content?: unknown;
}): number {
  return Math.ceil(estimateMessageTextChars(message) / 4);
}

type TokenMessage = { role?: string; content?: unknown };

const suffixTokenTableCache = new WeakMap<readonly TokenMessage[], number[]>();

function buildSuffixTokenTable(messages: readonly TokenMessage[]): number[] {
  const suffixChars: number[] = Array.from(
    { length: messages.length + 1 },
    () => 0,
  );
  for (let i = messages.length - 1; i >= 0; i--) {
    suffixChars[i] = suffixChars[i + 1] + estimateMessageTextChars(messages[i]);
  }
  return suffixChars.map((chars) => Math.ceil(chars / 4));
}

function getSuffixTokenTable(messages: readonly TokenMessage[]): number[] {
  const cached = suffixTokenTableCache.get(messages);
  if (cached) {
    return cached;
  }
  const suffixTokens = buildSuffixTokenTable(messages);
  suffixTokenTableCache.set(messages, suffixTokens);
  return suffixTokens;
}

function lookupSuffixTokens(
  suffixTokens: number[],
  afterIndex: number,
): number {
  const idx = Math.max(0, Math.min(suffixTokens.length - 1, afterIndex + 1));
  return suffixTokens[idx];
}

export function estimateSuffixTokens(
  messages: readonly TokenMessage[],
  afterIndex: number,
): number {
  return lookupSuffixTokens(getSuffixTokenTable(messages), afterIndex);
}
