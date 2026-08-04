import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  truncateHead,
  truncateLine,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { stripVTControlCharacters } from "node:util";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { formatBashTarget } from "./bash-target.ts";
import { decodeRetainedResult, hasRetainedResult } from "./retained-result.ts";

const RecallParams = Type.Object(
  {
    id: Type.String({ description: "The toolCallId from an elision stub" }),
    lines: Type.Optional(
      Type.String({
        description:
          'Optional 1-indexed line range like "10-20" or single line "5"; mutually exclusive with find.',
      }),
    ),
    find: Type.Optional(
      Type.String({
        description:
          "Optional case-insensitive literal search for one-text-block results; mutually exclusive with lines",
      }),
    ),
  },
  { additionalProperties: false },
);

const SEARCH_CONTEXT_LINES = 3;
const SEARCH_MATCH_LIMIT = 10;
const OUTPUT_TRUNCATION_NOTICE =
  "[Search output truncated; narrow the literal to see more.]";
const MAX_DISPLAY_CHARS = 120;

type TextBlock = { type: "text"; text: string };
type ImageBlock = { type: "image"; data: string; mimeType: string };
type ToolResult = {
  role: "toolResult";
  toolCallId: string;
  toolName?: string;
  content: unknown;
  details?: unknown;
  isError?: boolean;
};
type RecalledResult = { content: unknown; retainedDetails?: unknown };
type ToolCall = { name: string; arguments: unknown };
type RecallSourceDisplay = {
  toolName?: string;
  target: string;
  fullToolCallId: string;
};
type RenderSource = {
  toolName?: string;
  target: string;
  fullToolCallId?: string;
};
type RenderSelector = {
  type: string;
  lines?: string;
  find?: string;
  totalMatches?: number;
  selectedMatchAnchors?: number;
  visibleSelectedMatchAnchors?: number;
  visibleMatchingLines?: number;
  outputTruncated?: boolean;
  windows?: number;
  sourceLines?: number;
};
type RenderDetails = { source?: RenderSource; selector?: RenderSelector };
type RecallSelector =
  | { type: "full" }
  | { type: "lines"; lines: string }
  | {
      type: "find";
      find: string;
      totalMatches: number;
      selectedMatchAnchors: number;
      visibleSelectedMatchAnchors: number;
      visibleMatchingLines: number;
      outputTruncated: boolean;
      windows: number;
      sourceLines: number;
    };
type SearchWindow = { start: number; end: number };

export function parseLineRange(
  spec: string,
): { start: number; end: number } | undefined {
  const match = /^(\d+)(?:-(\d+))?$/.exec(spec);
  if (!match) {
    return undefined;
  }
  const start = Number(match[1]);
  const end = Number(match[2] ?? match[1]);
  return Number.isSafeInteger(start) &&
    Number.isSafeInteger(end) &&
    start > 0 &&
    end >= start
    ? { start, end }
    : undefined;
}

