import type {
  ContextEvent,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { ElisionPassResult } from "./stats.ts";
import type { ElisionReason, PruningState } from "./policy.ts";
import {
  getLatchedElision,
  recordElision,
  getPrimaryReason,
  getProfileForReason,
  BATCH_PRIORITY,
  pruneLatchedElisions,
} from "./policy.ts";
import { DEFAULTS, type Config } from "./config.ts";
import { normalizePath, extractFilePath } from "./paths.ts";
import { classifyBashOutput } from "./bash-classifier.ts";
import {
  getEffectiveProfile,
  captureContextUsage,
  computeRecentCacheHit,
} from "./telemetry.ts";

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

export type ReadMetadata = {
  normalizedPath: string;
  offset?: number;
  limit?: number;
};

function formatReadMetadata(meta: ReadMetadata): string {
  let segment = ` Path: ${meta.normalizedPath}.`;
  const parts: string[] = [];
  if (typeof meta.offset === "number") {
    parts.push(`offset=${meta.offset}`);
  }
  if (typeof meta.limit === "number") {
    parts.push(`limit=${meta.limit}`);
  }
  if (parts.length > 0) {
    segment += ` ${parts.join(" ")}.`;
  }
  return segment;
}

export function formatStub({
  toolName,
  tokenCount,
  toolCallId,
  preview,
  readMetadata,
}: {
  toolName: string;
  tokenCount: number;
  toolCallId: string;
  preview?: string | null;
  readMetadata?: ReadMetadata;
}): string {
  const previewSegment = preview != null ? ` Preview: "${preview}".` : "";
  const readSegment = readMetadata ? formatReadMetadata(readMetadata) : "";
  const recallContract = readMetadata
    ? ` Call context_recall("${toolCallId}") to retrieve; lines slicing is available for text-only results.`
    : ` Call context_recall("${toolCallId}") to retrieve.`;
  return `[${toolName} result elided: ${formatTokenCount(tokenCount)}.${previewSegment}${readSegment}${recallContract}]`;
}

export function formatBatchPressureStub({
  toolName,
  tokenCount,
  toolCallId,
  preview,
  readMetadata,
}: {
  toolName: string;
  tokenCount: number;
  toolCallId: string;
  preview?: string | null;
  readMetadata?: ReadMetadata;
}): string {
  const previewSegment = preview != null ? ` Preview: "${preview}".` : "";
  const readSegment = readMetadata ? formatReadMetadata(readMetadata) : "";
  const recallContract = readMetadata
    ? ` Call context_recall("${toolCallId}") to retrieve; lines slicing is available for text-only results.`
    : ` Call context_recall("${toolCallId}") to retrieve.`;
  return `[${toolName} result compacted by cache-aware batch pruning: ${formatTokenCount(tokenCount)}.${previewSegment}${readSegment}${recallContract}]`;
}

export function formatEmergencyPressureStub({
  toolName,
  tokenCount,
  toolCallId,
  preview,
  readMetadata,
}: {
  toolName: string;
  tokenCount: number;
  toolCallId: string;
  preview?: string | null;
  readMetadata?: ReadMetadata;
}): string {
  const previewSegment = preview != null ? ` Preview: "${preview}".` : "";
  const readSegment = readMetadata ? formatReadMetadata(readMetadata) : "";
  const recallContract = readMetadata
    ? ` Call context_recall("${toolCallId}") to retrieve; lines slicing is available for text-only results.`
    : ` Call context_recall("${toolCallId}") to retrieve.`;
  return `[${toolName} result elided (emergency context pressure): ${formatTokenCount(tokenCount)}.${previewSegment}${readSegment}${recallContract}]`;
}

export function formatSupersededStub({
  toolName,
  normalizedPath,
  offset,
  limit,
  tokenCount,
  toolCallId,
  preview,
}: {
  toolName: string;
  normalizedPath: string;
  offset?: number;
  limit?: number;
  tokenCount: number;
  toolCallId: string;
  preview?: string | null;
}): string {
  const previewSegment = preview != null ? ` Preview: "${preview}".` : "";
  const parts: string[] = [];
  if (typeof offset === "number") {
    parts.push(`offset=${offset}`);
  }
  if (typeof limit === "number") {
    parts.push(`limit=${limit}`);
  }
  const pathSegment =
    parts.length > 0 ? `${normalizedPath}, ${parts.join(" ")}` : normalizedPath;
  return `[${toolName} result elided (superseded by later edit/write of ${pathSegment}): ${formatTokenCount(tokenCount)}.${previewSegment} Call context_recall("${toolCallId}") to retrieve original.]`;
}

const MAX_BASH_COMMAND_STUB_CHARS = 120;

function formatCommandForStub(command: string): string {
  const escaped = command
    .replace(/\\/g, "\\\\")
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n")
    .replace(/\t/g, "\\t");
  if (escaped.length <= MAX_BASH_COMMAND_STUB_CHARS) {
    return escaped;
  }
  return escaped.slice(0, MAX_BASH_COMMAND_STUB_CHARS - 1) + "…";
}

export function formatAfterConsumptionBashStub({
  tokenCount,
  toolCallId,
  command,
  preview,
}: {
  tokenCount: number;
  toolCallId: string;
  command?: string | null;
  preview?: string | null;
}): string {
  const cmdSegment =
    command && command.length > 0
      ? ` Command: ${formatCommandForStub(command)}.`
      : "";
  const previewSegment = preview != null ? ` Preview: "${preview}".` : "";
  return `[bash output compacted after assistant consumption: ${formatTokenCount(tokenCount)}.${cmdSegment} Status: success.${previewSegment} Call context_recall("${toolCallId}") to retrieve full output.]`;
}

export function formatDuplicateStub({
  toolName,
  normalizedPath,
  keptUserTurnIndex,
  offset,
  limit,
  tokenCount,
  toolCallId,
  preview,
}: {
  toolName: string;
  normalizedPath: string;
  keptUserTurnIndex: number;
  offset?: number;
  limit?: number;
  tokenCount: number;
  toolCallId: string;
  preview?: string | null;
}): string {
  const previewSegment = preview != null ? ` Preview: "${preview}".` : "";
  const parts: string[] = [];
  if (typeof offset === "number") {
    parts.push(`offset=${offset}`);
  }
  if (typeof limit === "number") {
    parts.push(`limit=${limit}`);
  }
  const pathSegment =
    parts.length > 0 ? `${normalizedPath}, ${parts.join(" ")}` : normalizedPath;
  return `[${toolName} result elided (superseded by later read of ${pathSegment} at turn ${keptUserTurnIndex}): ${formatTokenCount(tokenCount)}.${previewSegment} Call context_recall("${toolCallId}") to retrieve.]`;
}

export type CoveredInfo = {
  normalizedPath: string;
  keptUserTurnIndex: number;
};

export function formatCoveredStub({
  toolName,
  normalizedPath,
  keptUserTurnIndex,
  offset,
  limit,
  tokenCount,
  toolCallId,
  preview,
}: {
  toolName: string;
  normalizedPath: string;
  keptUserTurnIndex: number;
  offset?: number;
  limit?: number;
  tokenCount: number;
  toolCallId: string;
  preview?: string | null;
}): string {
  const previewSegment = preview != null ? ` Preview: "${preview}".` : "";
  const parts: string[] = [];
  if (typeof offset === "number") {
    parts.push(`offset=${offset}`);
  }
  if (typeof limit === "number") {
    parts.push(`limit=${limit}`);
  }
  const pathSegment =
    parts.length > 0 ? `${normalizedPath}, ${parts.join(" ")}` : normalizedPath;
  return `[${toolName} result elided (covered by later read of ${pathSegment} at turn ${keptUserTurnIndex}): ${formatTokenCount(tokenCount)}.${previewSegment} Call context_recall("${toolCallId}") to retrieve.]`;
}

function estimateTextBlockChars(content: unknown): number {
  if (typeof content === "string") {
    return content.length;
  }
  if (!Array.isArray(content)) {
    return 0;
  }
  let chars = 0;
  for (const block of content) {
    if (block?.type === "text" && typeof block.text === "string") {
      chars += block.text.length;
    }
  }
  return chars;
}

export function estimateContentTokens(content: ToolResultContent): number {
  return Math.ceil(estimateTextBlockChars(content) / 4);
}

function estimateMessageTextChars(msg: AgentMsg): number {
  if (msg.role === "user" || msg.role === "assistant") {
    return estimateTextBlockChars(msg.content);
  }
  if (msg.role === "toolResult") {
    return estimateTextBlockChars(msg.content);
  }
  return 0;
}

function estimateMessageTokens(msg: AgentMsg): number {
  return Math.ceil(estimateMessageTextChars(msg) / 4);
}

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

export function assistantAfterEachPosition(messages: AgentMsg[]): boolean[] {
  const hasAssistant: boolean[] = Array.from(
    { length: messages.length },
    () => false,
  );
  let seen = false;
  for (let i = messages.length - 1; i >= 0; i--) {
    hasAssistant[i] = seen;
    if (messages[i].role === "assistant") {
      seen = true;
    }
  }
  return hasAssistant;
}

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

function buildSuffixTokenTable(messages: AgentMsg[]): number[] {
  const suffixChars: number[] = Array.from(
    { length: messages.length + 1 },
    () => 0,
  );
  for (let i = messages.length - 1; i >= 0; i--) {
    suffixChars[i] = suffixChars[i + 1] + estimateMessageTextChars(messages[i]);
  }
  return suffixChars.map((chars) => Math.ceil(chars / 4));
}

function lookupSuffixTokens(
  suffixTokens: number[],
  afterIndex: number,
): number {
  const idx = Math.max(0, Math.min(suffixTokens.length - 1, afterIndex + 1));
  return suffixTokens[idx];
}

export function estimateSuffixTokens(
  messages: AgentMsg[],
  afterIndex: number,
): number {
  return lookupSuffixTokens(buildSuffixTokenTable(messages), afterIndex);
}

function isToolResult(msg: AgentMsg): msg is ToolResultMsg {
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
  mutationPositions: Map<string, number[]>;
} {
  const toolCallInfoMap = new Map<string, ToolCallInfo>();
  const supersededPaths = new Map<string, number>();
  const mutationPositions = new Map<string, number[]>();

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
            const arr = mutationPositions.get(normalized) ?? [];
            arr.push(i);
            mutationPositions.set(normalized, arr);
          }
        }
      }
    }
  }

  return { toolCallInfoMap, supersededPaths, mutationPositions };
}

