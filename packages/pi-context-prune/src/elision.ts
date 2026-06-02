import type {
  ContextEvent,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { ElisionPassResult } from "./stats.ts";
import type { ElisionReason, PruningState } from "./policy.ts";
import { getLatchedElision, recordElision } from "./policy.ts";
import { DEFAULTS, type Config } from "./config.ts";
import { normalizePath, extractFilePath } from "./paths.ts";

type AgentMsg = ContextEvent["messages"][number];
type ToolResultMsg = Extract<AgentMsg, { role: "toolResult" }>;
type ToolResultContent = ToolResultMsg["content"];

export function isEligibleForElision(
  turnDistanceFromEnd: number,
  tokenCount: number,
  staleTurns = DEFAULTS.staleTurns,
  minTokens = DEFAULTS.minTokens,
): boolean {
  return turnDistanceFromEnd >= staleTurns && tokenCount >= minTokens;
}

export function formatTokenCount(tokens: number): string {
  if (tokens >= 1000) {
    const k = Math.round(tokens / 100) / 10;
    const formatted = Number.isInteger(k) ? String(k) : k.toFixed(1);
    return `${formatted}K tokens`;
  }
  return `${tokens} tokens`;
}

export function extractPreview(content: ToolResultContent): string | null {
  const joined = content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");
  if (joined.length === 0) {
    return null;
  }
  const truncated = joined.length > 100;
  const sliced = joined.slice(0, 100);
  const escaped = sliced
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\t/g, "\\t");
  return truncated ? escaped + "…" : escaped;
}

export function formatStub({
  toolName,
  tokenCount,
  toolCallId,
  preview,
}: {
  toolName: string;
  tokenCount: number;
  toolCallId: string;
  preview?: string | null;
}): string {
  const previewSegment = preview != null ? ` Preview: "${preview}".` : "";
  return `[${toolName} result elided: ${formatTokenCount(tokenCount)}.${previewSegment} Call context_recall("${toolCallId}") to retrieve.]`;
}

export function formatSupersededStub({
  toolName,
  normalizedPath,
  tokenCount,
  toolCallId,
  preview,
}: {
  toolName: string;
  normalizedPath: string;
  tokenCount: number;
  toolCallId: string;
  preview?: string | null;
}): string {
  const previewSegment = preview != null ? ` Preview: "${preview}".` : "";
  return `[${toolName} result elided (superseded by later edit/write of ${normalizedPath}): ${formatTokenCount(tokenCount)}.${previewSegment} Call context_recall("${toolCallId}") to retrieve original.]`;
}

export function formatDuplicateStub({
  toolName,
  normalizedPath,
  keptUserTurnIndex,
  tokenCount,
  toolCallId,
  preview,
}: {
  toolName: string;
  normalizedPath: string;
  keptUserTurnIndex: number;
  tokenCount: number;
  toolCallId: string;
  preview?: string | null;
}): string {
  const previewSegment = preview != null ? ` Preview: "${preview}".` : "";
  return `[${toolName} result elided (superseded by later read of ${normalizedPath} at turn ${keptUserTurnIndex}): ${formatTokenCount(tokenCount)}.${previewSegment} Call context_recall("${toolCallId}") to retrieve.]`;
}

// Image blocks intentionally contribute 0 tokens: elision eligibility is based on text payload only.
// (Pi's own estimateTokens adds ~1200 tokens per image, but we're deciding whether to elide text,
// so only the text cost matters here.)
export function estimateContentTokens(content: ToolResultContent): number {
  let chars = 0;
  for (const block of content) {
    if (block.type === "text") {
      chars += block.text.length;
    }
  }
  return Math.ceil(chars / 4);
}

// Returns, for each position i, the count of user messages strictly after index i.
// Only meaningful for toolResult slots; non-toolResult positions carry the value but it is unused.
export function userTurnsAfterEachPosition(messages: AgentMsg[]): number[] {
  const distances: number[] = Array.from({ length: messages.length }, () => 0);
  let userCount = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    distances[i] = userCount;
    if (messages[i].role === "user") {
      userCount++;
    }
  }
  return distances;
}

