import {
  buildSessionContext,
  calculateContextTokens,
  estimateTokens,
  findCutPoint,
} from "@earendil-works/pi-coding-agent";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export type CompactionPreparation = {
  firstKeptEntryId: string;
  messagesToSummarize: { role: string; [key: string]: unknown }[];
  turnPrefixMessages: { role: string; [key: string]: unknown }[];
  isSplitTurn: boolean;
  tokensBefore: number;
  naiveContextTokens: number;
  previousSummary?: string;
  fileOps: unknown;
  settings: {
    enabled: boolean;
    reserveTokens: number;
    keepRecentTokens: number;
  };
};

export function prepareCompaction(
  pathEntries: SessionEntry[],
  settings: CompactionPreparation["settings"],
): CompactionPreparation | undefined {
  if (
    pathEntries.length > 0 &&
    pathEntries[pathEntries.length - 1].type === "compaction"
  ) {
    return undefined;
  }

  let prevCompactionIndex = -1;
  for (let i = pathEntries.length - 1; i >= 0; i--) {
    if (pathEntries[i].type === "compaction") {
      prevCompactionIndex = i;
      break;
    }
  }

  let previousSummary: string | undefined;
  let boundaryStart = 0;
  if (prevCompactionIndex >= 0) {
    const prevCompaction = pathEntries[prevCompactionIndex] as {
      summary: string;
      firstKeptEntryId: string;
    };
    previousSummary = prevCompaction.summary;
    const firstKeptEntryIndex = pathEntries.findIndex(
      (entry) => entry.id === prevCompaction.firstKeptEntryId,
    );
    boundaryStart =
      firstKeptEntryIndex >= 0 ? firstKeptEntryIndex : prevCompactionIndex + 1;
  }

  const boundaryEnd = pathEntries.length;
  const ctxMessages = buildSessionContext(pathEntries).messages as unknown as {
    role: string;
    [key: string]: unknown;
  }[];
  const { tokens: tokensBefore } = estimateContextTokens(ctxMessages);
  const naiveContextTokens = ctxMessages.reduce(
    (sum, msg) => sum + estimateTokens(msg as never),
    0,
  );

  const cutPoint = findCutPoint(
    pathEntries,
    boundaryStart,
    boundaryEnd,
    settings.keepRecentTokens,
  );

  const firstKeptEntry = pathEntries[cutPoint.firstKeptEntryIndex];
  if (!firstKeptEntry?.id) {
    return undefined;
  }

  const historyEnd = cutPoint.isSplitTurn
    ? cutPoint.turnStartIndex
    : cutPoint.firstKeptEntryIndex;

  const messagesToSummarize: { role: string; [key: string]: unknown }[] = [];
  for (let i = boundaryStart; i < historyEnd; i++) {
    const msg = getMessageFromEntryForCompaction(pathEntries[i]);
    if (msg) {
      messagesToSummarize.push(msg);
    }
  }

  const turnPrefixMessages: { role: string; [key: string]: unknown }[] = [];
  if (cutPoint.isSplitTurn) {
    for (
      let i = cutPoint.turnStartIndex;
      i < cutPoint.firstKeptEntryIndex;
      i++
    ) {
      const msg = getMessageFromEntryForCompaction(pathEntries[i]);
      if (msg) {
        turnPrefixMessages.push(msg);
      }
    }
  }

  return {
    firstKeptEntryId: firstKeptEntry.id,
    messagesToSummarize,
    turnPrefixMessages,
    isSplitTurn: cutPoint.isSplitTurn,
    tokensBefore,
    naiveContextTokens,
    previousSummary,
    fileOps: {},
    settings,
  };
}

export function estimateContextTokens(
  messages: { role: string; [key: string]: unknown }[],
): {
  tokens: number;
  usageTokens: number;
  trailingTokens: number;
  lastUsageIndex: number | null;
} {
  let lastUsageIndex = -1;
  let lastUsage:
    | {
        totalTokens?: number;
        input: number;
        output: number;
        cacheRead: number;
        cacheWrite: number;
      }
    | undefined;

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (
      msg.role === "assistant" &&
      "usage" in msg &&
      msg.usage &&
      msg.stopReason !== "aborted" &&
      msg.stopReason !== "error"
    ) {
      lastUsage = msg.usage as typeof lastUsage;
      lastUsageIndex = i;
      break;
    }
  }

  if (!lastUsage) {
    let estimated = 0;
    for (const message of messages) {
      estimated += estimateTokens(message as never);
    }
    return {
      tokens: estimated,
      usageTokens: 0,
      trailingTokens: estimated,
      lastUsageIndex: null,
    };
  }

  const usageTokens = calculateContextTokens(lastUsage as never);
  let trailingTokens = 0;
  for (let i = lastUsageIndex + 1; i < messages.length; i++) {
    trailingTokens += estimateTokens(messages[i] as never);
  }

  return {
    tokens: usageTokens + trailingTokens,
    usageTokens,
    trailingTokens,
    lastUsageIndex,
  };
}

function getMessageFromEntryForCompaction(
  entry: SessionEntry,
): { role: string; [key: string]: unknown } | undefined {
  if (entry.type === "compaction") {
    return undefined;
  }
  if (entry.type === "message") {
    return entry.message as unknown as {
      role: string;
      [key: string]: unknown;
    };
  }
  if (entry.type === "custom_message") {
    return {
      role: "custom",
      content: entry.content,
      timestamp: entry.timestamp,
    };
  }
  if (entry.type === "branch_summary") {
    return {
      role: "branchSummary",
      summary: entry.summary,
      timestamp: entry.timestamp,
    };
  }
  return undefined;
}