export function registerRecallTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "context_recall",
    label: "context_recall",
    description:
      "Retrieve original content retained by an outcome tool or hidden behind a Context pruning stub.",
    parameters: RecallParams,
    async execute(
      _toolCallId: string,
      params: { id: string; lines?: string; find?: string },
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionContext,
    ): Promise<any> {
      validateParams(params);
      const result = findToolResult(ctx, params.id);
      if (!result) {
        throw new Error(
          `context_recall: no tool result with id=${shortenedId(params.id)}`,
        );
      }
      const source = resolveSourceDisplay(ctx, params.id);
      const recalled = resolveRecalledResult(
        result,
        params.id,
        findToolCall(ctx, params.id),
      );
      if (params.lines === undefined && params.find === undefined) {
        if (!hasContentBlocks(recalled.content)) {
          throw new Error(
            `context_recall: content for id=${shortenedId(params.id)} is unavailable`,
          );
        }
        return {
          content: recalled.content,
          details: recallDetails(
            params.id,
            source,
            { type: "full" },
            recalled.retainedDetails,
          ),
        };
      }
      if (params.lines !== undefined) {
        const range = parseLineRange(params.lines);
        if (!range) {
          throw new Error(
            `context_recall: invalid lines argument "${params.lines}"`,
          );
        }
        const block = sliceableTextBlock(recalled.content);
        if (!block) {
          throw new Error(
            `context_recall: lines slicing requires one text content block for id=${shortenedId(params.id)}`,
          );
        }
        const text = sliceLines(block.text, range.start, range.end);
        if (text.length === 0) {
          throw new Error(
            `context_recall: requested lines are unavailable for id=${shortenedId(params.id)}`,
          );
        }
        return {
          content: [{ type: "text" as const, text }],
          details: recallDetails(
            params.id,
            source,
            { type: "lines", lines: params.lines },
            recalled.retainedDetails,
          ),
        };
      }
      const block = sliceableTextBlock(recalled.content);
      if (!block) {
        throw new Error(
          `context_recall: literal search requires one text content block for id=${shortenedId(params.id)}`,
        );
      }
      const search = searchText(block.text, params.find!, params.id);
      return {
        content: [{ type: "text" as const, text: search.text }],
        details: recallDetails(
          params.id,
          source,
          search.selector,
          recalled.retainedDetails,
        ),
      };
    },
    renderCall(args, theme) {
      return new Text(
        `${theme.fg("toolTitle", theme.bold("context_recall"))} ${theme.fg("accent", shortenedId(args.id))}`,
        0,
        0,
      );
    },
    renderResult(result, options, theme, context) {
      if (context.isError || options.isPartial) {
        return new Text(
          theme.fg(
            context.isError ? "error" : "warning",
            firstText(result.content),
          ),
          0,
          0,
        );
      }
      const details = renderDetails(result.details);
      const source = details?.source;
      const target = source?.target ?? "content";
      const summary = selectorSummary(details?.selector);
      const lines = [
        `${theme.fg("success", "Recalled")} ${theme.fg("accent", target)}${summary === "" ? "" : ` · ${theme.fg("muted", summary)}`}`,
      ];
      if (options.expanded) {
        if (source?.toolName) {
          lines.push(theme.fg("dim", `source tool: ${source.toolName}`));
        }
        if (source?.fullToolCallId) {
          lines.push(theme.fg("dim", `tool call ID: ${source.fullToolCallId}`));
        }
        const accounting = selectorAccounting(details?.selector);
        if (accounting) {
          lines.push(theme.fg("dim", accounting));
        }
        const content = renderedContent(result.content);
        if (content) {
          lines.push(theme.fg("toolOutput", content));
        }
      }
      return new Text(lines.join("\n"), 0, 0);
    },
  });
}

function validateParams(params: {
  id: string;
  lines?: string;
  find?: string;
}): void {
  if (typeof params.id !== "string" || params.id.trim().length === 0) {
    throw new Error("context_recall: id must be a non-empty tool-call ID");
  }
  if (params.lines !== undefined && params.find !== undefined) {
    throw new Error("context_recall: pass either lines or find, not both");
  }
  if (
    params.find !== undefined &&
    stripVTControlCharacters(params.find).trim().length === 0
  ) {
    throw new Error("context_recall: find must be a non-empty literal");
  }
}