// Returns, for each position i, the count of user messages at index <= i (1-indexed).
export function userTurnsUpToEachPosition(messages: AgentMsg[]): number[] {
  const counts: number[] = Array.from({ length: messages.length }, () => 0);
  let userCount = 0;
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === "user") {
      userCount++;
    }
    counts[i] = userCount;
  }
  return counts;
}

// Estimate tokens in the suffix of the conversation (all messages after a candidate index).
// Includes text blocks from user, assistant, and toolResult messages.
// Used for relative scoring, not exact accounting.
export function estimateSuffixTokens(
  messages: AgentMsg[],
  afterIndex: number,
): number {
  let chars = 0;
  for (let i = afterIndex + 1; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === "user" || msg.role === "assistant") {
      const content = (msg as any).content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block?.type === "text" && typeof block.text === "string") {
            chars += block.text.length;
          }
        }
      } else if (typeof content === "string") {
        chars += content.length;
      }
    } else if (msg.role === "toolResult") {
      const content = (msg as any).content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block?.type === "text" && typeof block.text === "string") {
            chars += block.text.length;
          }
        }
      }
    }
  }
  return Math.ceil(chars / 4);
}

function isToolResult(msg: AgentMsg) {
  return msg.role === "toolResult";
}

type ToolCallInfo = {
  name: string;
  input: unknown;
};

function buildSupersededMaps(
  messages: AgentMsg[],
  cwd: string,
): {
  toolCallInfoMap: Map<string, ToolCallInfo>;
  supersededPaths: Map<string, number>;
} {
  const toolCallInfoMap = new Map<string, ToolCallInfo>();
  const supersededPaths = new Map<string, number>();

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    if (msg.role === "assistant") {
      for (const block of msg.content) {
        if (block.type === "toolCall") {
          toolCallInfoMap.set(block.id, {
            name: block.name,
            input: block.arguments,
          });
        }
      }
    }

    if (isToolResult(msg)) {
      const toolName = msg.toolName;
      if ((toolName === "edit" || toolName === "write") && !msg.isError) {
        const callInfo = toolCallInfoMap.get(msg.toolCallId);
        if (callInfo) {
          const rawPath = extractFilePath(toolName, callInfo.input);
          const normalized = normalizePath(rawPath, cwd);
          if (normalized !== null) {
            supersededPaths.set(normalized, i);
          }
        }
      }
    }
  }

  return { toolCallInfoMap, supersededPaths };
}

type DuplicateInfo = {
  normalizedPath: string;
  keptUserTurnIndex: number;
};

// Groups successful reads by (normalizedPath, offset, limit) — reads of the same file at different
// ranges are not duplicates since they may capture non-overlapping content.
function buildDuplicateReadMap(
  messages: AgentMsg[],
  cwd: string,
  toolCallInfoMap: Map<string, ToolCallInfo>,
): Map<string, DuplicateInfo> {
  const userTurnCounts = userTurnsUpToEachPosition(messages);

  type ReadEntry = {
    toolCallId: string;
    normalizedPath: string;
    userTurnIndex: number;
  };

  const groups = new Map<string, ReadEntry[]>();

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!isToolResult(msg) || msg.toolName !== "read" || msg.isError) {
      continue;
    }

    const callInfo = toolCallInfoMap.get(msg.toolCallId);
    if (!callInfo) {
      continue;
    }

    const rawPath = extractFilePath("read", callInfo.input);
    const normalized = normalizePath(rawPath, cwd);
    if (normalized === null) {
      continue;
    }

    const input = callInfo.input as Record<string, unknown>;
    const offset = typeof input.offset === "number" ? input.offset : undefined;
    const limit = typeof input.limit === "number" ? input.limit : undefined;
    const groupKey = `${normalized}\x00${offset ?? ""}\x00${limit ?? ""}`;

    const entries = groups.get(groupKey) ?? [];
    entries.push({
      toolCallId: msg.toolCallId,
      normalizedPath: normalized,
      userTurnIndex: userTurnCounts[i],
    });
    groups.set(groupKey, entries);
  }

  // Map each duplicate toolCallId directly to the info needed for its stub.
  const result = new Map<string, DuplicateInfo>();

  for (const entries of groups.values()) {
    if (entries.length < 2) {
      continue;
    }
    const kept = entries[entries.length - 1];
    for (const entry of entries.slice(0, -1)) {
      result.set(entry.toolCallId, {
        normalizedPath: entry.normalizedPath,
        keptUserTurnIndex: kept.userTurnIndex,
      });
    }
  }

  return result;
}

