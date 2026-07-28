import type { EntryRenderer } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { type ElisionReason, type EpochData, isEpochData } from "./policy.ts";

const REASON_LABELS: Record<ElisionReason, string> = {
  "superseded-read": "superseded reads",
  "duplicate-read": "duplicate reads",
  "covered-read": "covered reads",
  "after-consumption-bash": "consumed bash",
  "standard-stale": "stale results",
};

export const renderEpochEntry: EntryRenderer<EpochData> = (
  entry,
  { expanded },
  theme,
) => {
  if (!isEpochData(entry.data)) {
    return undefined;
  }

  const savings = totalSavings(entry.data);
  const count = entry.data.decisions.length;
  const collapsed =
    savings === undefined
      ? `context · ${count} ${resultLabel(count)} pruned · ${entry.data.kind}`
      : `context · ${tokenEstimate(savings)} reclaimed from ${count} ${resultLabel(count)} · ${entry.data.kind}`;
  if (!expanded) {
    return new Text(theme.fg("muted", collapsed), 0, 0);
  }

  const lines = [theme.fg("muted", collapsed)];
  for (const reason of Object.keys(REASON_LABELS) as ElisionReason[]) {
    const decisions = entry.data.decisions.filter(
      (decision) => decision.reason === reason,
    );
    if (decisions.length === 0) {
      continue;
    }
    const reasonSavings =
      savings === undefined
        ? undefined
        : totalSavings({
            ...entry.data,
            decisions,
          });
    const detail = `${REASON_LABELS[reason]} · ${decisions.length} ${resultLabel(decisions.length)}`;
    lines.push(
      theme.fg(
        "dim",
        reasonSavings === undefined
          ? `  ${detail}`
          : `  ${detail} · ${tokenEstimate(reasonSavings)}`,
      ),
    );
  }
  return new Text(lines.join("\n"), 0, 0);
};

function totalSavings(data: EpochData): number | undefined {
  if (
    data.decisions.some(
      (decision) => decision.estimatedTokensSaved === undefined,
    )
  ) {
    return undefined;
  }
  return data.decisions.reduce(
    (total, decision) => total + (decision.estimatedTokensSaved ?? 0),
    0,
  );
}

function resultLabel(count: number): string {
  return count === 1 ? "result" : "results";
}

function tokenEstimate(tokens: number): string {
  return tokens >= 1_000 ? `~${Math.round(tokens / 1_000)}k` : `~${tokens}`;
}
