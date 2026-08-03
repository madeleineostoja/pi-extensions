import { Defuddle, type DefuddleResponse } from "defuddle/node";
import { parseHTML } from "linkedom";
import { assertActive, type Deadline } from "./cancellation.js";
import type { NormalizedWebFetchInput } from "./schema.js";
import type { WebTransport } from "./transport.js";
import { WebError } from "./errors.js";

export type ExtractedPage = {
  content: string;
  title?: string;
  site?: string;
  published?: string;
  alternates: string[];
};

type ExtractionDependencies = {
  transport: WebTransport;
  parentSignal?: AbortSignal;
  deadline: Deadline;
};

export async function extractHtml(
  html: string,
  url: string,
  input: NormalizedWebFetchInput,
  dependencies: ExtractionDependencies,
): Promise<ExtractedPage> {
  assertActive(dependencies.deadline, dependencies.parentSignal);
  const { document } = parseHTML(html);
  assertActive(dependencies.deadline, dependencies.parentSignal);
  const alternates = alternateLinks(document, url, input.format);
  let nestedFailure: unknown;
  assertActive(dependencies.deadline, dependencies.parentSignal);
  let extracted: DefuddleResponse;
  try {
    extracted = await Defuddle(document, url, {
      markdown: input.format === "markdown",
      separateMarkdown: false,
      removeImages: input.removeImages,
      includeReplies: input.includeReplies,
      fetch: async (request, init) => {
        try {
          return await dependencies.transport.fetch(
            request,
            init,
            dependencies.parentSignal,
            dependencies.deadline,
          );
        } catch (error) {
          nestedFailure ??= error;
          throw error;
        }
      },
    });
  } catch {
    assertActive(dependencies.deadline, dependencies.parentSignal);
    extracted = { content: "" } as DefuddleResponse;
  }
  assertActive(dependencies.deadline, dependencies.parentSignal);
  if (nestedFailure) {
    throw nestedFailure;
  }
  const content = selectExtractedContent(extracted, input.format);
  if (useful(content)) {
    return {
      content,
      title: optional(extracted.title),
      site: optional(extracted.site),
      published: optional(extracted.published),
      alternates,
    };
  }
  const fallback = fallbackContent(html, input.format, dependencies);
  if (!useful(fallback)) {
    throw new WebError(
      "extract",
      "Web Fetch could not find readable content; the page may require JavaScript.",
    );
  }
  return {
    content: fallback,
    title: optional(document.title),
    alternates,
  };
}

export function renderNonHtml(
  text: string,
  format: NormalizedWebFetchInput["format"],
  contentType: string,
): string {
  if (format === "text" || format === "markdown") {
    return text;
  }
  if (format === "html") {
    return `<pre>${escapeHtml(text)}</pre>`;
  }
  if (!isJson(contentType)) {
    throw new WebError(
      "content",
      "Web Fetch format json requires a JSON response.",
    );
  }
  try {
    return JSON.stringify(JSON.parse(text), undefined, 2);
  } catch {
    throw new WebError("content", "Web Fetch received malformed JSON.");
  }
}

export function renderJson(
  text: string,
  format: NormalizedWebFetchInput["format"],
): string {
  let formatted: string;
  try {
    formatted = JSON.stringify(JSON.parse(text), undefined, 2);
  } catch {
    throw new WebError("content", "Web Fetch received malformed JSON.");
  }
  if (format === "html") {
    return `<pre>${escapeHtml(formatted)}</pre>`;
  }
  return format === "markdown" ? `\`\`\`json\n${formatted}\n\`\`\`` : formatted;
}

export function isHtml(contentType: string): boolean {
  return /(?:^|\/)html(?:;|$)|application\/xhtml\+xml/iu.test(contentType);
}

export function isJson(contentType: string): boolean {
  return /(?:^|\/)json(?:;|$)|\+json(?:;|$)/iu.test(contentType);
}