export function makeContextHook(
  config: Config,
  onElisionPass?: (result: ElisionPassResult) => void,
  pruningState?: PruningState,
) {
  return function handleContext(
    event: ContextEvent,
    ctx: ExtensionContext,
  ): { messages: AgentMsg[] } {
    const messages = event.messages;
    const distances = userTurnsAfterEachPosition(messages);
    const result: AgentMsg[] = [];
    const entries: ElisionPassResult["entries"] = [];

    const cwd = (ctx as { cwd?: string }).cwd ?? process.cwd();

    let toolCallInfoMap: Map<string, ToolCallInfo> | undefined;
    let supersededPaths: Map<string, number> | undefined;
    if (config.supersededReadsEnabled || config.duplicateReadsEnabled) {
      ({ toolCallInfoMap, supersededPaths } = buildSupersededMaps(
        messages,
        cwd,
      ));
    }

    let duplicateReadMap: Map<string, DuplicateInfo> | undefined;
    if (config.duplicateReadsEnabled && toolCallInfoMap) {
      duplicateReadMap = buildDuplicateReadMap(messages, cwd, toolCallInfoMap);
    }

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];

      if (!isToolResult(msg)) {
        result.push(msg);
        continue;
      }

      // Latch: if already elided, re-use the exact same stub.
      if (pruningState) {
        const latched = getLatchedElision(pruningState, msg.toolCallId);
        if (latched) {
          const stub = buildStubFromLatched(msg, latched);
          const elided: ToolResultMsg = {
            role: "toolResult",
            toolCallId: msg.toolCallId,
            toolName: msg.toolName,
            content: [{ type: "text", text: stub }],
            isError: msg.isError ?? false,
            timestamp: msg.timestamp,
          };
          result.push(elided);
          entries.push({
            toolCallId: msg.toolCallId,
            tokenCount: latched.originalTokens,
            toolName: latched.toolName,
            reason: latched.reason,
            savedTokens: Math.max(
              0,
              latched.originalTokens - (latched.stubTokens ?? 0),
            ),
            stubTokens: latched.stubTokens ?? 0,
            suffixTokens: estimateSuffixTokens(messages, i),
          });
          continue;
        }
      }

      const tokenCount = estimateContentTokens(msg.content);
      const distance = distances[i];
      // Error results are never elided by the standard rule — the LLM needs to see failures.
      const isGenericStale =
        !msg.isError &&
        isEligibleForElision(
          distance,
          tokenCount,
          config.staleTurns,
          config.minTokens,
        );

      let supersededNormalizedPath: string | null = null;
      if (
        config.supersededReadsEnabled &&
        msg.toolName === "read" &&
        toolCallInfoMap &&
        supersededPaths
      ) {
        const callInfo = toolCallInfoMap.get(msg.toolCallId);
        if (callInfo) {
          const rawPath = extractFilePath("read", callInfo.input);
          const normalized = normalizePath(rawPath, cwd);
          if (normalized !== null) {
            const supersedingPos = supersededPaths.get(normalized);
            if (supersedingPos !== undefined && supersedingPos > i) {
              supersededNormalizedPath = normalized;
            }
          }
        }
      }

      let duplicateInfo: DuplicateInfo | null = null;
      if (
        config.duplicateReadsEnabled &&
        msg.toolName === "read" &&
        !msg.isError &&
        duplicateReadMap
      ) {
        duplicateInfo = duplicateReadMap.get(msg.toolCallId) ?? null;
      }

      const shouldElide =
        isGenericStale ||
        supersededNormalizedPath !== null ||
        duplicateInfo !== null;

      if (!shouldElide) {
        result.push(msg);
        continue;
      }

      const toolName = msg.toolName ?? "unknown";
      const preview = extractPreview(msg.content);

      let stub: string;
      let reason: ElisionReason;
      if (supersededNormalizedPath !== null) {
        reason = "superseded-read-young";
        stub = formatSupersededStub({
          toolName,
          normalizedPath: supersededNormalizedPath,
          tokenCount,
          toolCallId: msg.toolCallId,
          preview,
        });
      } else if (duplicateInfo !== null) {
        reason = "duplicate-read-young";
        stub = formatDuplicateStub({
          toolName,
          normalizedPath: duplicateInfo.normalizedPath,
          keptUserTurnIndex: duplicateInfo.keptUserTurnIndex,
          tokenCount,
          toolCallId: msg.toolCallId,
          preview,
        });
      } else {
        reason = "standard-stale";
        stub = formatStub({
          toolName,
          tokenCount,
          toolCallId: msg.toolCallId,
          preview,
        });
      }

      const stubTokens = estimateContentTokens([
        { type: "text" as const, text: stub },
      ]);
      const savedTokens = Math.max(0, tokenCount - stubTokens);
      const suffixTokens = estimateSuffixTokens(messages, i);

      if (pruningState) {
        const latched: import("./policy.ts").LatchedElision = {
          toolCallId: msg.toolCallId,
          reason,
          toolName,
          originalTokens: tokenCount,
          stubTokens,
          firstElidedTurnIndex: distance,
        };
        if (reason === "superseded-read-young" && supersededNormalizedPath) {
          latched.normalizedPath = supersededNormalizedPath;
        }
        if (reason === "duplicate-read-young" && duplicateInfo) {
          latched.normalizedPath = duplicateInfo.normalizedPath;
          latched.keptUserTurnIndex = duplicateInfo.keptUserTurnIndex;
        }
        recordElision(pruningState, latched);
      }

      const elided: ToolResultMsg = {
        role: "toolResult",
        toolCallId: msg.toolCallId,
        toolName: msg.toolName,
        content: [{ type: "text", text: stub }],
        isError: msg.isError ?? false,
        timestamp: msg.timestamp,
      };

      result.push(elided);
      entries.push({
        toolCallId: msg.toolCallId,
        tokenCount,
        toolName,
        reason,
        savedTokens,
        stubTokens,
        suffixTokens,
      });
    }

    onElisionPass?.({ entries });

    return { messages: result };
  };
}

function buildStubFromLatched(
  msg: ToolResultMsg,
  latched: import("./policy.ts").LatchedElision,
): string {
  const preview = extractPreview(msg.content);
  if (latched.reason === "superseded-read-young" && latched.normalizedPath) {
    return formatSupersededStub({
      toolName: latched.toolName,
      normalizedPath: latched.normalizedPath,
      tokenCount: latched.originalTokens,
      toolCallId: latched.toolCallId,
      preview,
    });
  }
  if (
    latched.reason === "duplicate-read-young" &&
    latched.normalizedPath &&
    latched.keptUserTurnIndex != null
  ) {
    return formatDuplicateStub({
      toolName: latched.toolName,
      normalizedPath: latched.normalizedPath,
      keptUserTurnIndex: latched.keptUserTurnIndex,
      tokenCount: latched.originalTokens,
      toolCallId: latched.toolCallId,
      preview,
    });
  }
  return formatStub({
    toolName: latched.toolName,
    tokenCount: latched.originalTokens,
    toolCallId: latched.toolCallId,
    preview,
  });
}