function searchText(
  text: string,
  find: string,
  id: string,
): { text: string; selector: RecallSelector } {
  const query = find.trim();
  const lines = text.split("\n");
  const comparisonQuery = stripVTControlCharacters(query).toLowerCase();
  const matches = lines.flatMap((line, index) =>
    stripVTControlCharacters(line).toLowerCase().includes(comparisonQuery)
      ? [index]
      : [],
  );
  const selected = matches.slice(0, SEARCH_MATCH_LIMIT);
  const windows = mergeWindows(
    selected.map((index) => ({
      start: Math.max(0, index - SEARCH_CONTEXT_LINES),
      end: Math.min(lines.length - 1, index + SEARCH_CONTEXT_LINES),
    })),
  );
  const source = shortenedId(id);
  const displayQuery = formatSearchQuery(query);
  if (matches.length === 0) {
    const bounded = boundSearchProjection([
      `No matches for "${displayQuery}" in ${source}.`,
      `Searched ${lines.length} source lines.`,
    ]);
    return {
      text: bounded.text,
      selector: {
        type: "find",
        find: query,
        totalMatches: 0,
        selectedMatchAnchors: 0,
        visibleSelectedMatchAnchors: 0,
        visibleMatchingLines: 0,
        outputTruncated: bounded.truncated,
        windows: 0,
        sourceLines: lines.length,
      },
    };
  }
  const projection = [
    `Matches for "${displayQuery}" in ${source}:`,
    `Selected ${selected.length} source-ordered match anchors from ${matches.length} matches.`,
  ];
  if (matches.length > selected.length) {
    projection.push(
      "Additional matches were not selected as anchors; narrow the literal to select a smaller set.",
    );
  }
  projection.push("");
  windows.forEach((window, index) => {
    if (index > 0) {
      projection.push("…");
    }
    for (let line = window.start; line <= window.end; line++) {
      projection.push(`${line + 1} | ${truncateLine(lines[line]).text}`);
    }
  });
  const bounded = boundSearchProjection(projection);
  const visibleLines = sourceLineIndexes(bounded.text);
  return {
    text: bounded.text,
    selector: {
      type: "find",
      find: query,
      totalMatches: matches.length,
      selectedMatchAnchors: selected.length,
      visibleSelectedMatchAnchors: selected.filter((line) =>
        visibleLines.has(line),
      ).length,
      visibleMatchingLines: matches.filter((line) => visibleLines.has(line))
        .length,
      outputTruncated: bounded.truncated,
      windows: windows.length,
      sourceLines: lines.length,
    },
  };
}

function mergeWindows(windows: SearchWindow[]): SearchWindow[] {
  const merged: SearchWindow[] = [];
  for (const window of windows) {
    const previous = merged.at(-1);
    if (previous && window.start <= previous.end + 1) {
      previous.end = Math.max(previous.end, window.end);
    } else {
      merged.push({ ...window });
    }
  }
  return merged;
}

function sourceLineIndexes(projection: string): Set<number> {
  return new Set(
    Array.from(
      projection.matchAll(/^(\d+) \|/gmu),
      ([, line]) => Number(line) - 1,
    ),
  );
}

function boundSearchProjection(lines: string[]): {
  text: string;
  truncated: boolean;
} {
  const projection = lines.join("\n");
  const reservedBytes = Buffer.byteLength(
    `\n${OUTPUT_TRUNCATION_NOTICE}`,
    "utf8",
  );
  const options = {
    maxLines: DEFAULT_MAX_LINES - 1,
    maxBytes: DEFAULT_MAX_BYTES - reservedBytes,
  };
  let truncated = truncateHead(projection, options);
  if (truncated.firstLineExceedsLimit) {
    const [firstLine, ...rest] = lines;
    const safeFirstLine = truncateLine(firstLine, MAX_DISPLAY_CHARS).text;
    truncated = truncateHead([safeFirstLine, ...rest].join("\n"), options);
  }
  if (!truncated.truncated) {
    return { text: projection, truncated: false };
  }
  return {
    text:
      truncated.content.length > 0
        ? `${truncated.content}\n${OUTPUT_TRUNCATION_NOTICE}`
        : OUTPUT_TRUNCATION_NOTICE,
    truncated: true,
  };
}