type DuplicateInfo = {
  normalizedPath: string;
  keptUserTurnIndex: number;
};

function buildDuplicateReadMap(
  messages: AgentMsg[],
  cwd: string,
  toolCallInfoMap: Map<string, ToolCallInfo>,
  mutationPositions: Map<string, number[]>,
): Map<string, DuplicateInfo> {
  const userTurnCounts = userTurnsUpToEachPosition(messages);

  type ReadEntry = {
    index: number;
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
      index: i,
      toolCallId: msg.toolCallId,
      normalizedPath: normalized,
      userTurnIndex: userTurnCounts[i],
    });
    groups.set(groupKey, entries);
  }

  const result = new Map<string, DuplicateInfo>();

  for (const entries of groups.values()) {
    if (entries.length < 2) {
      continue;
    }
    const mutations = mutationPositions.get(entries[0].normalizedPath) ?? [];
    for (let i = 0; i < entries.length - 1; i++) {
      const earlier = entries[i];
      for (let j = i + 1; j < entries.length; j++) {
        const later = entries[j];
        let hasMutation = false;
        for (const mutPos of mutations) {
          if (mutPos > earlier.index && mutPos < later.index) {
            hasMutation = true;
            break;
          }
        }
        if (!hasMutation) {
          result.set(earlier.toolCallId, {
            normalizedPath: earlier.normalizedPath,
            keptUserTurnIndex: later.userTurnIndex,
          });
          break;
        }
      }
    }
  }

  return result;
}

