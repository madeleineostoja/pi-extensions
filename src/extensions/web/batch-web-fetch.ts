import {
  truncateHead,
  type AgentToolUpdateCallback,
} from "@earendil-works/pi-coding-agent";
import {
  composeSignal,
  createDeadline,
  type Deadline,
} from "./cancellation.js";
import { LIMITS } from "./constants.js";
import { abortReason, DeadlineError, WebError } from "./errors.js";
import {
  normalizeBatchInput,
  type BatchWebFetchInput,
  type NormalizedWebFetchInput,
} from "./schema.js";
import {
  executeWebFetch,
  type WebFetchDependencies,
  type WebFetchResult,
} from "./web-fetch.js";

export type BatchWebFetchResult = WebFetchResult;

type BatchWebFetchDependencies = WebFetchDependencies & {
  execute?: typeof executeWebFetch;
  createDeadline?: (milliseconds: number) => Deadline;
};

type ItemState = {
  request: NormalizedWebFetchInput;
  status: "pending" | "running" | "succeeded" | "failed";
  result?: WebFetchResult;
  error?: string;
};

type Allocation = {
  bytes: number;
  lines: number;
};

type ItemSection = {
  prefix: string;
  body?: string;
  request: NormalizedWebFetchInput;
};

export async function executeBatchWebFetch(
  input: BatchWebFetchInput,
  signal?: AbortSignal,
  onUpdate?: AgentToolUpdateCallback,
  dependencies: BatchWebFetchDependencies = {},
): Promise<BatchWebFetchResult> {
  const makeDeadline = dependencies.createDeadline ?? createDeadline;
  const aggregate = makeDeadline(LIMITS.batchDeadlineMs);
  const batchSignal = composeSignal([signal, aggregate.signal]);
  try {
    const requests = normalizeBatchInput(input);
    const items: ItemState[] = requests.map((request) => ({
      request,
      status: "pending",
    }));
    let next = 0;
    let fatal: Error | undefined;
    const execute = dependencies.execute ?? executeWebFetch;
    const update = (item: ItemState, ordinal: number, phase?: string) => {
      onUpdate?.({
        content: [
          {
            type: "text",
            text: `Batch item ${ordinal}/${items.length}: ${phase ?? item.status}.`,
          },
        ],
        details: {
          ordinal,
          total: items.length,
          status: item.status,
          ...(phase ? { phase } : {}),
          requestedUrl: displayUrl(item.request.url),
          ...(item.error ? { error: item.error } : {}),
        },
      });
    };

    onUpdate?.({
      content: [
        { type: "text", text: `Preparing ${items.length} web requests…` },
      ],
      details: { total: items.length, status: "preparing" },
    });

    const worker = async () => {
      while (!fatal) {
        try {
          assertBatchActive(aggregate, batchSignal.signal);
        } catch (error) {
          fatal ??= asError(error);
          return;
        }
        const index = next++;
        const item = items[index];
        if (!item) {
          return;
        }
        const remaining = aggregate.remaining();
        if (remaining <= 0) {
          fatal ??= new DeadlineError();
          return;
        }
        item.status = "running";
        update(item, index + 1, "resolving");
        const itemDeadline = makeDeadline(
          Math.min(item.request.timeoutMs, remaining),
        );
        try {
          item.result = await execute(
            item.request,
            batchSignal.signal,
            (partial) => {
              const phase = boundedText(
                String(partial.details?.phase ?? "working"),
                64,
              );
              update(item, index + 1, phase);
            },
            { ...dependencies, deadline: itemDeadline },
          );
          assertBatchActive(aggregate, batchSignal.signal);
          item.status = "succeeded";
          update(item, index + 1, "done");
        } catch (error) {
          if (batchSignal.signal.aborted || aggregate.signal.aborted) {
            fatal ??= abortReason(batchSignal.signal);
            return;
          }
          item.status = "failed";
          item.error = safeReason(error);
          update(item, index + 1, "failed");
        } finally {
          itemDeadline.dispose();
        }
      }
    };

    await Promise.all(
      Array.from(
        { length: Math.min(LIMITS.batchWorkers, items.length) },
        worker,
      ),
    );
    if (fatal) {
      throw fatal;
    }

    const succeeded = items.filter((item) => item.status === "succeeded");
    if (succeeded.length === 0) {
      throw new WebError("network", allFailedMessage(items));
    }
    const content = assemble(items);
    const failed = items.length - succeeded.length;
    return {
      content: [{ type: "text", text: content }],
      details: {
        total: items.length,
        succeeded: succeeded.length,
        failed,
        items: items.map((item, index) => itemDetails(item, index + 1)),
      },
    };
  } finally {
    batchSignal.dispose();
    aggregate.dispose();
  }
}

