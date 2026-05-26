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

export function sanitizeTitle(raw: string): string | null {
  const first = raw.split(/\r?\n/).find((l) => l.trim().length > 0);
  if (!first) return null;

  let s = first.trim();
  s = s.replace(/^[`"']+|[`"']+$/g, "");
  s = s.replace(/\s+/g, " ").trim();
  s = s.replace(/[.!?,;:]+$/, "");

  if (!s || s.length > 40) return null;

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