function recallDetails(
  id: string,
  source: RecallSourceDisplay,
  selector: RecallSelector,
  retainedDetails?: unknown,
): {
  id: string;
  lines?: string;
  source: RecallSourceDisplay;
  selector: RecallSelector;
  retainedDetails?: unknown;
} {
  const details =
    selector.type === "lines"
      ? { id, lines: selector.lines, source, selector }
      : { id, source, selector };
  return retainedDetails === undefined
    ? details
    : { ...details, retainedDetails };
}

function resolveSourceDisplay(
  ctx: ExtensionContext,
  id: string,
): RecallSourceDisplay {
  const toolCall = findToolCall(ctx, id);
  if (!toolCall) {
    return { fullToolCallId: id, target: shortenedId(id) };
  }
  if (toolCall.name === "bash" || toolCall.name === "bash_outcome") {
    const command = commandFrom(toolCall.arguments);
    if (command === undefined) {
      return { fullToolCallId: id, target: shortenedId(id) };
    }
    return {
      fullToolCallId: id,
      toolName: toolCall.name,
      target: formatBashTarget(command),
    };
  }
  const toolName = safeToolName(toolCall.name);
  return toolName
    ? { fullToolCallId: id, toolName, target: toolName }
    : { fullToolCallId: id, target: shortenedId(id) };
}

function findToolResult(
  ctx: ExtensionContext,
  id: string,
): ToolResult | undefined {
  for (const entry of ctx.sessionManager.getEntries()) {
    if (entry.type !== "message") {
      continue;
    }
    const message = entry.message as unknown as Partial<ToolResult>;
    if (message.role === "toolResult" && message.toolCallId === id) {
      return message as ToolResult;
    }
  }
  return undefined;
}

function resolveRecalledResult(
  result: ToolResult,
  id: string,
  toolCall: ToolCall | undefined,
): RecalledResult {
  const retained = decodeRetainedResult(result.details);
  if (retained) {
    return { content: retained.content, retainedDetails: retained.details };
  }
  if (result.toolName === "bash_outcome" && !result.isError) {
    const status = hasRetainedResult(result.details)
      ? "malformed"
      : "unavailable";
    throw new Error(
      `context_recall: retained Bash content for id=${shortenedId(id)} is ${status}`,
    );
  }
  if (
    !result.isError &&
    (toolCall?.name === "get_process_result" ||
      toolCall?.name === "stop_process") &&
    isOutcomeArguments(toolCall.arguments)
  ) {
    if (hasRetainedResult(result.details)) {
      throw new Error(
        `context_recall: retained managed process content for id=${shortenedId(id)} is malformed`,
      );
    }
    if (!isFailedProcessOutcomeFallback(result.details)) {
      throw new Error(
        `context_recall: retained managed process content for id=${shortenedId(id)} is unavailable`,
      );
    }
  }
  return { content: result.content };
}

function isOutcomeArguments(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { resultMode?: unknown }).resultMode === "outcome"
  );
}

function isFailedProcessOutcomeFallback(details: unknown): boolean {
  if (typeof details !== "object" || details === null) {
    return false;
  }
  const typed = details as {
    snapshot?: { status?: unknown; id?: unknown };
    resultMode?: unknown;
  };
  return (
    typed.resultMode === "outcome" &&
    typeof typed.snapshot === "object" &&
    typed.snapshot !== null &&
    typeof typed.snapshot.id === "string" &&
    typed.snapshot.status === "failed"
  );
}

function findToolCall(ctx: ExtensionContext, id: string): ToolCall | undefined {
  for (const entry of ctx.sessionManager.getEntries()) {
    if (entry.type !== "message") {
      continue;
    }
    const message = entry.message as {
      role?: unknown;
      content?: unknown;
    };
    if (message.role !== "assistant" || !Array.isArray(message.content)) {
      continue;
    }
    for (const content of message.content) {
      if (
        typeof content === "object" &&
        content !== null &&
        (content as { type?: unknown }).type === "toolCall" &&
        (content as { id?: unknown }).id === id &&
        typeof (content as { name?: unknown }).name === "string"
      ) {
        return {
          name: (content as { name: string }).name,
          arguments: (content as { arguments?: unknown }).arguments,
        };
      }
    }
  }
  return undefined;
}

