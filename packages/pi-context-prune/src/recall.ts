import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { PruningState } from "./policy.ts";
import { getLatchedElision, recordRecall } from "./policy.ts";

const RecallParams = Type.Object({
  id: Type.String({ description: "The toolCallId from an elision stub" }),
  lines: Type.Optional(
    Type.String({
      description:
        'Optional 1-indexed line range like "10-20" or single line "5"',
    }),
  ),
});

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
      "Call this tool with the toolCallId from the stub to get the original content back. " +
      "Stubs may describe the original size, status, path, or pruning reason, but the recall contract is the same for every form.",
    promptSnippet:
      'context_recall("toolCallId") — retrieve a tool result that was replaced with an elision stub',
    promptGuidelines: [
      'Use context_recall when a tool result has been replaced with a stub — every stub ends with Call context_recall("id") to retrieve. and carries the toolCallId you need.',
      'Common stub forms include: standard age/size ("ToolName result elided: SIZE"), superseded-read ("read result elided (superseded by later edit/write of PATH)"), duplicate-read ("read result elided (superseded by later read of PATH at turn N)"), after-consumption-bash ("bash output compacted after assistant consumption..."), batch-pressure ("compacted by cache-aware batch pruning"), and emergency-pressure ("emergency context pressure"). context_recall works the same way for all of them.',
      "context_recall returns the original content unchanged; pi-context-prune never discards anything.",
      'Pass \'lines\' to context_recall (e.g. "10-20" or "5") to fetch only a line range; only supported for single-text-block results.',
    ],
    parameters: RecallParams,

    // Signature per extensions.md:1217: (toolCallId, params, signal, onUpdate, ctx)
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
        return {
          content: [
            {
              type: "text" as const,
              text: wasCompacted
                ? `context_recall: id=${id} was compacted away and cannot be recovered.`
                : `context_recall: no tool result with id=${id}`,
            },
          ],
          details: undefined,
          isError: true,
        };
      }

      const msg = entry.message as {
        role: "toolResult";
        content: Array<{ type: "text" | string; text?: string }>;
      };

      if (!lines) {
        return {
          content: msg.content as Array<{ type: "text"; text: string }>,
          details: undefined,
        };
      }

      const range = parseLineRange(lines);
      if (!range) {
        return {
          content: [
            {
              type: "text" as const,
              text: `context_recall: invalid lines argument "${lines}" — use a format like "5" or "10-20" with 1-indexed positive integers`,
            },
          ],
          details: undefined,
          isError: true,
        };
      }

      const blocks = msg.content;
      const hasNonText = blocks.some((b) => b.type !== "text");

      if (hasNonText) {
        return {
          content: [
            {
              type: "text" as const,
              text: `context_recall: lines slicing is not supported when content contains non-text (image) blocks — omit lines to retrieve full content`,
            },
          ],
          details: undefined,
          isError: true,
        };
      }

      if (blocks.length > 1) {
        return {
          content: [
            {
              type: "text" as const,
              text: `context_recall: lines slicing is not supported across multiple text blocks — omit lines to retrieve full content`,
            },
          ],
          details: undefined,
          isError: true,
        };
      }

      const text = (blocks[0] as { type: string; text: string }).text;
      const sliced = sliceLines(text, range.start, range.end);

      return {
        content: [{ type: "text" as const, text: sliced }],
        details: undefined,
      };
    },
  });
}