type ReadRange =
  | { kind: "full" }
  | { kind: "partial"; start: number; endExclusive: number }
  | { kind: "unknown" };

const PI_READ_MAX_LINES = 2000;
const PI_READ_MAX_BYTES = 50 * 1024;

const READ_TRUNCATION_PATTERNS = [
  /\[Showing lines \d+-\d+ of \d+/,
  /exceeds\s+\S+\s+limit\. Use bash:/,
  /\[\d+ more lines in file\. Use offset=\d+ to continue\.\]/,
];

function isReadTruncationNoticeLine(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return false;
  }
  return READ_TRUNCATION_PATTERNS.some((pattern) => pattern.test(trimmed));
}

function countTextLines(text: string): number {
  if (text.length === 0) {
    return 0;
  }
  const lines = text.split(/\r?\n/);
  if (text.endsWith("\n") || text.endsWith("\r")) {
    lines.pop();
  }
  return lines.length;
}

function estimateDeliveredLines(content: ToolResultContent): number {
  let lines = 0;
  for (const block of content) {
    if (block.type === "text" && typeof block.text === "string") {
      const textLines = block.text.split(/\r?\n/);
      if (block.text.endsWith("\n") || block.text.endsWith("\r")) {
        textLines.pop();
      }
      const skip = new Set<number>();
      for (let i = 0; i < textLines.length; i++) {
        if (isReadTruncationNoticeLine(textLines[i])) {
          skip.add(i);
          if (i > 0 && textLines[i - 1].trim().length === 0) {
            skip.add(i - 1);
          }
          if (
            i + 1 < textLines.length &&
            textLines[i + 1].trim().length === 0
          ) {
            skip.add(i + 1);
          }
        }
      }
      lines += textLines.length - skip.size;
    }
  }
  return lines;
}

function isPotentiallyTruncatedRead(content: ToolResultContent): boolean {
  let totalBytes = 0;
  let totalLines = 0;
  let hasTruncationNotice = false;
  for (const block of content) {
    if (block.type === "text" && typeof block.text === "string") {
      totalBytes += Buffer.byteLength(block.text, "utf-8");
      totalLines += countTextLines(block.text);
      if (!hasTruncationNotice) {
        for (const pattern of READ_TRUNCATION_PATTERNS) {
          if (pattern.test(block.text)) {
            hasTruncationNotice = true;
            break;
          }
        }
      }
    }
  }
  return (
    totalLines >= PI_READ_MAX_LINES ||
    totalBytes >= PI_READ_MAX_BYTES ||
    hasTruncationNotice
  );
}