function commandFrom(arguments_: unknown): string | undefined {
  if (typeof arguments_ !== "object" || arguments_ === null) {
    return undefined;
  }
  const command = (arguments_ as { command?: unknown }).command;
  return typeof command === "string" ? command : undefined;
}

function safeToolName(name: string): string | undefined {
  if (/^[a-z][a-z0-9_-]*$/i.test(name)) {
    return truncateLine(name, MAX_DISPLAY_CHARS).text;
  }
  return undefined;
}

function shortenedId(value: string): string {
  const normalized = controlSafeText(value);
  return truncateLine(normalized || "tool call", 24).text;
}

function formatSearchQuery(value: string): string {
  const escaped = Array.from(stripVTControlCharacters(value), (character) => {
    if (character === "\\") {
      return "\\\\";
    }
    if (character === '"') {
      return '\\"';
    }
    if (character === "\t") {
      return "\\t";
    }
    if (character === "\n") {
      return "\\n";
    }
    if (character === "\r") {
      return "\\r";
    }
    const codePoint = character.codePointAt(0)!;
    if (
      codePoint <= 0x1f ||
      (codePoint >= 0x7f && codePoint <= 0x9f) ||
      (character !== " " && /\s/u.test(character))
    ) {
      return `\\u{${codePoint.toString(16).padStart(4, "0")}}`;
    }
    return character;
  }).join("");
  return truncateLine(escaped, MAX_DISPLAY_CHARS).text;
}

function controlSafeText(value: string): string {
  return Array.from(stripVTControlCharacters(value), (character) => {
    const codePoint = character.codePointAt(0)!;
    return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)
      ? " "
      : character;
  })
    .join("")
    .replace(/\s+/gu, " ")
    .trim();
}

function hasContentBlocks(
  content: unknown,
): content is Array<TextBlock | ImageBlock> {
  return (
    Array.isArray(content) &&
    content.length > 0 &&
    content.every(
      (block) =>
        (isTextBlock(block) && block.text.length > 0) ||
        (isImageBlock(block) &&
          block.data.length > 0 &&
          block.mimeType.length > 0),
    )
  );
}

function sliceableTextBlock(content: unknown): TextBlock | undefined {
  if (!Array.isArray(content) || content.length !== 1) {
    return undefined;
  }
  const block = content[0];
  return isTextBlock(block) ? block : undefined;
}

function sliceLines(text: string, start: number, end: number): string {
  const lines = text.split("\n");
  return lines.slice(start - 1, end).join("\n");
}

function renderDetails(value: unknown): RenderDetails | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const source = isRecord(value.source)
    ? renderSource(value.source)
    : undefined;
  const selector = isRecord(value.selector)
    ? renderSelector(value.selector)
    : undefined;
  return source || selector ? { source, selector } : undefined;
}

function renderSource(
  value: Record<string, unknown>,
): RenderSource | undefined {
  if (typeof value.target !== "string") {
    return undefined;
  }
  const toolName =
    typeof value.toolName === "string"
      ? safeToolName(value.toolName)
      : undefined;
  const fullToolCallId =
    typeof value.fullToolCallId === "string"
      ? controlSafeText(value.fullToolCallId)
      : undefined;
  return {
    target: formatBashTarget(value.target),
    ...(toolName === undefined ? {} : { toolName }),
    ...(fullToolCallId === undefined || fullToolCallId === ""
      ? {}
      : { fullToolCallId }),
  };
}

