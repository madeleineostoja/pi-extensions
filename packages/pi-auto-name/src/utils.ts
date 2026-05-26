export function parseModelRef(
  ref: string,
): { provider: string; id: string } | null {
  const slash = ref.indexOf("/");
  if (slash <= 0 || slash === ref.length - 1) return null;
  return {
    provider: ref.slice(0, slash),
    id: ref.slice(slash + 1),
  };
}

const QUOTES = "`\"'‘’“”«»";
const QUOTE_EDGE = new RegExp(`^[${QUOTES}]+|[${QUOTES}]+$`, "g");
const LEADING_LABEL =
  /^(?:title|name|session(?:\s+(?:name|title))?)\s*[:-]\s*/i;

export function sanitizeTitle(raw: string): string | null {
  const first = raw.split(/\r?\n/).find((l) => l.trim().length > 0);
  if (!first) return null;

  let s = first.trim();
  s = s.replace(QUOTE_EDGE, "");
  s = s.replace(LEADING_LABEL, "");
  s = s.replace(QUOTE_EDGE, "");
  s = s.replace(/\s+/g, " ").trim();
  s = s.replace(/[.!?,;:]+$/, "");

  if (!s) return null;

  if (s.length > 40) {
    const cut = s.slice(0, 40);
    const lastSpace = cut.lastIndexOf(" ");
    s = (lastSpace >= 20 ? cut.slice(0, lastSpace) : cut).trimEnd();
    s = s.replace(/[.!?,;:]+$/, "");
    if (!s) return null;
  }

  const boilerplate = /^session\s*(name|title)?\s*[:-]?\s*$/i;
  if (boilerplate.test(s)) return null;

  return s;
}

export function buildTitlePrompt(firstPrompt: string): {
  systemPrompt: string;
  userText: string;
} {
  const systemPrompt =
    "You name coding sessions. Reply with a concise title only. No quotes, no punctuation at the end.";
  const userText = `Give this session a short descriptive title (3–6 words, max 40 characters) based on the first user prompt:\n\n${firstPrompt}`;
  return { systemPrompt, userText };
}
