import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const RecallParams = Type.Object({
  id: Type.String({ description: "The toolCallId from an elision stub" }),
  lines: Type.Optional(
    Type.String({
      description:
        'Optional 1-indexed line range like "10-20" or single line "5"',
    }),
  ),
});

type TextBlock = { type: "text"; text: string };
type ToolResult = {
  role: "toolResult";
  toolCallId: string;
  toolName?: string;
  content: unknown;
};

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
    description: "Retrieve original content behind a Context pruning stub.",
    promptSnippet:
      'context_recall("toolCallId") — retrieve a pruned tool result',
    promptGuidelines: [
      "Use context_recall with the tool-call ID printed in a Context stub.",
      'Pass lines like "10-20" only for one-text-block results.',
    ],
    parameters: RecallParams,
    async execute(
      _toolCallId: string,
      params: { id: string; lines?: string },
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionContext,
    ): Promise<any> {
      const result = findToolResult(ctx, params.id);
      if (!result) {
        throw new Error(`context_recall: no tool result with id=${params.id}`);
      }
      if (params.lines === undefined) {
        if (!hasContentBlocks(result.content)) {
          throw new Error(
            `context_recall: content for id=${params.id} is unavailable`,
          );
        }
        return { content: result.content, details: { id: params.id } };
      }
      const range = parseLineRange(params.lines);
      if (!range) {
        throw new Error(
          `context_recall: invalid lines argument "${params.lines}"`,
        );
      }
      const block = sliceableTextBlock(result.content);
      if (!block) {
        throw new Error(
          `context_recall: lines slicing requires one text content block for id=${params.id}`,
        );
      }
      const text = sliceLines(block.text, range.start, range.end);
      if (text.length === 0) {
        throw new Error(
          `context_recall: requested lines are unavailable for id=${params.id}`,
        );
      }
      return {
        content: [{ type: "text" as const, text }],
        details: { id: params.id, lines: params.lines },
      };
    },
    renderResult(result, _options, theme, _context) {
      const recalled = result as unknown as {
        details?: { id?: string };
        isError?: boolean;
        content: unknown;
      };
      const details = recalled.details;
      const error = recalled.isError ? firstText(recalled.content) : undefined;
      return {
        render: () => [
          theme.fg(
            error ? "error" : "success",
            error ?? `Recalled ${details?.id ?? "content"}`,
          ),
        ],
        invalidate: () => {},
      };
    },
  });
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

function firstText(content: unknown): string {
  return Array.isArray(content) && isTextBlock(content[0])
    ? content[0].text
    : "context_recall failed";
}

type ImageBlock = { type: "image"; data: string; mimeType: string };

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
