export type ToolStats = {
  toolName: string;
  tokens: number;
  entries: number;
  recalls: number;
};

export type StatsSnapshot = {
  tokensElidedCumulative: number;
  elidedCountLatest: number;
  recallCount: number;
  byTool: ToolStats[];
};

export type ElisionPassEntry = {
  toolCallId: string;
  tokenCount: number;
  toolName: string;
  reason: string;
  savedTokens: number;
  stubTokens: number;
  suffixTokens: number;
};

export type ElisionPassResult = {
  entries: ElisionPassEntry[];
};

export type StatsStore = {
  onElisionPass(result: ElisionPassResult): void;
  onRecall(toolName: string, toolCallId?: string, reason?: string): void;
  reset(): void;
  snapshot(): StatsSnapshot;
};

export function createStatsStore(): StatsStore {
  const elidedById = new Map<
    string,
    { savedTokens: number; toolName: string }
  >();
  let elidedCountLatest = 0;
  let recallCount = 0;
  const recallsByTool = new Map<string, number>();

  return {
    onElisionPass({ entries }: ElisionPassResult): void {
      for (const { toolCallId, savedTokens, toolName } of entries) {
        elidedById.set(toolCallId, { savedTokens, toolName });
      }
      elidedCountLatest = entries.length;
    },
    onRecall(toolName: string, _toolCallId?: string, _reason?: string): void {
      recallCount += 1;
      recallsByTool.set(toolName, (recallsByTool.get(toolName) ?? 0) + 1);
    },
    reset(): void {
      elidedById.clear();
      elidedCountLatest = 0;
      recallCount = 0;
      recallsByTool.clear();
    },
    snapshot(): StatsSnapshot {
      let tokensElidedCumulative = 0;
      const toolTokensMap = new Map<string, number>();
      const toolEntriesMap = new Map<string, number>();

      for (const { savedTokens, toolName } of elidedById.values()) {
        tokensElidedCumulative += savedTokens;
        toolTokensMap.set(
          toolName,
          (toolTokensMap.get(toolName) ?? 0) + savedTokens,
        );
        toolEntriesMap.set(toolName, (toolEntriesMap.get(toolName) ?? 0) + 1);
      }

      const byTool: ToolStats[] = Array.from(toolTokensMap.keys())
        .map((toolName) => ({
          toolName,
          tokens: toolTokensMap.get(toolName)!,
          entries: toolEntriesMap.get(toolName)!,
          recalls: recallsByTool.get(toolName) ?? 0,
        }))
        .sort((a, b) => {
          if (b.tokens !== a.tokens) {
            return b.tokens - a.tokens;
          }
          return a.toolName.localeCompare(b.toolName);
        });

      return { tokensElidedCumulative, elidedCountLatest, recallCount, byTool };
    },
  };
}

import { formatTokenCount } from "./elision.ts";

function plural(count: number, singular: string, pluralStr: string): string {
  return count === 1 ? `${count} ${singular}` : `${count} ${pluralStr}`;
}

export function formatStats(snapshot: StatsSnapshot): string {
  const lines = [
    `tokens elided (cumulative): ${formatTokenCount(snapshot.tokensElidedCumulative)}`,
    `entries elided (latest pass): ${snapshot.elidedCountLatest}`,
    `context_recall invocations: ${snapshot.recallCount}`,
  ];

  if (snapshot.byTool.length > 0) {
    lines.push("");
    lines.push("by tool:");
    for (const { toolName, tokens, entries, recalls } of snapshot.byTool) {
      lines.push(
        `  ${toolName}   ${formatTokenCount(tokens)}  (${plural(entries, "entry", "entries")}, ${plural(recalls, "recall", "recalls")})`,
      );
    }
  }

  return lines.join("\n");
}
