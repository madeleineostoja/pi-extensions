const QUOTES = "`\"'\u2018\u2019\u201c\u201d\u00ab\u00bb";
const QUOTE_EDGE = new RegExp(`^[${QUOTES}]+|[${QUOTES}]+$`, "g");
const LEADING_LABEL =
  /^(?:title|name|session(?:\s+(?:name|title))?)\s*[:-]\s*/i;

export function sanitizeTitle(raw: string): string | null {
  const first = raw.split(/\r?\n/).find((l) => l.trim().length > 0);
  if (!first) {
    return null;
  }

  let s = first.trim();
  s = s.replace(QUOTE_EDGE, "");
  s = s.replace(LEADING_LABEL, "");
  s = s.replace(QUOTE_EDGE, "");
  s = s.replace(/\s+/g, " ").trim();
  s = s.replace(/[.!?,;:]+$/, "");

  if (!s) {
    return null;
  }

  if (s.length > 40) {
    const cut = s.slice(0, 40);
    const lastSpace = cut.lastIndexOf(" ");
    s = (lastSpace >= 20 ? cut.slice(0, lastSpace) : cut).trimEnd();
    s = s.replace(/[.!?,;:]+$/, "");
    if (!s) {
      return null;
    }
  }

  const boilerplate = /^session\s*(name|title)?\s*[:-]?\s*$/i;
  if (boilerplate.test(s)) {
    return null;
  }

  return s;
}

const MAX_PROMPTS_FOR_TITLE = 3;
const MAX_PROMPT_CONTEXT_CHARS = 2000;

export function buildTitlePrompt(promptContext: string | readonly string[]): {
  systemPrompt: string;
  userText: string;
} {
  const prompts = (
    Array.isArray(promptContext) ? promptContext : [promptContext]
  )
    .map((prompt) => prompt.trim())
    .filter(Boolean)
    .slice(0, MAX_PROMPTS_FOR_TITLE);
  const promptText = formatPromptContext(prompts);
  const basis =
    prompts.length === 1 ? "the first user prompt" : "early user prompts";
  const systemPrompt =
    "You name coding sessions. Reply with a concise title only. No quotes, no punctuation at the end.";
  const userText = `Give this session a short descriptive title (3\u20136 words, max 40 characters) based on ${basis}:\n\n${promptText}`;
  return { systemPrompt, userText };
}

function formatPromptContext(prompts: string[]): string {
  const text =
    prompts.length <= 1
      ? prompts[0] || ""
      : prompts.map((prompt, i) => `Prompt ${i + 1}:\n${prompt}`).join("\n\n");

  if (text.length <= MAX_PROMPT_CONTEXT_CHARS) {
    return text;
  }

  return text.slice(0, MAX_PROMPT_CONTEXT_CHARS).trimEnd();
}