function extractReadRange(
  input: Record<string, unknown>,
  content: ToolResultContent,
): ReadRange {
  const hasOffset = typeof input.offset === "number";
  const hasLimit = typeof input.limit === "number";

  if (!hasOffset && !hasLimit) {
    if (isPotentiallyTruncatedRead(content)) {
      const deliveredLines = estimateDeliveredLines(content);
      return { kind: "partial", start: 1, endExclusive: 1 + deliveredLines };
    }
    return { kind: "full" };
  }

  if (hasOffset && hasLimit) {
    const offset = input.offset as number;
    const limit = input.limit as number;
    if (offset >= 1 && limit >= 0) {
      if (isPotentiallyTruncatedRead(content)) {
        const deliveredLines = estimateDeliveredLines(content);
        return {
          kind: "partial",
          start: offset,
          endExclusive: offset + deliveredLines,
        };
      }
      return { kind: "partial", start: offset, endExclusive: offset + limit };
    }
  }

  return { kind: "unknown" };
}

function rangeCovers(later: ReadRange, earlier: ReadRange): boolean {
  if (earlier.kind === "full") {
    return later.kind === "full";
  }
  if (earlier.kind === "unknown") {
    return false;
  }
  if (later.kind === "full") {
    return true;
  }
  if (later.kind === "unknown") {
    return false;
  }
  return (
    later.start <= earlier.start && later.endExclusive >= earlier.endExclusive
  );
}

function buildCoveredReadMap(
  messages: AgentMsg[],
  cwd: string,
  toolCallInfoMap: Map<string, ToolCallInfo>,
  mutationPositions: Map<string, number[]>,
): Map<string, CoveredInfo> {
  const userTurnCounts = userTurnsUpToEachPosition(messages);

  type ReadEntry = {
    index: number;
    toolCallId: string;
    normalizedPath: string;
    range: ReadRange;
    userTurnIndex: number;
  };

  const pathToReads = new Map<string, ReadEntry[]>();

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
    const range = extractReadRange(input, msg.content);

    const entries = pathToReads.get(normalized) ?? [];
    entries.push({
      index: i,
      toolCallId: msg.toolCallId,
      normalizedPath: normalized,
      range,
      userTurnIndex: userTurnCounts[i],
    });
    pathToReads.set(normalized, entries);
  }

  const result = new Map<string, CoveredInfo>();

  for (const [path, reads] of pathToReads) {
    const mutations = mutationPositions.get(path) ?? [];

    for (let i = 0; i < reads.length; i++) {
      const earlier = reads[i];

      for (let j = i + 1; j < reads.length; j++) {
        const later = reads[j];

        let hasMutation = false;
        for (const mutPos of mutations) {
          if (mutPos > earlier.index && mutPos < later.index) {
            hasMutation = true;
            break;
          }
        }
        if (hasMutation) {
          continue;
        }

        if (rangeCovers(later.range, earlier.range)) {
          result.set(earlier.toolCallId, {
            normalizedPath: earlier.normalizedPath,
            keptUserTurnIndex: later.userTurnIndex,
          });
          break;
        }
      }
    }
  }

  return result;
}

function recallRateForScoring(
  pruningState: PruningState | undefined,
  reason: ElisionReason,
): number {
  if (!pruningState) {
    return 0;
  }
  const elisions = pruningState.elisionCountByReason.get(reason) ?? 0;
  const recalls = pruningState.recallCountByReason.get(reason) ?? 0;
  return elisions > 0 ? recalls / elisions : 0;
}

type Candidate = {
  index: number;
  msg: ToolResultMsg;
  reasons: ElisionReason[];
  originalTokens: number;
  estimatedStubTokens: number;
  savedTokens: number;
  suffixTokens: number;
  semanticRisk: number;
  priority: number;
  isOrdinarySourceRead: boolean;
  supersededPath?: string;
  duplicateInfo?: DuplicateInfo;
  coveredInfo?: CoveredInfo;
  bashCommand?: string;
  readMetadata?: ReadMetadata;
};

function buildStubTextForCandidate(
  cand: Candidate,
  actionReason: ElisionReason,
  tokenCount: number,
  preview: string | null,
): string {
  const toolName = cand.msg.toolName ?? "unknown";
  if (actionReason === "batch-pressure") {
    return formatBatchPressureStub({
      toolName,
      tokenCount,
      toolCallId: cand.msg.toolCallId,
      preview,
      readMetadata: cand.readMetadata,
    });
  }
  if (actionReason === "emergency-pressure") {
    return formatEmergencyPressureStub({
      toolName,
      tokenCount,
      toolCallId: cand.msg.toolCallId,
      preview,
      readMetadata: cand.readMetadata,
    });
  }
  if (actionReason === "superseded-read-young" && cand.supersededPath) {
    return formatSupersededStub({
      toolName,
      normalizedPath: cand.supersededPath,
      offset: cand.readMetadata?.offset,
      limit: cand.readMetadata?.limit,
      tokenCount,
      toolCallId: cand.msg.toolCallId,
      preview,
    });
  }
  if (actionReason === "duplicate-read-young" && cand.duplicateInfo) {
    return formatDuplicateStub({
      toolName,
      normalizedPath: cand.duplicateInfo.normalizedPath,
      keptUserTurnIndex: cand.duplicateInfo.keptUserTurnIndex,
      offset: cand.readMetadata?.offset,
      limit: cand.readMetadata?.limit,
      tokenCount,
      toolCallId: cand.msg.toolCallId,
      preview,
    });
  }
  if (actionReason === "covered-read-young" && cand.coveredInfo) {
    return formatCoveredStub({
      toolName,
      normalizedPath: cand.coveredInfo.normalizedPath,
      keptUserTurnIndex: cand.coveredInfo.keptUserTurnIndex,
      offset: cand.readMetadata?.offset,
      limit: cand.readMetadata?.limit,
      tokenCount,
      toolCallId: cand.msg.toolCallId,
      preview,
    });
  }
  if (actionReason === "after-consumption-bash") {
    return formatAfterConsumptionBashStub({
      tokenCount,
      toolCallId: cand.msg.toolCallId,
      command: cand.bashCommand,
      preview,
    });
  }
  return formatStub({
    toolName,
    tokenCount,
    toolCallId: cand.msg.toolCallId,
    preview,
    readMetadata: cand.readMetadata,
  });
}

