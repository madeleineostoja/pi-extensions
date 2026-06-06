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

function buildSuffixTokenTable(
  messages: readonly { role?: string; content?: unknown }[],
): number[] {
  const suffixChars: number[] = Array.from(
    { length: messages.length + 1 },
    () => 0,
  );
  for (let i = messages.length - 1; i >= 0; i--) {
    suffixChars[i] = suffixChars[i + 1] + estimateMessageTextChars(messages[i]);
  }
  return suffixChars.map((chars) => Math.ceil(chars / 4));
}

function lookupSuffixTokens(
  suffixTokens: number[],
  afterIndex: number,
): number {
  const idx = Math.max(0, Math.min(suffixTokens.length - 1, afterIndex + 1));
  return suffixTokens[idx];
}

export function estimateSuffixTokens(
  messages: readonly { role?: string; content?: unknown }[],
  afterIndex: number,
): number {
  return lookupSuffixTokens(buildSuffixTokenTable(messages), afterIndex);
}
