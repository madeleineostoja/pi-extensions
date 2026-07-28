export const EPOCH_TYPE = "pipkin.context.epoch.v1";

export const EPOCH_KINDS = ["known-cold", "warm", "tail"] as const;
export type EpochKind = (typeof EPOCH_KINDS)[number];

export const ELISION_REASONS = [
  "superseded-read",
  "duplicate-read",
  "covered-read",
  "after-consumption-bash",
  "standard-stale",
] as const;
export type ElisionReason = (typeof ELISION_REASONS)[number];

export type EpochDecision = {
  sourceToolCallId: string;
  reason: ElisionReason;
  stub: string;
  estimatedTokensSaved?: number;
};

export type EpochData = {
  kind: EpochKind;
  decisions: EpochDecision[];
};

export type PruningState = {
  decisions: Map<string, EpochDecision>;
  warmEpochEntryId?: string;
  reportedInvalidEntry: boolean;
  reportedAppendFailure: boolean;
};

export function createPruningState(): PruningState {
  return {
    decisions: new Map(),
    reportedInvalidEntry: false,
    reportedAppendFailure: false,
  };
}

export function resetPruningState(state: PruningState): void {
  state.decisions.clear();
  state.warmEpochEntryId = undefined;
  state.reportedInvalidEntry = false;
  state.reportedAppendFailure = false;
}

export function isEpochData(value: unknown): value is EpochData {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["kind", "decisions"]) ||
    !isEpochKind(value.kind) ||
    !Array.isArray(value.decisions)
  ) {
    return false;
  }
  const ids = new Set<string>();
  for (const decision of value.decisions) {
    if (!isDecision(decision) || ids.has(decision.sourceToolCallId)) {
      return false;
    }
    ids.add(decision.sourceToolCallId);
  }
  return value.decisions.length > 0;
}

export function isEpochKind(value: unknown): value is EpochKind {
  return typeof value === "string" && EPOCH_KINDS.includes(value as EpochKind);
}

function isDecision(value: unknown): value is EpochDecision {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      "sourceToolCallId",
      "reason",
      "stub",
      "estimatedTokensSaved",
    ]) &&
    typeof value.sourceToolCallId === "string" &&
    value.sourceToolCallId.trim().length > 0 &&
    typeof value.reason === "string" &&
    ELISION_REASONS.includes(value.reason as ElisionReason) &&
    typeof value.stub === "string" &&
    value.stub.length > 0 &&
    value.stub.includes(`context_recall("${value.sourceToolCallId}")`) &&
    (value.estimatedTokensSaved === undefined ||
      isPositiveSafeInteger(value.estimatedTokensSaved))
  );
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