function applyElision(
  cand: Candidate,
  actionReason: ElisionReason,
  entries: ElisionPassResult["entries"],
  result: AgentMsg[],
  pruningState: PruningState | undefined,
  distances: number[],
): void {
  const msg = cand.msg;
  const preview = extractPreview(msg.content);
  const primaryReason = getPrimaryReason(cand.reasons);

  const stubText = buildStubTextForCandidate(
    cand,
    actionReason,
    cand.originalTokens,
    preview,
  );
  const stubTokens = estimateContentTokens([{ type: "text", text: stubText }]);
  const savedTokens = Math.max(0, cand.originalTokens - stubTokens);

  const elided: ToolResultMsg = {
    role: "toolResult",
    toolCallId: msg.toolCallId,
    toolName: msg.toolName,
    content: [{ type: "text", text: stubText }],
    isError: msg.isError ?? false,
    timestamp: msg.timestamp,
  };

  result[cand.index] = elided;

  entries.push({
    toolCallId: msg.toolCallId,
    tokenCount: cand.originalTokens,
    toolName: msg.toolName ?? "unknown",
    reason: actionReason,
    savedTokens,
    stubTokens,
    suffixTokens: cand.suffixTokens,
  });

  if (pruningState) {
    const latched: import("./policy.ts").LatchedElision = {
      toolCallId: msg.toolCallId,
      reason: actionReason,
      toolName: msg.toolName ?? "unknown",
      originalTokens: cand.originalTokens,
      stubTokens,
      firstElidedTurnIndex: distances[cand.index],
      sourceReason: primaryReason !== actionReason ? primaryReason : undefined,
    };
    if (primaryReason === "superseded-read-young" && cand.supersededPath) {
      latched.normalizedPath = cand.supersededPath;
    }
    if (primaryReason === "duplicate-read-young" && cand.duplicateInfo) {
      latched.normalizedPath = cand.duplicateInfo.normalizedPath;
      latched.keptUserTurnIndex = cand.duplicateInfo.keptUserTurnIndex;
    }
    if (primaryReason === "covered-read-young" && cand.coveredInfo) {
      latched.normalizedPath = cand.coveredInfo.normalizedPath;
      latched.keptUserTurnIndex = cand.coveredInfo.keptUserTurnIndex;
    }
    if (primaryReason === "after-consumption-bash" && cand.bashCommand) {
      latched.command = cand.bashCommand;
    }
    if (cand.readMetadata) {
      latched.readPath = cand.readMetadata.normalizedPath;
      if (typeof cand.readMetadata.offset === "number") {
        latched.readOffset = cand.readMetadata.offset;
      }
      if (typeof cand.readMetadata.limit === "number") {
        latched.readLimit = cand.readMetadata.limit;
      }
    }
    recordElision(pruningState, latched);
  }
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
    const result: AgentMsg[] = messages.slice();
    const entries: ElisionPassResult["entries"] = [];

    const cwd = (ctx as { cwd?: string }).cwd ?? process.cwd();

    const { toolCallInfoMap, supersededPaths, mutationPositions } =
      buildSupersededMaps(messages, cwd);
    const duplicateReadMap = buildDuplicateReadMap(
      messages,
      cwd,
      toolCallInfoMap,
      mutationPositions,
    );
    const coveredReadMap = buildCoveredReadMap(
      messages,
      cwd,
      toolCallInfoMap,
      mutationPositions,
    );
    const hasAssistantAfter =
      config.afterConsumptionBashEnabled || config.emergencyMaxOrdinaryReads > 0
        ? assistantAfterEachPosition(messages)
        : [];
    const distances = userTurnsAfterEachPosition(messages);
    const userTurnCounts = userTurnsUpToEachPosition(messages);
    const suffixTokenTable = buildSuffixTokenTable(messages);

    if (pruningState) {
      const activeToolCallIds = new Set<string>();
      for (const msg of messages) {
        if (isToolResult(msg)) {
          activeToolCallIds.add(msg.toolCallId);
        }
      }
      pruneLatchedElisions(pruningState, activeToolCallIds);
    }

    let totalPromptTokens = 0;
    for (const msg of messages) {
      totalPromptTokens += estimateMessageTokens(msg);
    }

    const usage = captureContextUsage(pruningState, ctx);
    const isEmergency =
      typeof usage?.tokens === "number" &&
      typeof usage.contextWindow === "number" &&
      usage.tokens >=
        usage.contextWindow - config.emergencyContextReserveTokens;

    const candidates: Candidate[] = [];

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (!isToolResult(msg)) {
        continue;
      }

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
          result[i] = elided;
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
            suffixTokens: lookupSuffixTokens(suffixTokenTable, i),
          });
          continue;
        }
      }

      const tokenCount = estimateContentTokens(msg.content);
      const distance = distances[i];

      const reasons: ElisionReason[] = [];
      let supersededPath: string | undefined;
      let duplicateInfo: DuplicateInfo | undefined;
      let coveredInfo: CoveredInfo | undefined;
      let bashCommand: string | undefined;
      let readPath: string | null = null;
      let readMetadata: ReadMetadata | undefined;

      if (msg.toolName === "read" && toolCallInfoMap) {
        const callInfo = toolCallInfoMap.get(msg.toolCallId);
        if (callInfo) {
          const normalized = normalizePath(
            extractFilePath("read", callInfo.input),
            cwd,
          );
          if (normalized !== null) {
            readPath = normalized;
            const input = callInfo.input as Record<string, unknown>;
            readMetadata = {
              normalizedPath: normalized,
              ...(typeof input.offset === "number"
                ? { offset: input.offset }
                : {}),
              ...(typeof input.limit === "number"
                ? { limit: input.limit }
                : {}),
            };
          }
        }
      }

      if (
        !msg.isError &&
        isEligibleForElision(
          distance,
          tokenCount,
          config.staleTurns,
          config.minTokens,
        )
      ) {
        reasons.push("standard-stale");
      }

      if (
        config.supersededReadsEnabled &&
        msg.toolName === "read" &&
        readPath !== null &&
        supersededPaths
      ) {
        const supersedingPos = supersededPaths.get(readPath);
        if (supersedingPos !== undefined && supersedingPos > i) {
          reasons.push("superseded-read-young");
          supersededPath = readPath;
        }
      }

      if (
        config.duplicateReadsEnabled &&
        msg.toolName === "read" &&
        !msg.isError &&
        duplicateReadMap
      ) {
        duplicateInfo = duplicateReadMap.get(msg.toolCallId) ?? undefined;
        if (duplicateInfo) {
          reasons.push("duplicate-read-young");
        }
      }

      if (
        config.coveredReadsEnabled &&
        msg.toolName === "read" &&
        !msg.isError &&
        coveredReadMap
      ) {
        coveredInfo = coveredReadMap.get(msg.toolCallId) ?? undefined;
        if (coveredInfo) {
          reasons.push("covered-read-young");
        }
      }

      if (
        config.afterConsumptionBashEnabled &&
        !msg.isError &&
        msg.toolName === "bash" &&
        hasAssistantAfter[i]
      ) {
        const bashProfile = getProfileForReason("after-consumption-bash");
        const classification = classifyBashOutput(
          msg.content,
          tokenCount,
          bashProfile.minSavedTokens,
        );
        if (classification.lowRisk) {
          reasons.push("after-consumption-bash");
          const callInfo = toolCallInfoMap?.get(msg.toolCallId);
          if (
            callInfo &&
            typeof callInfo.input === "object" &&
            callInfo.input !== null
          ) {
            const input = callInfo.input as Record<string, unknown>;
            if (typeof input.command === "string") {
              bashCommand = input.command;
            }
          }
        }
      }

      if (
        isEmergency &&
        reasons.length === 0 &&
        msg.toolName === "read" &&
        !msg.isError &&
        readPath !== null &&
        hasAssistantAfter[i]
      ) {
        const preview = extractPreview(msg.content);
        const stubText = buildStubTextForCandidate(
          {
            index: i,
            msg,
            reasons,
            originalTokens: tokenCount,
            estimatedStubTokens: 0,
            savedTokens: 0,
            suffixTokens: 0,
            semanticRisk: 0,
            priority: 0,
            isOrdinarySourceRead: false,
            readMetadata,
          },
          "emergency-pressure",
          tokenCount,
          preview,
        );
        const stubTokens = estimateContentTokens([
          { type: "text", text: stubText },
        ]);
        const savedTokens = Math.max(0, tokenCount - stubTokens);
        if (savedTokens >= config.emergencyOrdinaryReadMinSavedTokens) {
          reasons.push("emergency-pressure");
        }
      }

      if (reasons.length === 0) {
        continue;
      }

      const primaryReason = getPrimaryReason(reasons);
      const preview = extractPreview(msg.content);
      const stubText = buildStubTextForCandidate(
        {
          index: i,
          msg,
          reasons,
          originalTokens: tokenCount,
          estimatedStubTokens: 0,
          savedTokens: 0,
          suffixTokens: 0,
          semanticRisk: 0,
          priority: 0,
          isOrdinarySourceRead: false,
          supersededPath,
          duplicateInfo,
          coveredInfo,
          bashCommand,
          readMetadata,
        },
        primaryReason,
        tokenCount,
        preview,
      );
      const stubTokens = estimateContentTokens([
        { type: "text", text: stubText },
      ]);
      const savedTokens = Math.max(0, tokenCount - stubTokens);
      const suffixTokens = lookupSuffixTokens(suffixTokenTable, i);

      const isOrdinarySourceRead =
        msg.toolName === "read" &&
        readPath !== null &&
        !reasons.includes("duplicate-read-young") &&
        !reasons.includes("covered-read-young") &&
        !reasons.includes("superseded-read-young");
      const profile = getProfileForReason(primaryReason);

      candidates.push({
        index: i,
        msg,
        reasons,
        originalTokens: tokenCount,
        estimatedStubTokens: stubTokens,
        savedTokens,
        suffixTokens,
        semanticRisk: isOrdinarySourceRead ? 1 : profile.semanticRisk,
        priority: isOrdinarySourceRead
          ? BATCH_PRIORITY["batch-pressure"]
          : (BATCH_PRIORITY[primaryReason] ?? 5),
        isOrdinarySourceRead,
        supersededPath,
        duplicateInfo,
        coveredInfo,
        bashCommand,
        readMetadata,
      });
    }

    const samples = pruningState?.recentCacheSamples ?? [];
    const lastSample = samples[samples.length - 1];
    const recentCacheHit = config.adaptivePolicyEnabled
      ? computeRecentCacheHit(samples, lastSample?.provider, lastSample?.model)
      : 0.5;
    const cachePenalty = Math.max(
      0.25,
      Math.min(1.0, 0.25 + 0.75 * recentCacheHit),
    );
    const lowValueToolTokens = candidates.reduce(
      (s, c) => s + c.originalTokens,
      0,
    );
    const rotPressure = Math.min(
      1,
      lowValueToolTokens / Math.max(totalPromptTokens, 1),
    );
    if (pruningState) {
      pruningState.lastRotPressure = rotPressure;
    }
    const expectedFutureTurns = 2 + 3 * rotPressure;

    const deferred: Candidate[] = [];
    const elidedIndices = new Set<number>();

    for (const cand of candidates) {
      const primaryReason = getPrimaryReason(cand.reasons);
      const profile = getProfileForReason(primaryReason);

      const recallRate = recallRateForScoring(pruningState, primaryReason);
      const recallPenaltyTokens = 6000 * recallRate;
      const semanticPenaltyTokens = 4000 * cand.semanticRisk;

      const netValue =
        cand.savedTokens * expectedFutureTurns +
        cand.savedTokens * rotPressure -
        cand.suffixTokens * cachePenalty -
        recallPenaltyTokens -
        semanticPenaltyTokens;

      const eff = getEffectiveProfile(
        pruningState,
        primaryReason,
        profile,
        config.adaptivePolicyEnabled,
      );
      const minSaved = eff.minSavedTokens;
      const suffixBudget = eff.suffixBudget;

      const nearTail = cand.suffixTokens <= profile.minSuffixBudget;
      const requiresPositiveSavings =
        primaryReason === "after-consumption-bash";
      const savingsAllowYoung =
        !requiresPositiveSavings || cand.savedTokens > 0;
      const scorePositive = cand.savedTokens >= minSaved && netValue >= 1000;
      const qualifiesYoung =
        savingsAllowYoung &&
        cand.suffixTokens <= suffixBudget &&
        (nearTail || scorePositive);

      if (qualifiesYoung && !isEmergency && !cand.isOrdinarySourceRead) {
        applyElision(
          cand,
          primaryReason,
          entries,
          result,
          pruningState,
          distances,
        );
        elidedIndices.add(cand.index);
      } else {
        deferred.push(cand);
      }
    }

    if (deferred.length > 0 && (config.batchPruningEnabled || isEmergency)) {
      deferred.sort((a, b) => {
        if (a.priority !== b.priority) {
          return a.priority - b.priority;
        }
        return a.index - b.index;
      });

      const emergencyOrdinaryCandidates: Candidate[] = [];
      const otherDeferred: Candidate[] = [];
      for (const cand of deferred) {
        if (
          isEmergency &&
          cand.isOrdinarySourceRead &&
          cand.savedTokens >= config.emergencyOrdinaryReadMinSavedTokens
        ) {
          emergencyOrdinaryCandidates.push(cand);
        } else {
          otherDeferred.push(cand);
        }
      }

      const selected: Candidate[] = [];
      for (const cand of otherDeferred) {
        if (cand.isOrdinarySourceRead) {
          continue;
        }
        if (selected.length >= config.batchMaxCandidates) {
          break;
        }
        selected.push(cand);
      }

      if (isEmergency) {
        let emergencyOrdinarySelected = 0;
        for (const cand of emergencyOrdinaryCandidates) {
          if (selected.length >= config.batchMaxCandidates) {
            break;
          }
          if (emergencyOrdinarySelected >= config.emergencyMaxOrdinaryReads) {
            break;
          }
          selected.push(cand);
          emergencyOrdinarySelected++;
        }
      }

      if (selected.length >= (isEmergency ? 1 : config.batchMinCandidates)) {
        const earliest = selected.reduce((oldest, cand) =>
          cand.index < oldest.index ? cand : oldest,
        );
        const batchSavedTokens = selected.reduce(
          (s, c) => s + c.savedTokens,
          0,
        );
        const batchDamage =
          lookupSuffixTokens(suffixTokenTable, earliest.index) * cachePenalty;
        const batchRisk = selected.reduce((s, c) => {
          const reason = getPrimaryReason(c.reasons);
          const rate = recallRateForScoring(pruningState, reason);
          return s + 4000 * c.semanticRisk + 6000 * rate;
        }, 0);
        const batchBenefit =
          batchSavedTokens * expectedFutureTurns +
          batchSavedTokens * rotPressure;
        const batchNetValue = batchBenefit - batchDamage - batchRisk;
        const totalSemanticRisk = selected.reduce(
          (s, c) => s + c.semanticRisk,
          0,
        );

        const currentTurnCount =
          userTurnCounts.length > 0
            ? userTurnCounts[userTurnCounts.length - 1]
            : 0;
        const cooldownOk =
          isEmergency ||
          !pruningState ||
          currentTurnCount - pruningState.lastBatchUserTurnCount >=
            config.batchCooldownTurns +
              (config.adaptivePolicyEnabled
                ? pruningState.batchCooldownExtraTurns
                : 0);

        if (
          (isEmergency || batchSavedTokens >= config.batchMinSavedTokens) &&
          (isEmergency || batchNetValue >= config.batchMinNetValue) &&
          (isEmergency || totalSemanticRisk <= config.batchMaxSemanticRisk) &&
          cooldownOk
        ) {
          for (const cand of selected) {
            if (!elidedIndices.has(cand.index)) {
              applyElision(
                cand,
                isEmergency ? "emergency-pressure" : "batch-pressure",
                entries,
                result,
                pruningState,
                distances,
              );
              elidedIndices.add(cand.index);
            }
          }
          if (pruningState) {
            pruningState.lastBatchUserTurnCount = currentTurnCount;
            if (!isEmergency && config.adaptivePolicyEnabled) {
              pruningState.nonEmergencyBatchSinceLastUsage = true;
            }
          }
        }
      }
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
  const reason = latched.reason;

  const readMetadata: ReadMetadata | undefined = latched.readPath
    ? {
        normalizedPath: latched.readPath,
        ...(typeof latched.readOffset === "number"
          ? { offset: latched.readOffset }
          : {}),
        ...(typeof latched.readLimit === "number"
          ? { limit: latched.readLimit }
          : {}),
      }
    : undefined;

  if (reason === "batch-pressure") {
    return formatBatchPressureStub({
      toolName: latched.toolName,
      tokenCount: latched.originalTokens,
      toolCallId: latched.toolCallId,
      preview,
      readMetadata,
    });
  }
  if (reason === "emergency-pressure") {
    return formatEmergencyPressureStub({
      toolName: latched.toolName,
      tokenCount: latched.originalTokens,
      toolCallId: latched.toolCallId,
      preview,
      readMetadata,
    });
  }
  if (reason === "superseded-read-young" && latched.normalizedPath) {
    return formatSupersededStub({
      toolName: latched.toolName,
      normalizedPath: latched.normalizedPath,
      offset: latched.readOffset,
      limit: latched.readLimit,
      tokenCount: latched.originalTokens,
      toolCallId: latched.toolCallId,
      preview,
    });
  }
  if (
    reason === "duplicate-read-young" &&
    latched.normalizedPath &&
    latched.keptUserTurnIndex != null
  ) {
    return formatDuplicateStub({
      toolName: latched.toolName,
      normalizedPath: latched.normalizedPath,
      keptUserTurnIndex: latched.keptUserTurnIndex,
      offset: latched.readOffset,
      limit: latched.readLimit,
      tokenCount: latched.originalTokens,
      toolCallId: latched.toolCallId,
      preview,
    });
  }
  if (
    reason === "covered-read-young" &&
    latched.normalizedPath &&
    latched.keptUserTurnIndex != null
  ) {
    return formatCoveredStub({
      toolName: latched.toolName,
      normalizedPath: latched.normalizedPath,
      keptUserTurnIndex: latched.keptUserTurnIndex,
      offset: latched.readOffset,
      limit: latched.readLimit,
      tokenCount: latched.originalTokens,
      toolCallId: latched.toolCallId,
      preview,
    });
  }
  if (reason === "after-consumption-bash") {
    return formatAfterConsumptionBashStub({
      tokenCount: latched.originalTokens,
      toolCallId: latched.toolCallId,
      command: latched.command,
      preview,
    });
  }
  return formatStub({
    toolName: latched.toolName,
    tokenCount: latched.originalTokens,
    toolCallId: latched.toolCallId,
    preview,
    readMetadata,
  });
}