function renderSelector(
  value: Record<string, unknown>,
): RenderSelector | undefined {
  if (typeof value.type !== "string") {
    return undefined;
  }
  return {
    type: value.type,
    ...(typeof value.lines === "string" ? { lines: value.lines } : {}),
    ...(typeof value.find === "string" ? { find: value.find } : {}),
    ...(typeof value.totalMatches === "number"
      ? { totalMatches: value.totalMatches }
      : {}),
    ...(typeof value.selectedMatchAnchors === "number"
      ? { selectedMatchAnchors: value.selectedMatchAnchors }
      : {}),
    ...(typeof value.visibleSelectedMatchAnchors === "number"
      ? { visibleSelectedMatchAnchors: value.visibleSelectedMatchAnchors }
      : {}),
    ...(typeof value.visibleMatchingLines === "number"
      ? { visibleMatchingLines: value.visibleMatchingLines }
      : {}),
    ...(typeof value.outputTruncated === "boolean"
      ? { outputTruncated: value.outputTruncated }
      : {}),
    ...(typeof value.windows === "number" ? { windows: value.windows } : {}),
    ...(typeof value.sourceLines === "number"
      ? { sourceLines: value.sourceLines }
      : {}),
  };
}

function selectorSummary(selector: RenderSelector | undefined): string {
  if (!selector) {
    return "";
  }
  if (selector.type === "full") {
    return "full result";
  }
  if (selector.type === "lines") {
    return selector.lines
      ? `lines ${controlSafeText(selector.lines)}`
      : "lines";
  }
  if (selector.type === "find") {
    if (selector.totalMatches === 0) {
      return "no matches";
    }
    return Number.isSafeInteger(selector.totalMatches)
      ? `${selector.totalMatches} matches`
      : "literal search";
  }
  return "result";
}

function selectorAccounting(
  selector: RenderSelector | undefined,
): string | undefined {
  if (!selector) {
    return undefined;
  }
  if (selector.type === "full") {
    return "selector: full retained result";
  }
  if (selector.type === "lines") {
    return selector.lines
      ? `selector: lines ${controlSafeText(selector.lines)}`
      : "selector: lines";
  }
  if (selector.type !== "find") {
    return "selector: result";
  }
  const details = [
    selector.find === undefined
      ? "literal search"
      : `literal: ${formatSearchQuery(selector.find)}`,
    Number.isSafeInteger(selector.totalMatches)
      ? `matches: ${selector.totalMatches}`
      : undefined,
    Number.isSafeInteger(selector.selectedMatchAnchors)
      ? `anchors: ${selector.selectedMatchAnchors}`
      : undefined,
    Number.isSafeInteger(selector.visibleSelectedMatchAnchors)
      ? `visible anchors: ${selector.visibleSelectedMatchAnchors}`
      : undefined,
    Number.isSafeInteger(selector.visibleMatchingLines)
      ? `visible matching lines: ${selector.visibleMatchingLines}`
      : undefined,
    Number.isSafeInteger(selector.windows)
      ? `windows: ${selector.windows}`
      : undefined,
    Number.isSafeInteger(selector.sourceLines)
      ? `source lines: ${selector.sourceLines}`
      : undefined,
    selector.outputTruncated ? "output truncated" : undefined,
  ].filter((detail): detail is string => detail !== undefined);
  return details.join(" · ");
}

function renderedContent(content: unknown): string | undefined {
  if (!Array.isArray(content)) {
    return undefined;
  }
  const text = content
    .filter(isTextBlock)
    .map((block) => block.text)
    .join("\n");
  if (text) {
    return text;
  }
  return content.length > 0 ? "Recalled non-text content." : undefined;
}

function firstText(content: unknown): string {
  return Array.isArray(content) && isTextBlock(content[0])
    ? content[0].text
    : "context_recall failed";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTextBlock(value: unknown): value is TextBlock {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "text" &&
    typeof (value as { text?: unknown }).text === "string"
  );
}

function isImageBlock(value: unknown): value is ImageBlock {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "image" &&
    typeof (value as { data?: unknown }).data === "string" &&
    typeof (value as { mimeType?: unknown }).mimeType === "string"
  );
}
