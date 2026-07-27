import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { PruningState } from "./policy.ts";
import { getLatchedElision, recordRecall } from "./policy.ts";
import { formatTokenCount } from "./elision.ts";

const RecallParams = Type.Object({
  id: Type.String({ description: "The toolCallId from an elision stub" }),
  lines: Type.Optional(
    Type.String({
      description:
        'Optional 1-indexed line range like "10-20" or single line "5"',
    }),
  ),
});

type ContentBlock = { type: string; text?: string };

type ContentSummary = {
  blocks: number;
  textBlocks: number;
  nonTextBlocks: number;
  chars: number;
  tokens: number;
  lines: number;
};

type RecallDetails = {
  id: string;
  recalledToolName: string;
  requestedLines?: string;
  sliced: boolean;
  original: ContentSummary;
  returned: ContentSummary;
  error?: string;
};

function emptySummary(): ContentSummary {
  return {
    blocks: 0,
    textBlocks: 0,
    nonTextBlocks: 0,
    chars: 0,
    tokens: 0,
    lines: 0,
  };
}

function summarizeContent(blocks: ContentBlock[]): ContentSummary {
  let chars = 0;
  let textBlocks = 0;
  let nonTextBlocks = 0;
  let lines = 0;
  for (const block of blocks) {
    if (block.type === "text" && typeof block.text === "string") {
      textBlocks++;
      chars += block.text.length;
      lines += block.text === "" ? 0 : block.text.split("\n").length;
    } else {
      nonTextBlocks++;
    }
  }
  return {
    blocks: blocks.length,
    textBlocks,
    nonTextBlocks,
    chars,
    tokens: Math.ceil(chars / 4),
    lines,
  };
}

function buildRenderLines(details: RecallDetails, expanded: boolean): string[] {
  const { recalledToolName, requestedLines, sliced, original, returned } =
    details;

  const parts: string[] = [];
  parts.push(`${formatTokenCount(returned.tokens)}`);
  if (returned.lines > 0) {
    parts.push(`${returned.lines} lines`);
  }
  if (returned.nonTextBlocks > 0) {
    parts.push(`${returned.nonTextBlocks} non-text blocks`);
  }

  const suffix = parts.join(", ");
  const sliceInfo =
    sliced && requestedLines ? ` (sliced to ${requestedLines})` : "";

  const header = `Recalled ${recalledToolName} result — ${suffix}${sliceInfo}`;
  const lines = [header];

  if (expanded) {
    lines.push(`  ID: ${details.id}`);
    if (sliced && original.tokens !== returned.tokens) {
      lines.push(
        `  Original: ${formatTokenCount(original.tokens)}, ${original.lines} lines`,
      );
    }
    lines.push(
      `  Returned: ${returned.blocks} block${returned.blocks === 1 ? "" : "s"} (${returned.textBlocks} text, ${returned.nonTextBlocks} non-text)`,
    );
  } else if (sliced && original.tokens !== returned.tokens) {
    lines.push(
      `  Original: ${formatTokenCount(original.tokens)}, ${original.lines} lines`,
    );
  }

  return lines;
}

export function parseLineRange(
  spec: string,
): { start: number; end: number } | null {
  const m = /^(\d+)(?:-(\d+))?$/.exec(spec);
  if (!m) {
    return null;
  }
  const start = parseInt(m[1], 10);
  if (start < 1) {
    return null;
  }
  if (m[2] === undefined) {
    return { start, end: start };
  }
  const end = parseInt(m[2], 10);
  if (end < start) {
    return null;
  }
  return { start, end };
}

function sliceLines(text: string, start: number, end: number): string {
  const lines = text.split("\n");
  const total = lines.length;
  const lo = Math.max(1, start);
  const hi = Math.min(total, end);
  if (lo > hi) {
    return "";
  }
  return lines.slice(lo - 1, hi).join("\n");
}

