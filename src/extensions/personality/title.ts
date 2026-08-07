import type { PersonalityContext } from "./context.js";

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

  const boilerplate = /^session\s*(name|title)?\s*[:-]?\s*$/i;
  if (boilerplate.test(s)) {
    return null;
  }

  return s;
}

const MAX_PROMPTS_FOR_TITLE = 3;
const MAX_PROMPT_CONTEXT_CHARS = 2_000;

export function buildTitlePrompt(
  promptContext: string | readonly string[],
  context?: PersonalityContext,
): { systemPrompt: string; userText: string } {
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
  const userText = `Give this session a short descriptive title (usually 3–6 words) based on ${basis}. Return a complete, natural phrase; never end with a dangling conjunction or preposition. The current request is authoritative: repository context may disambiguate it, never replace its subject or make incidental Git state the title. Put the task-identifying semantic core first. Only add a short continuity suffix such as “— again” or “Continue …” when recent sessions genuinely support it.\n\nCurrent request:\n${promptText}${formatRepositoryContext(context)}`;
  return { systemPrompt, userText };
}

export function buildImplementTitlePrompt(
  planExcerpt: string,
  context?: PersonalityContext,
): { systemPrompt: string; userText: string } {
  return {
    systemPrompt:
      "You name coding sessions. This is an active Pipkin Implement run. Reply with a concise title only, beginning with Implement. No quotes, no punctuation at the end.",
    userText: `Give this active Implement run a short descriptive title (usually 3–6 words after “Implement”). Return a complete, natural phrase; never end with a dangling conjunction or preposition. The bounded root plan excerpt is authoritative: repository context may only disambiguate it. Begin with “Implement ” followed by the task-identifying core. Use a brief continuity suffix only with strong recent-session evidence; Git activity alone never justifies it.\n\nRoot plan excerpt:\n${planExcerpt}${formatRepositoryContext(context)}`,
  };
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

function formatRepositoryContext(
  context: PersonalityContext | undefined,
): string {
  if (!context) {
    return "";
  }
  const lines = ["\n\nRepository context:"];
  if (context.branch) {
    lines.push(`Branch: ${context.branch}`);
  }
  if (context.changedAreas.length) {
    lines.push(`Changed areas: ${context.changedAreas.join(", ")}`);
  }
  if (context.recentCommits.length) {
    lines.push(
      "Recent commits:",
      ...context.recentCommits.map((commit) => `- ${commit.subject}`),
    );
  }
  if (context.recentSessions.length) {
    lines.push(
      "Recent sessions:",
      ...context.recentSessions.map((session) => `- ${session.title}`),
    );
  }
  return lines.length === 1 ? "" : lines.join("\n");
}
