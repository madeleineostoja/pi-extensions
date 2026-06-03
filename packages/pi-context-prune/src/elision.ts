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

export function formatBatchPressureStub({
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
  return `[${toolName} result compacted by cache-aware batch pruning: ${formatTokenCount(tokenCount)}.${previewSegment} Call context_recall("${toolCallId}") to retrieve.]`;
}

export function formatEmergencyPressureStub({
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
  return `[${toolName} result elided (emergency context pressure): ${formatTokenCount(tokenCount)}.${previewSegment} Call context_recall("${toolCallId}") to retrieve.]`;
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
  bashCommand?: string;
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
    });
  }
  if (actionReason === "emergency-pressure") {
    return formatEmergencyPressureStub({
      toolName,
      tokenCount,
      toolCallId: cand.msg.toolCallId,
      preview,
    });
  }
  if (actionReason === "superseded-read-young" && cand.supersededPath) {
    return formatSupersededStub({
      toolName,
      normalizedPath: cand.supersededPath,
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
    if (primaryReason === "after-consumption-bash" && cand.bashCommand) {
      latched.command = cand.bashCommand;
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

    const { toolCallInfoMap, supersededPaths } = buildSupersededMaps(
      messages,
      cwd,
    );
    const duplicateReadMap = buildDuplicateReadMap(
      messages,
      cwd,
      toolCallInfoMap,
    );
    const hasAssistantAfter = config.afterConsumptionBashEnabled
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
      let bashCommand: string | undefined;
      let readPath: string | null = null;

      if (msg.toolName === "read" && toolCallInfoMap) {
        const callInfo = toolCallInfoMap.get(msg.toolCallId);
        if (callInfo) {
          readPath = normalizePath(
            extractFilePath("read", callInfo.input),
            cwd,
          );
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
          bashCommand,
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
        !reasons.includes("superseded-read-young");
      const profile = getProfileForReason(
        primaryReason as Exclude<ElisionReason, "emergency-pressure">,
      );

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
          : (BATCH_PRIORITY[
              primaryReason as Exclude<ElisionReason, "emergency-pressure">
            ] ?? 5),
        isOrdinarySourceRead,
        supersededPath,
        duplicateInfo,
        bashCommand,
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
      const primaryReason = getPrimaryReason(cand.reasons) as Exclude<
        ElisionReason,
        "emergency-pressure"
      >;
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

      const selected: Candidate[] = [];
      for (const cand of deferred) {
        if (!isEmergency && cand.isOrdinarySourceRead) {
          continue;
        }
        if (selected.length >= config.batchMaxCandidates) {
          break;
        }
        selected.push(cand);
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

  if (reason === "batch-pressure") {
    return formatBatchPressureStub({
      toolName: latched.toolName,
      tokenCount: latched.originalTokens,
      toolCallId: latched.toolCallId,
      preview,
    });
  }
  if (reason === "emergency-pressure") {
    return formatEmergencyPressureStub({
      toolName: latched.toolName,
      tokenCount: latched.originalTokens,
      toolCallId: latched.toolCallId,
      preview,
    });
  }
  if (reason === "superseded-read-young" && latched.normalizedPath) {
    return formatSupersededStub({
      toolName: latched.toolName,
      normalizedPath: latched.normalizedPath,
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
  });
}