export function registerRecallTool(
  pi: ExtensionAPI,
  onRecall?: (toolName: string, toolCallId?: string, reason?: string) => void,
  pruningState?: PruningState,
): void {
  pi.registerTool({
    name: "context_recall",
    label: "context_recall",
    description:
      "Retrieve the full content of a tool result that was elided from context. " +
      "When a tool result is large, stale, superseded, duplicated, or compacted after consumption, pi-context-prune replaces it with a reasoned stub that ends with " +
      '`Call context_recall("TOOL_CALL_ID") to retrieve.`. ' +
      "Call this tool with the toolCallId from the stub to get the original content back while the original tool result is still retained in the active session store. " +
      "Stubs may describe the original size, status, path, or pruning reason, but the recall contract is the same for every form.",
    promptSnippet:
      'context_recall("toolCallId") — retrieve a tool result that was replaced with an elision stub',
    promptGuidelines: [
      'Use context_recall when a tool result has been replaced with a stub — every stub ends with Call context_recall("id") to retrieve. and carries the toolCallId you need.',
      'Common stub forms include: standard age/size ("ToolName result elided: SIZE"), superseded-read ("read result elided (superseded by later edit/write of PATH)"), duplicate-read ("read result elided (superseded by later read of PATH at turn N)"), covered-read ("read result elided (covered by later read of PATH at turn N)"), after-consumption-bash ("bash output compacted after assistant consumption..."), batch-pressure ("compacted by cache-aware batch pruning"), and emergency-pressure ("emergency context pressure"). context_recall works the same way for all of them.',
      "context_recall returns retained original content unchanged; if Pi has compacted the underlying tool-result message away, recall may be unavailable.",
      'Pass \'lines\' to context_recall (e.g. "10-20" or "5") to fetch only a line range; only supported for single-text-block results.',
    ],
    parameters: RecallParams,

    async execute(
      _toolCallId: string,
      params: { id: string; lines?: string },
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionContext,
    ) {
      const { id, lines } = params;
      const entries = ctx.sessionManager.getEntries();

      const entry = entries.find((e) => {
        if (e.type !== "message") {
          return false;
        }
        const msg = e.message as { role?: string; toolCallId?: string };
        return msg.role === "toolResult" && msg.toolCallId === id;
      });

      const recalledToolName =
        entry?.type === "message"
          ? ((entry.message as { toolName?: string }).toolName ?? "unknown")
          : "unknown";
      const reason = pruningState
        ? getLatchedElision(pruningState, id)?.reason
        : undefined;
      onRecall?.(recalledToolName, id, reason);
      if (pruningState && reason) {
        recordRecall(pruningState, id, reason);
      }

      if (!entry || entry.type !== "message") {
        const wasCompacted = entries.some((e) => e.type === "compaction");
        const text = wasCompacted
          ? `context_recall: id=${id} was compacted away and cannot be recovered.`
          : `context_recall: no tool result with id=${id}`;
        return {
          content: [{ type: "text" as const, text }],
          details: {
            id,
            recalledToolName: "unknown",
            sliced: false,
            original: emptySummary(),
            returned: emptySummary(),
            error: text,
          },
        };
      }

      const msg = entry.message as {
        role: "toolResult";
        content: ContentBlock[];
      };

      const originalSummary = summarizeContent(msg.content);

      if (!lines) {
        const details: RecallDetails = {
          id,
          recalledToolName,
          sliced: false,
          original: originalSummary,
          returned: originalSummary,
        };
        return {
          content: msg.content as Array<{ type: "text"; text: string }>,
          details,
        };
      }

      const range = parseLineRange(lines);
      if (!range) {
        const text = `context_recall: invalid lines argument "${lines}" — use a format like "5" or "10-20" with 1-indexed positive integers`;
        return {
          content: [{ type: "text" as const, text }],
          details: {
            id,
            recalledToolName,
            requestedLines: lines,
            sliced: false,
            original: originalSummary,
            returned: emptySummary(),
            error: text,
          },
        };
      }

      const blocks = msg.content;
      const hasNonText = blocks.some((b) => b.type !== "text");

      if (hasNonText) {
        const text = `context_recall: lines slicing is not supported when content contains non-text (image) blocks — omit lines to retrieve full content`;
        return {
          content: [{ type: "text" as const, text }],
          details: {
            id,
            recalledToolName,
            requestedLines: lines,
            sliced: false,
            original: originalSummary,
            returned: emptySummary(),
            error: text,
          },
        };
      }

      if (blocks.length === 0) {
        const details: RecallDetails = {
          id,
          recalledToolName,
          requestedLines: lines,
          sliced: false,
          original: originalSummary,
          returned: emptySummary(),
        };
        return {
          content: [{ type: "text" as const, text: "" }],
          details,
        };
      }

      if (blocks.length > 1) {
        const text = `context_recall: lines slicing is not supported across multiple text blocks — omit lines to retrieve full content`;
        return {
          content: [{ type: "text" as const, text }],
          details: {
            id,
            recalledToolName,
            requestedLines: lines,
            sliced: false,
            original: originalSummary,
            returned: emptySummary(),
            error: text,
          },
        };
      }

      const text = (blocks[0] as { type: string; text: string }).text;
      const slicedText = sliceLines(text, range.start, range.end);
      const returnedContent: ContentBlock[] = [
        { type: "text" as const, text: slicedText },
      ];
      const returnedSummary = summarizeContent(returnedContent);

      const details: RecallDetails = {
        id,
        recalledToolName,
        requestedLines: lines,
        sliced: true,
        original: originalSummary,
        returned: returnedSummary,
      };

      return {
        content: returnedContent as Array<{ type: "text"; text: string }>,
        details,
      };
    },

    renderResult(result, options, theme, _context) {
      const details = result.details as RecallDetails | undefined;
      if (!details) {
        return {
          render: () => [theme.fg("muted", "Recalled content")],
          invalidate: () => {},
        };
      }

      if (details.error) {
        return {
          render: () => [theme.fg("error", details.error!)],
          invalidate: () => {},
        };
      }

      const lines = buildRenderLines(details, options.expanded);
      return {
        render: () => lines.map((l) => theme.fg("success", l)),
        invalidate: () => {},
      };
    },
  });
}
