import {
  truncateHead,
  type AgentToolUpdateCallback,
} from "@earendil-works/pi-coding-agent";
import { assertActive } from "./cancellation.js";
import { LIMITS } from "./constants.js";
import { WebError } from "./errors.js";
import {
  extractHtml,
  inspectHtml,
  isHtml,
  isJson,
  isReadableText,
  renderJson,
  renderNonHtml,
  type ExtractedPage,
} from "./extraction.js";
import { normalizeInput, type WebFetchInput } from "./schema.js";
import {
  createInvocationDeadline,
  createWebTransport,
  type WebTransport,
} from "./transport.js";

export type WebFetchResult = {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
};

type WebFetchDependencies = {
  transport?: WebTransport;
  extractHtml?: typeof extractHtml;
};

export async function executeWebFetch(
  input: WebFetchInput,
  signal?: AbortSignal,
  onUpdate?: AgentToolUpdateCallback,
  dependencies: WebFetchDependencies = {},
): Promise<WebFetchResult> {
  const request = normalizeInput(input);
  const deadline = createInvocationDeadline(request.timeoutMs);
  const transport = dependencies.transport ?? createWebTransport();
  const extract = dependencies.extractHtml ?? extractHtml;
  try {
    onUpdate?.({
      content: [{ type: "text", text: "Resolving public target…" }],
      details: { phase: "resolving" },
    });
    let response = await transport.fetch(
      request.url,
      undefined,
      signal,
      deadline,
    );
    let metaRefreshes = 0;
    let alternateAttempts = 0;
    while (true) {
      assertActive(deadline, signal);
      const contentType =
        response.headers.get("content-type")?.split(";", 1)[0].toLowerCase() ??
        "unknown";
      if (response.status < 200 || response.status > 299) {
        throw new WebError(
          "http",
          `Web Fetch received HTTP ${response.status} from the public target.`,
        );
      }
      if (
        /\battachment\b/iu.test(
          response.headers.get("content-disposition") ?? "",
        ) ||
        (!isHtml(contentType) &&
          !isJson(contentType) &&
          !isReadableText(contentType))
      ) {
        throw new WebError(
          "content",
          "Web Fetch supports only readable textual content at this time.",
        );
      }
      const source = await response.text();
      assertActive(deadline, signal);
      if (isHtml(contentType)) {
        const inspection = inspectHtml(source, response.url, request.format, {
          deadline,
          parentSignal: signal,
        });
        if (inspection.meta) {
          if (metaRefreshes >= LIMITS.metaRefreshes) {
            throw new WebError(
              "redirect",
              "Web Fetch stopped after five immediate meta refreshes.",
            );
          }
          metaRefreshes++;
          onUpdate?.({
            content: [
              { type: "text", text: "Following immediate page redirect…" },
            ],
            details: { phase: "meta-refresh" },
          });
          response = await transport.fetch(
            inspection.meta,
            undefined,
            signal,
            deadline,
          );
          continue;
        }
        if (request.format === "json") {
          const alternate = inspection.alternates[0];
          if (!alternate) {
            throw new WebError(
              "content",
              "Web Fetch format json requires a JSON response.",
            );
          }
          if (alternateAttempts >= LIMITS.alternates) {
            throw new WebError(
              "content",
              "Web Fetch found no JSON response after alternate fallbacks.",
            );
          }
          alternateAttempts++;
          onUpdate?.({
            content: [{ type: "text", text: "Trying JSON alternate…" }],
            details: { phase: "alternate" },
          });
          response = await transport.fetch(
            alternate,
            undefined,
            signal,
            deadline,
          );
          continue;
        }
        onUpdate?.({
          content: [{ type: "text", text: "Extracting readable content…" }],
          details: { phase: "extracting" },
        });
        let page: ExtractedPage;
        try {
          page = await extract(source, response.url, request, {
            transport,
            parentSignal: signal,
            deadline,
          });
        } catch (error) {
          assertActive(deadline, signal);
          const alternate = inspection.alternates[0];
          if (
            !(error instanceof WebError) ||
            error.kind !== "extract" ||
            !alternate
          ) {
            throw error;
          }
          if (alternateAttempts >= LIMITS.alternates) {
            throw new WebError(
              "extract",
              "Web Fetch found no readable content after alternate fallbacks.",
            );
          }
          alternateAttempts++;
          onUpdate?.({
            content: [{ type: "text", text: "Trying readable alternate…" }],
            details: { phase: "alternate" },
          });
          response = await transport.fetch(
            alternate,
            undefined,
            signal,
            deadline,
          );
          continue;
        }
        const content = truncateCharacters(page.content, request.maxChars);
        return result({
          requestedUrl: request.url,
          response,
          contentType,
          body: content.value,
          format: request.format,
          profile: transport.profile,
          page,
          semanticTruncated: content.truncated,
          metaRefreshes,
          alternateAttempts,
        });
      }
      const rendered = isJson(contentType)
        ? renderJson(source, request.format)
        : renderNonHtml(source, request.format, contentType);
      const content = truncateCharacters(rendered, request.maxChars);
      return result({
        requestedUrl: request.url,
        response,
        contentType,
        body: content.value,
        format: request.format,
        profile: transport.profile,
        semanticTruncated: content.truncated,
        metaRefreshes,
        alternateAttempts,
      });
    }
  } finally {
    deadline.dispose();
  }
}

