import {
  truncateHead,
  type AgentToolUpdateCallback,
} from "@earendil-works/pi-coding-agent";
import { ArtifactStore, ARTIFACT_LIMITS, type Artifact } from "./artifacts.js";
import { assertActive } from "./cancellation.js";
import { LIMITS } from "./constants.js";
import { abortReason, WebError } from "./errors.js";
import {
  extractHtml,
  inspectHtml,
  isHtml,
  isJson,
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
  artifacts?: ArtifactStore;
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
  const artifacts = dependencies.artifacts ?? new ArtifactStore();
  try {
    onUpdate?.({
      content: [{ type: "text", text: "Resolving public target…" }],
      details: { phase: "resolving" },
    });
    let response = await fetchResponse(
      transport,
      request.url,
      signal,
      deadline,
    );
    let metaRefreshes = 0;
    let alternateAttempts = 0;
    while (true) {
      assertActive(deadline, signal);
      const contentType = mediaType(response.headers.get("content-type"));
      if (response.status < 200 || response.status > 299) {
        await response.body?.cancel().catch(() => {});
        throw new WebError(
          "http",
          `Web Fetch received HTTP ${response.status} from the public target.`,
        );
      }
      if (
        isAttachment(response.headers.get("content-disposition")) ||
        !isArtifactTextual(contentType)
      ) {
        const artifact = await artifacts.write(response, {
          kind: "binary",
          maximumBytes: ARTIFACT_LIMITS.binaryBytes,
          signal,
          deadline,
        });
        return artifactResult({
          requestedUrl: request.url,
          response,
          artifact,
          profile: transport.profile,
          semanticTruncated: false,
        });
      }
      if (request.format === "raw") {
        const artifact = await artifacts.write(response, {
          kind: "raw-text",
          maximumBytes: ARTIFACT_LIMITS.rawBytes,
          maximumPreviewChars: request.maxChars,
          signal,
          deadline,
        });
        return artifactResult({
          requestedUrl: request.url,
          response,
          artifact,
          profile: transport.profile,
          semanticTruncated: artifact.previewTruncated ?? false,
        });
      }
      const source = await readText(response, signal, deadline);
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
          response = await fetchResponse(
            transport,
            inspection.meta,
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
          response = await fetchResponse(
            transport,
            alternate,
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
          response = await fetchResponse(
            transport,
            alternate,
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
  artifact?: Artifact;
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
    ...(options.artifact
      ? {
          artifact: {
            finalUrl,
            path: options.artifact.path,
            bytes: options.artifact.bytes,
            contentType: options.artifact.contentType,
            name: options.artifact.name,
            kind: options.artifact.kind,
          },
        }
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
    ...(options.artifact
      ? [
          `Artifact: ${options.artifact.path} (${options.artifact.bytes} bytes, ${options.artifact.contentType}, ${options.artifact.kind})`,
        ]
      : []),
    ...(options.semanticTruncated
      ? [
          `[Content truncated to requested maxChars (${LIMITS.maxChars} maximum).]`,
        ]
      : []),
  ];
  const prefix = `${header.join("\n")}\n\n`;
  const body = options.format === "raw" ? options.body : softWrap(options.body);
  const initial = `${prefix}${body}`;
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
  const truncatedBody = truncateHead(body, {
    maxBytes: LIMITS.resultBytes - Buffer.byteLength(truncatedPrefix),
    maxLines: LIMITS.resultLines - truncatedPrefix.split("\n").length,
  });
  return {
    content: [
      { type: "text", text: `${truncatedPrefix}${truncatedBody.content}` },
    ],
    details: metadata,
  };
}

function artifactResult(options: {
  requestedUrl: string;
  response: Response;
  artifact: Artifact;
  profile: WebTransport["profile"];
  semanticTruncated: boolean;
}): WebFetchResult {
  return result({
    requestedUrl: options.requestedUrl,
    response: options.response,
    contentType: options.artifact.contentType,
    body: options.artifact.preview ?? "",
    format: options.artifact.kind === "raw-text" ? "raw" : "binary",
    profile: options.profile,
    semanticTruncated: options.semanticTruncated,
    metaRefreshes: 0,
    alternateAttempts: 0,
    artifact: options.artifact,
  });
}

async function fetchResponse(
  transport: WebTransport,
  url: string,
  signal: AbortSignal | undefined,
  deadline: ReturnType<typeof createInvocationDeadline>,
): Promise<Response> {
  return transport.fetchArtifact
    ? transport.fetchArtifact(url, signal, deadline)
    : transport.fetch(url, undefined, signal, deadline);
}

function mediaType(value: string | null): string {
  const type = value?.slice(0, LIMITS.metadataChars).split(";", 1)[0]?.trim();
  return type?.toLowerCase() || "unknown";
}

function isAttachment(value: string | null): boolean {
  return /\battachment\b/iu.test(value?.slice(0, LIMITS.metadataChars) ?? "");
}

function isArtifactTextual(contentType: string): boolean {
  return (
    contentType.startsWith("text/") ||
    /^(?:application|image)\/(?:[^/;]+\+)?(?:json|xml)$/iu.test(contentType) ||
    /^application\/(?:javascript|ecmascript|graphql|sql)$/iu.test(contentType)
  );
}

async function readText(
  response: Response,
  signal: AbortSignal | undefined,
  deadline: ReturnType<typeof createInvocationDeadline>,
): Promise<string> {
  const length = response.headers.get("content-length");
  if (
    length &&
    /^\d+$/u.test(length) &&
    Number(length) > LIMITS.responseBytes
  ) {
    await response.body?.cancel().catch(() => {});
    throw new WebError(
      "oversize",
      "Web Fetch response exceeds its 5 MiB text limit.",
    );
  }
  if (!response.body) {
    return "";
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  const cancel = () =>
    void reader.cancel(signal?.reason ?? deadline.signal.reason);
  signal?.addEventListener("abort", cancel, { once: true });
  deadline.signal.addEventListener("abort", cancel, { once: true });
  try {
    while (true) {
      assertActive(deadline, signal);
      const next = await reader.read();
      assertActive(deadline, signal);
      if (next.done) {
        break;
      }
      bytes += next.value.byteLength;
      if (bytes > LIMITS.responseBytes) {
        await reader.cancel().catch(() => {});
        throw new WebError(
          "oversize",
          "Web Fetch response exceeds its 5 MiB text limit.",
        );
      }
      chunks.push(next.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    if (signal?.aborted) {
      throw abortReason(signal);
    }
    if (deadline.signal.aborted) {
      throw abortReason(deadline.signal);
    }
    if (error instanceof WebError) {
      throw error;
    }
    throw new WebError("network", "Web Fetch response stream failed.");
  } finally {
    signal?.removeEventListener("abort", cancel);
    deadline.signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
  const output = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(output);
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