function assemble(items: readonly ItemState[]): string {
  const succeeded = items.filter((item) => item.status === "succeeded").length;
  const header = [
    "# Batch Web Fetch",
    `Requests: ${items.length} · Succeeded: ${succeeded} · Failed: ${items.length - succeeded}`,
  ].join("\n");
  const sections = items.map((item, index) => itemSection(item, index + 1));
  const baseline = joinSections(
    header,
    sections.map((section) => section.prefix),
  );
  const allocation = fairAllocation(items.length, succeeded, baseline);
  const complete = joinSections(
    header,
    sections.map((section) =>
      section.body === undefined
        ? section.prefix
        : `${section.prefix}\n\n${allocateContent(section.body, section.request.maxChars, allocation)}`,
    ),
  );
  if (withinResultLimits(complete)) {
    return complete;
  }
  return joinSections(
    header,
    sections.map((section) =>
      section.body === undefined
        ? section.prefix
        : `${section.prefix}\nContent: omitted to preserve aggregate result limits.`,
    ),
  );
}

function fairAllocation(
  count: number,
  succeeded: number,
  baseline: string,
): Allocation {
  return {
    bytes: Math.max(
      0,
      Math.floor(
        (LIMITS.resultBytes - Buffer.byteLength(baseline) - succeeded * 2) /
          count,
      ),
    ),
    lines: Math.max(
      0,
      Math.floor(
        (LIMITS.resultLines - lineCount(baseline) - succeeded * 2) / count,
      ),
    ),
  };
}

function itemSection(item: ItemState, ordinal: number): ItemSection {
  const requested = displayUrl(item.request.url);
  const lines = [
    `## Item ${ordinal}: ${requested}`,
    `Requested URL: ${requested}`,
  ];
  if (item.status === "failed") {
    return {
      prefix: [
        ...lines,
        `Status: failed · ${item.error ?? "Web Fetch item failed."}`,
      ].join("\n"),
      request: item.request,
    };
  }
  if (item.status !== "succeeded" || !item.result) {
    return {
      prefix: [
        ...lines,
        "Status: not completed before the batch deadline.",
      ].join("\n"),
      request: item.request,
    };
  }
  const details = item.result.details;
  const finalUrl = detailText(details.finalUrl);
  const status =
    typeof details.status === "number" ? details.status : undefined;
  const contentType = detailText(details.contentType, 128);
  const semanticTruncated = details.semanticTruncated === true;
  const sourceFinalTruncated = details.finalTruncated === true;
  lines.push(
    `Status: succeeded${status ? ` · HTTP ${status}` : ""}${contentType ? ` · ${contentType}` : ""}`,
  );
  if (finalUrl && finalUrl !== requested) {
    lines.push(`Final URL: ${displayUrl(finalUrl)}`);
  }
  const artifact = artifactFact(details.artifact);
  if (artifact) {
    lines.push(`Artifact: ${artifact}`);
  }
  if (semanticTruncated) {
    lines.push("Content: truncated to the request's maxChars.");
  }
  if (sourceFinalTruncated) {
    lines.push("Content: truncated by the single-fetch final result limit.");
  }
  return {
    prefix: lines.join("\n"),
    body: itemBody(item.result),
    request: item.request,
  };
}

function joinSections(header: string, sections: readonly string[]): string {
  return [header, ...sections].join("\n\n");
}

function itemBody(result: WebFetchResult): string {
  const text = result.content.map((part) => part.text).join("");
  return text.startsWith("Requested URL:")
    ? text.split("\n\n").slice(1).join("\n\n") || ""
    : text;
}