function result(options: {
  requestedUrl: string;
  response: Response;
  contentType: string;
  body: string;
  format: string;
  profile: WebTransport["profile"];
  page?: ExtractedPage;
  semanticTruncated: boolean;
  metaRefreshes: number;
  alternateAttempts: number;
}): WebFetchResult {
  const requestedUrl = metadataText(options.requestedUrl);
  const finalUrl = metadataText(options.response.url);
  const title = options.page?.title
    ? metadataText(options.page.title)
    : undefined;
  const site = options.page?.site ? metadataText(options.page.site) : undefined;
  const published = options.page?.published
    ? metadataText(options.page.published)
    : undefined;
  const contentType = metadataText(options.contentType);
  const metadata = {
    requestedUrl,
    finalUrl,
    status: options.response.status,
    contentType,
    format: options.format,
    profile: options.profile.browser,
    os: options.profile.os,
    ...(title ? { title } : {}),
    ...(site ? { site } : {}),
    ...(published ? { published } : {}),
    ...(options.semanticTruncated ? { semanticTruncated: true } : {}),
    ...(options.metaRefreshes ? { metaRefreshes: options.metaRefreshes } : {}),
    ...(options.alternateAttempts
      ? { alternateAttempts: options.alternateAttempts }
      : {}),
  };
  const header = [
    `Requested URL: ${requestedUrl}`,
    ...(options.response.url !== options.requestedUrl
      ? [`Final URL: ${finalUrl}`]
      : []),
    `HTTP: ${options.response.status} · ${contentType}`,
    ...(title ? [`Title: ${title}`] : []),
    ...(site ? [`Site: ${site}`] : []),
    ...(published ? [`Published: ${published}`] : []),
    `Browser: ${options.profile.browser} / ${options.profile.os}`,
    ...(options.semanticTruncated
      ? [
          `[Content truncated to requested maxChars (${LIMITS.maxChars} maximum).]`,
        ]
      : []),
  ];
  const prefix = `${header.join("\n")}\n\n`;
  const initial = `${prefix}${softWrap(options.body)}`;
  const trial = truncateHead(initial, {
    maxBytes: LIMITS.resultBytes,
    maxLines: LIMITS.resultLines,
  });
  if (!trial.truncated) {
    return {
      content: [{ type: "text", text: trial.content }],
      details: metadata,
    };
  }
  const notice = "[Final output truncated to 48 KiB or 1,900 lines.]";
  const truncatedPrefix = `${header.join("\n")}\n${notice}\n\n`;
  const body = truncateHead(softWrap(options.body), {
    maxBytes: LIMITS.resultBytes - Buffer.byteLength(truncatedPrefix),
    maxLines: LIMITS.resultLines - truncatedPrefix.split("\n").length,
  });
  return {
    content: [{ type: "text", text: `${truncatedPrefix}${body.content}` }],
    details: metadata,
  };
}

function metadataText(value: string): string {
  const compact = value.replace(/\s+/gu, " ").trim();
  const characters = Array.from(compact);
  return characters.length > LIMITS.metadataChars
    ? `${characters.slice(0, LIMITS.metadataChars).join("")}…`
    : compact;
}

function truncateCharacters(
  value: string,
  maximum: number,
): {
  value: string;
  truncated: boolean;
} {
  const characters = Array.from(value);
  return characters.length > maximum
    ? { value: characters.slice(0, maximum).join(""), truncated: true }
    : { value, truncated: false };
}

function softWrap(value: string): string {
  return value
    .split("\n")
    .map((line) => {
      const characters = Array.from(line);
      const chunks: string[] = [];
      while (characters.length > 0) {
        chunks.push(characters.splice(0, 8_000).join(""));
      }
      return chunks.join("\n");
    })
    .join("\n");
}