export function isReadableText(contentType: string): boolean {
  return /^(?:text\/(?:plain|markdown|x-markdown))(?:;|$)/iu.test(contentType);
}

function selectExtractedContent(
  result: DefuddleResponse,
  format: NormalizedWebFetchInput["format"],
): string {
  if (format === "markdown") {
    return result.content;
  }
  if (format === "text") {
    return stripHtml(result.content);
  }
  if (format === "html") {
    return result.content;
  }
  throw new WebError(
    "content",
    "Web Fetch format json requires a JSON response.",
  );
}

function fallbackContent(
  html: string,
  format: NormalizedWebFetchInput["format"],
  dependencies: ExtractionDependencies,
): string {
  assertActive(dependencies.deadline, dependencies.parentSignal);
  const { document } = parseHTML(html);
  for (const element of document.querySelectorAll(
    "script, style, noscript, template, [hidden], [aria-hidden='true']",
  )) {
    element.remove();
  }
  const text = (document.body.textContent ?? "").replace(/\s+/gu, " ").trim();
  assertActive(dependencies.deadline, dependencies.parentSignal);
  if (format === "html") {
    return `<p>${escapeHtml(text)}</p>`;
  }
  return text;
}

function alternateLinks(
  document: Document,
  url: string,
  format: NormalizedWebFetchInput["format"],
): string[] {
  return [...document.querySelectorAll("link[rel][href]")]
    .filter((link) =>
      link.getAttribute("rel")?.split(/\s+/u).includes("alternate"),
    )
    .filter((link) =>
      appropriateAlternate(link.getAttribute("type") ?? "", format),
    )
    .flatMap((link) => {
      try {
        return [new URL(link.getAttribute("href")!, url).href];
      } catch {
        return [];
      }
    });
}

export function inspectHtml(
  html: string,
  url: string,
  format: NormalizedWebFetchInput["format"],
  dependencies: Pick<ExtractionDependencies, "deadline" | "parentSignal">,
): { meta?: string; alternates: string[] } {
  assertActive(dependencies.deadline, dependencies.parentSignal);
  const { document } = parseHTML(html);
  const result = {
    meta: metaRefresh(document, url),
    alternates: alternateLinks(document, url, format),
  };
  assertActive(dependencies.deadline, dependencies.parentSignal);
  return result;
}

export function metaRefresh(
  document: Document,
  url: string,
): string | undefined {
  const content = [...document.querySelectorAll("meta[http-equiv]")]
    .find(
      (meta) => meta.getAttribute("http-equiv")?.toLowerCase() === "refresh",
    )
    ?.getAttribute("content");
  const match = content?.match(/^\s*0(?:\.0*)?\s*;\s*url\s*=\s*(.+?)\s*$/iu);
  if (!match?.[1]) {
    return undefined;
  }
  try {
    return new URL(match[1].replace(/^['"]|['"]$/gu, ""), url).href;
  } catch {
    throw new WebError(
      "redirect",
      "Web Fetch received an invalid meta refresh target.",
    );
  }
}

function appropriateAlternate(type: string, format: string): boolean {
  const normalized = type.toLowerCase().split(";", 1)[0];
  if (format === "json") {
    return isJson(normalized);
  }
  if (format === "html") {
    return normalized === "text/html" || normalized === "application/xhtml+xml";
  }
  if (format === "markdown") {
    return normalized === "text/markdown" || normalized === "text/plain";
  }
  return normalized === "text/plain" || normalized === "text/markdown";
}

function useful(value: string): boolean {
  return value.replace(/<[^>]*>/gu, "").trim().length > 0;
}

function stripHtml(value: string): string {
  const { document } = parseHTML(`<html><body>${value}</body></html>`);
  return (document.body.textContent ?? "").replace(/\s+/gu, " ").trim();
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/gu,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        character
      ]!,
  );
}

function optional(value: string | undefined): string | undefined {
  const cleaned = value?.trim();
  return cleaned ? cleaned.slice(0, 300) : undefined;
}