function allocateContent(
  value: string,
  maxChars: number,
  allocation: Allocation,
): string {
  const notice = "[Item content truncated for fair batch allocation.]";
  const characters = Array.from(value);
  const narrowed =
    characters.length > maxChars
      ? characters.slice(0, maxChars).join("")
      : value;
  const trial = truncateHead(narrowed, {
    maxBytes: allocation.bytes,
    maxLines: allocation.lines,
  });
  if (!trial.truncated) {
    return trial.content || "[No model-visible content was returned.]";
  }
  const content = truncateHead(narrowed, {
    maxBytes: Math.max(0, allocation.bytes - Buffer.byteLength(notice) - 1),
    maxLines: Math.max(1, allocation.lines - 1),
  }).content;
  return `${content}\n${notice}`;
}

function itemDetails(
  item: ItemState,
  ordinal: number,
): Record<string, unknown> {
  const details = item.result?.details;
  return {
    ordinal,
    requestedUrl: displayUrl(item.request.url),
    status: item.status,
    ...(typeof details?.status === "number"
      ? { httpStatus: details.status }
      : {}),
    ...(detailText(details?.finalUrl)
      ? { finalUrl: displayUrl(detailText(details?.finalUrl)!) }
      : {}),
    ...(details?.semanticTruncated === true ? { semanticTruncated: true } : {}),
    ...(details?.finalTruncated === true ? { finalTruncated: true } : {}),
    ...(artifactDetails(details?.artifact)
      ? { artifact: artifactDetails(details?.artifact) }
      : {}),
    ...(item.error ? { error: item.error } : {}),
  };
}

function artifactFact(value: unknown): string | undefined {
  const artifact = artifactDetails(value);
  return artifact
    ? `${artifact.path}${artifact.bytes === undefined ? "" : ` (${artifact.bytes} bytes)`}${artifact.kind ? ` · ${artifact.kind}` : ""}`
    : undefined;
}

function artifactDetails(value: unknown):
  | {
      path: string;
      bytes?: number;
      kind?: string;
      contentType?: string;
    }
  | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const path = detailText(value.path, 192);
  if (!path) {
    return undefined;
  }
  const bytes = typeof value.bytes === "number" ? value.bytes : undefined;
  const kind = detailText(value.kind, 64);
  const contentType = detailText(value.contentType, 128);
  return {
    path,
    ...(bytes === undefined ? {} : { bytes }),
    ...(kind ? { kind } : {}),
    ...(contentType ? { contentType } : {}),
  };
}

function allFailedMessage(items: readonly ItemState[]): string {
  return [
    "Batch Web Fetch failed for every item:",
    ...items.map(
      (item, index) =>
        `- Item ${index + 1} (${displayUrl(item.request.url)}): ${item.error ?? "Web Fetch item failed."}`,
    ),
  ].join("\n");
}

function assertBatchActive(deadline: Deadline, signal: AbortSignal): void {
  if (signal.aborted) {
    throw abortReason(signal);
  }
  if (deadline.signal.aborted || deadline.remaining() <= 0) {
    throw new DeadlineError();
  }
}

function safeReason(error: unknown): string {
  if (error instanceof WebError) {
    return boundedText(error.message, 384);
  }
  if (error instanceof DeadlineError) {
    return "Web Fetch item timed out.";
  }
  return "Web Fetch item could not complete.";
}

function displayUrl(value: string): string {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    return boundedText(url.href, 256);
  } catch {
    return boundedText(value.replace(/[\r\n\t]/gu, " "), 256);
  }
}

function detailText(value: unknown, maximum = 256): string | undefined {
  return typeof value === "string" && value
    ? boundedText(value, maximum)
    : undefined;
}

function boundedText(value: string, maximumBytes: number): string {
  const compact = value.replace(/\s+/gu, " ").trim();
  return truncateHead(compact, {
    maxBytes: maximumBytes,
    maxLines: 1,
  }).content;
}

function withinResultLimits(value: string): boolean {
  return (
    Buffer.byteLength(value) <= LIMITS.resultBytes &&
    lineCount(value) <= LIMITS.resultLines
  );
}

function lineCount(value: string): number {
  return value.split("\n").length;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new DeadlineError();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
