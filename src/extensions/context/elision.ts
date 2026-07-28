import type {
  ContextEvent,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { estimateTokens } from "@earendil-works/pi-coding-agent";
import { classifyBashOutput } from "./bash-classifier.ts";
import { extractFilePath, normalizePath } from "./paths.ts";
import {
  EPOCH_TYPE,
  type ElisionReason,
  type EpochData,
  type EpochDecision,
  type EpochKind,
  type PruningState,
  isEpochData,
} from "./policy.ts";

type AgentMessage = ContextEvent["messages"][number];
type ToolResultMessage = Extract<AgentMessage, { role: "toolResult" }>;
type ToolCallInfo = { name: string; input: unknown };
type ReadInterval = { path: string; start: number; end: number };
type ReadRelation = { path: string; keptUserTurn: number };
type Candidate = {
  index: number;
  id: string;
  netSavings: number;
  decision: EpochDecision;
};
type EpochReplay = { warmEpochEntryId?: string; invalid: boolean };

const STALE_USER_ENTRIES = 4;
const STALE_RESULT_TOKENS = 256;
const KNOWN_COLD_SAVINGS = 8_000;
const WARM_SAVINGS = 32_000;
const WARM_DAMAGE_RATIO = 1.5;
const WARM_USER_ENTRIES = 8;
const TAIL_DAMAGE = 2_000;

export function formatStub(
  toolName: string,
  toolCallId: string,
  reason: ElisionReason,
  details: { path?: string; keptUserTurn?: number; command?: string },
): string {
  let explanation = "stale after later user requests";
  if (reason === "superseded-read") {
    explanation = `superseded by a later edit or write of ${details.path}`;
  } else if (reason === "duplicate-read") {
    explanation = `duplicated by a later read of ${details.path} at user entry ${details.keptUserTurn}`;
  } else if (reason === "covered-read") {
    explanation = `covered by a later read of ${details.path} at user entry ${details.keptUserTurn}`;
  } else if (reason === "after-consumption-bash") {
    const command = details.command
      ? ` for ${formatCommand(details.command)}`
      : "";
    explanation = `low-risk bash output consumed by an assistant${command}`;
  }
  return `[${toolName} result elided: ${explanation}. Call context_recall("${toolCallId}") to retrieve.]`;
}

function formatCommand(command: string): string {
  const escaped = command.replace(/\s+/g, " ").trim();
  return escaped.length > 120 ? `${escaped.slice(0, 119)}…` : escaped;
}

export function makeContextHook(
  state: PruningState,
  appendEntry: (
    customType: string,
    data: EpochData,
    ctx: ExtensionContext,
  ) => void,
) {
  return function handleContext(
    event: ContextEvent,
    ctx: ExtensionContext,
  ): { messages: AgentMessage[] } {
    const entries = ctx.sessionManager.getBranch();
    const replay = restoreEpochs(state, entries);
    if (replay.invalid && !state.reportedInvalidEntry) {
      state.reportedInvalidEntry = true;
      ctx.ui.notify(
        "Context: ignoring an invalid persisted pruning epoch",
        "warning",
      );
    }

    const activeIds = new Set(
      event.messages.filter(isToolResult).map((message) => message.toolCallId),
    );
    for (const id of state.decisions.keys()) {
      if (!activeIds.has(id)) {
        state.decisions.delete(id);
      }
    }

    const baseline = event.messages.slice();
    applyPersistedDecisions(baseline, state.decisions);
    const candidates = buildCandidates(baseline, state.decisions, ctx.cwd);
    const epoch = selectEpoch(candidates, baseline, entries, ctx, state);
    if (!epoch) {
      return { messages: baseline };
    }

    const data: EpochData = {
      kind: epoch.kind,
      decisions: epoch.candidates.map((candidate) => candidate.decision),
    };
    try {
      appendEntry(EPOCH_TYPE, data, ctx);
    } catch {
      if (!state.reportedAppendFailure) {
        state.reportedAppendFailure = true;
        ctx.ui.notify("Context: could not persist pruning epoch", "warning");
      }
      return { messages: baseline };
    }

    for (const candidate of epoch.candidates) {
      state.decisions.set(candidate.id, candidate.decision);
      replaceWithStub(baseline, candidate.index, candidate.decision.stub);
    }
    return { messages: baseline };
  };
}

export function restoreEpochs(
  state: PruningState,
  entries: readonly unknown[],
): EpochReplay {
  state.decisions.clear();
  state.warmEpochEntryId = undefined;
  let invalid = false;
  for (const entry of entries) {
    if (!isContextEpochEntry(entry)) {
      continue;
    }
    if (!isEpochData(entry.data)) {
      invalid = true;
      continue;
    }
    if (
      entry.data.decisions.some((decision) =>
        state.decisions.has(decision.sourceToolCallId),
      )
    ) {
      invalid = true;
      continue;
    }
    for (const decision of entry.data.decisions) {
      state.decisions.set(decision.sourceToolCallId, decision);
    }
    if (entry.data.kind === "warm") {
      state.warmEpochEntryId = entry.id;
    }
  }
  return { warmEpochEntryId: state.warmEpochEntryId, invalid };
}

function isContextEpochEntry(
  value: unknown,
): value is { type: "custom"; id: string; customType: string; data: unknown } {
  return (
    isRecord(value) &&
    value.type === "custom" &&
    value.customType === EPOCH_TYPE &&
    typeof value.id === "string"
  );
}

function applyPersistedDecisions(
  messages: AgentMessage[],
  decisions: ReadonlyMap<string, EpochDecision>,
): void {
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (!isToolResult(message)) {
      continue;
    }
    const decision = !message.isError
      ? decisions.get(message.toolCallId)
      : undefined;
    if (decision) {
      replaceWithStub(messages, index, decision.stub);
    }
  }
}

function replaceWithStub(
  messages: AgentMessage[],
  index: number,
  stub: string,
): void {
  const message = messages[index];
  if (!isToolResult(message)) {
    return;
  }
  messages[index] = {
    ...message,
    content: [{ type: "text", text: stub }],
  };
}

function buildCandidates(
  messages: AgentMessage[],
  decisions: ReadonlyMap<string, EpochDecision>,
  cwd: string,
): Candidate[] {
  const toolCalls = collectToolCalls(messages);
  const mutations = collectMutations(messages, toolCalls, cwd);
  const reads = collectReads(messages, toolCalls, cwd);
  const duplicateReads = relationMap(reads, mutations, true);
  const coveredReads = relationMap(reads, mutations, false);
  const staleUsers = userEntriesAfter(messages);
  const assistantAfter = assistantAfterEach(messages);
  const candidates: Candidate[] = [];
  const seenToolCallIds = new Set<string>();

  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (!isToolResult(message) || seenToolCallIds.has(message.toolCallId)) {
      continue;
    }
    seenToolCallIds.add(message.toolCallId);
    if (message.isError || decisions.has(message.toolCallId)) {
      continue;
    }
    const toolCall = toolCalls.get(message.toolCallId);
    const path = readPath(message, toolCall, cwd);
    const superseded = path && hasLaterMutation(mutations.get(path), index);
    const duplicate = duplicateReads.get(message.toolCallId);
    const covered = coveredReads.get(message.toolCallId);
    const command = bashCommand(toolCall);
    const lowRiskBash =
      message.toolName === "bash" &&
      assistantAfter[index] &&
      classifyBashOutput(message.content, estimateTokens(message), 0).lowRisk;

    let reason: ElisionReason | undefined;
    let details: { path?: string; keptUserTurn?: number; command?: string } =
      {};
    if (assistantAfter[index] && superseded && path) {
      reason = "superseded-read";
      details = { path };
    } else if (assistantAfter[index] && duplicate) {
      reason = "duplicate-read";
      details = duplicate;
    } else if (assistantAfter[index] && covered) {
      reason = "covered-read";
      details = covered;
    } else if (lowRiskBash) {
      reason = "after-consumption-bash";
      details = command ? { command } : {};
    } else if (
      staleUsers[index] >= STALE_USER_ENTRIES &&
      estimateTokens(message) >= STALE_RESULT_TOKENS
    ) {
      reason = "standard-stale";
    }
    if (!reason) {
      continue;
    }

    const stub = formatStub(
      message.toolName ?? "tool",
      message.toolCallId,
      reason,
      details,
    );
    const replacement = {
      ...message,
      content: [{ type: "text" as const, text: stub }],
    };
    const netSavings = estimateTokens(message) - estimateTokens(replacement);
    if (!Number.isSafeInteger(netSavings) || netSavings <= 0) {
      continue;
    }
    candidates.push({
      index,
      id: message.toolCallId,
      netSavings,
      decision: {
        sourceToolCallId: message.toolCallId,
        reason,
        stub,
        estimatedTokensSaved: netSavings,
      },
    });
  }
  return candidates.sort(
    (left, right) =>
      left.index - right.index || left.id.localeCompare(right.id),
  );
}

function collectToolCalls(messages: AgentMessage[]): Map<string, ToolCallInfo> {
  const calls = new Map<string, ToolCallInfo>();
  for (const message of messages) {
    if (message.role !== "assistant") {
      continue;
    }
    for (const content of message.content) {
      if (content.type === "toolCall") {
        calls.set(content.id, { name: content.name, input: content.arguments });
      }
    }
  }
  return calls;
}

function collectMutations(
  messages: AgentMessage[],
  calls: ReadonlyMap<string, ToolCallInfo>,
  cwd: string,
): Map<string, number[]> {
  const mutations = new Map<string, number[]>();
  messages.forEach((message, index) => {
    if (
      !isToolResult(message) ||
      message.isError ||
      (message.toolName !== "edit" && message.toolName !== "write")
    ) {
      return;
    }
    const path = normalizePath(
      extractFilePath(message.toolName, calls.get(message.toolCallId)?.input),
      cwd,
    );
    if (path) {
      const positions = mutations.get(path) ?? [];
      positions.push(index);
      mutations.set(path, positions);
    }
  });
  return mutations;
}

type ReadEntry = ReadInterval & {
  index: number;
  id: string;
  keptUserTurn: number;
};

function collectReads(
  messages: AgentMessage[],
  calls: ReadonlyMap<string, ToolCallInfo>,
  cwd: string,
): ReadEntry[] {
  const userTurns = userEntriesUpTo(messages);
  const reads: ReadEntry[] = [];
  messages.forEach((message, index) => {
    if (
      !isToolResult(message) ||
      message.isError ||
      message.toolName !== "read"
    ) {
      return;
    }
    const interval = readInterval(message, calls.get(message.toolCallId), cwd);
    if (interval) {
      reads.push({
        ...interval,
        index,
        id: message.toolCallId,
        keptUserTurn: userTurns[index],
      });
    }
  });
  return reads;
}

function relationMap(
  reads: readonly ReadEntry[],
  mutations: ReadonlyMap<string, number[]>,
  exact: boolean,
): Map<string, ReadRelation> {
  const relations = new Map<string, ReadRelation>();
  for (let earlierIndex = 0; earlierIndex < reads.length; earlierIndex++) {
    const earlier = reads[earlierIndex];
    for (
      let laterIndex = earlierIndex + 1;
      laterIndex < reads.length;
      laterIndex++
    ) {
      const later = reads[laterIndex];
      if (
        earlier.path !== later.path ||
        hasMutationBetween(
          mutations.get(earlier.path),
          earlier.index,
          later.index,
        )
      ) {
        continue;
      }
      const matches = exact
        ? later.start === earlier.start && later.end === earlier.end
        : later.start <= earlier.start && later.end >= earlier.end;
      if (matches) {
        relations.set(earlier.id, {
          path: earlier.path,
          keptUserTurn: later.keptUserTurn,
        });
        break;
      }
    }
  }
  return relations;
}

function readPath(
  message: ToolResultMessage,
  call: ToolCallInfo | undefined,
  cwd: string,
): string | undefined {
  if (message.toolName !== "read") {
    return undefined;
  }
  return normalizePath(extractFilePath("read", call?.input), cwd) ?? undefined;
}

function readInterval(
  message: ToolResultMessage,
  call: ToolCallInfo | undefined,
  cwd: string,
): ReadInterval | undefined {
  const path = readPath(message, call, cwd);
  if (
    !path ||
    !isRecord(call?.input) ||
    message.content.length !== 1 ||
    message.content[0]?.type !== "text"
  ) {
    return undefined;
  }
  const offset = call.input.offset === undefined ? 1 : call.input.offset;
  const limit = call.input.limit;
  if (
    !Number.isInteger(offset) ||
    (offset as number) < 1 ||
    (limit !== undefined && (!Number.isInteger(limit) || (limit as number) < 1))
  ) {
    return undefined;
  }
  const requestedLimit = limit as number | undefined;
  const truncation = isRecord(
    (message as unknown as { details?: unknown }).details,
  )
    ? (message as unknown as { details: Record<string, unknown> }).details
        .truncation
    : undefined;
  if (
    !isTruncation(truncation) ||
    truncation.outputLines === 0 ||
    truncation.lastLinePartial ||
    truncation.firstLineExceedsLimit ||
    (requestedLimit !== undefined && truncation.outputLines > requestedLimit)
  ) {
    return undefined;
  }
  return {
    path,
    start: offset as number,
    end: (offset as number) + truncation.outputLines - 1,
  };
}

function isTruncation(value: unknown): value is {
  content: string;
  totalLines: number;
  totalBytes: number;
  outputLines: number;
  outputBytes: number;
  truncated: boolean;
  truncatedBy: "lines" | "bytes" | null;
  lastLinePartial: boolean;
  firstLineExceedsLimit: boolean;
  maxLines: number;
  maxBytes: number;
} {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "content",
      "totalLines",
      "totalBytes",
      "outputLines",
      "outputBytes",
      "truncated",
      "truncatedBy",
      "lastLinePartial",
      "firstLineExceedsLimit",
      "maxLines",
      "maxBytes",
    ]) ||
    typeof value.content !== "string" ||
    !nonnegativeInteger(value.totalLines) ||
    !nonnegativeInteger(value.totalBytes) ||
    !nonnegativeInteger(value.outputLines) ||
    !nonnegativeInteger(value.outputBytes) ||
    !positiveInteger(value.maxLines) ||
    !positiveInteger(value.maxBytes) ||
    typeof value.truncated !== "boolean" ||
    (value.truncatedBy !== "lines" &&
      value.truncatedBy !== "bytes" &&
      value.truncatedBy !== null) ||
    typeof value.lastLinePartial !== "boolean" ||
    typeof value.firstLineExceedsLimit !== "boolean" ||
    value.outputLines > value.totalLines ||
    value.outputBytes > value.totalBytes ||
    value.outputLines > value.maxLines ||
    value.outputBytes > value.maxBytes ||
    (value.truncatedBy === "bytes" && value.totalBytes <= value.maxBytes)
  ) {
    return false;
  }
  if (!value.truncated) {
    return (
      value.truncatedBy === null &&
      !value.lastLinePartial &&
      !value.firstLineExceedsLimit &&
      value.outputLines === value.totalLines &&
      value.outputBytes === value.totalBytes
    );
  }
  if (value.truncatedBy === null || value.lastLinePartial) {
    return false;
  }
  return value.firstLineExceedsLimit
    ? value.truncatedBy === "bytes" &&
        value.outputLines === 0 &&
        value.outputBytes === 0
    : value.truncatedBy === "lines"
      ? value.outputLines === value.maxLines &&
        value.totalLines > value.outputLines
      : value.outputBytes <= value.maxBytes &&
        value.totalLines > value.outputLines;
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function nonnegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function hasLaterMutation(
  positions: readonly number[] | undefined,
  index: number,
): boolean {
  return positions?.some((position) => position > index) ?? false;
}

function hasMutationBetween(
  positions: readonly number[] | undefined,
  start: number,
  end: number,
): boolean {
  return (
    positions?.some((position) => position > start && position < end) ?? false
  );
}

function bashCommand(call: ToolCallInfo | undefined): string | undefined {
  return isRecord(call?.input) && typeof call.input.command === "string"
    ? call.input.command
    : undefined;
}

function userEntriesAfter(messages: AgentMessage[]): number[] {
  const result = Array<number>(messages.length).fill(0);
  let count = 0;
  for (let index = messages.length - 1; index >= 0; index--) {
    result[index] = count;
    if (messages[index]?.role === "user") {
      count++;
    }
  }
  return result;
}

function userEntriesUpTo(messages: AgentMessage[]): number[] {
  const result = Array<number>(messages.length).fill(0);
  let count = 0;
  messages.forEach((message, index) => {
    if (message.role === "user") {
      count++;
    }
    result[index] = count;
  });
  return result;
}

function assistantAfterEach(messages: AgentMessage[]): boolean[] {
  const result = Array<boolean>(messages.length).fill(false);
  let found = false;
  for (let index = messages.length - 1; index >= 0; index--) {
    result[index] = found;
    if (messages[index]?.role === "assistant") {
      found = true;
    }
  }
  return result;
}

function selectEpoch(
  candidates: Candidate[],
  baseline: AgentMessage[],
  entries: readonly unknown[],
  ctx: ExtensionContext,
  state: PruningState,
): { kind: EpochKind; candidates: Candidate[] } | undefined {
  const suffixes = candidates.map((_, start) => candidates.slice(start));
  if (isKnownCold(entries, ctx)) {
    const suffix = suffixes.find(
      (members) => sumSavings(members) >= KNOWN_COLD_SAVINGS,
    );
    if (suffix) {
      return { kind: "known-cold", candidates: suffix };
    }
  }
  if (
    usersSinceWarmEpoch(entries, state.warmEpochEntryId) >= WARM_USER_ENTRIES
  ) {
    const suffix = suffixes.find((members) => {
      const savings = sumSavings(members);
      return (
        savings >= WARM_SAVINGS &&
        suffixDamage(baseline, members) / savings <= WARM_DAMAGE_RATIO
      );
    });
    if (suffix) {
      return { kind: "warm", candidates: suffix };
    }
  }
  const suffix = suffixes.find(
    (members) => suffixDamage(baseline, members) <= TAIL_DAMAGE,
  );
  return suffix ? { kind: "tail", candidates: suffix } : undefined;
}

function sumSavings(candidates: readonly Candidate[]): number {
  return candidates.reduce((sum, candidate) => sum + candidate.netSavings, 0);
}

function suffixDamage(
  messages: readonly AgentMessage[],
  candidates: readonly Candidate[],
): number {
  const index = candidates[0]?.index;
  return index === undefined
    ? 0
    : messages
        .slice(index)
        .reduce((sum, message) => sum + estimateTokens(message), 0);
}

function isKnownCold(
  entries: readonly unknown[],
  ctx: ExtensionContext,
): boolean {
  const model = ctx.model as { provider?: string; id?: string } | undefined;
  if (!model?.provider || !model.id) {
    return false;
  }
  let modelChangeIndex = -1;
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (isRecord(entry) && entry.type === "model_change") {
      modelChangeIndex = index;
      break;
    }
  }
  if (modelChangeIndex < 1) {
    return false;
  }
  const change = entries[modelChangeIndex] as Record<string, unknown>;
  if (change.provider !== model.provider || change.modelId !== model.id) {
    return false;
  }
  const previousModelChange = entries
    .slice(0, modelChangeIndex)
    .reverse()
    .find((entry) => isRecord(entry) && entry.type === "model_change");
  if (
    !previousModelChange ||
    ((previousModelChange as Record<string, unknown>).provider ===
      model.provider &&
      (previousModelChange as Record<string, unknown>).modelId === model.id)
  ) {
    return false;
  }
  return !entries.slice(modelChangeIndex + 1).some((entry) => {
    if (!isRecord(entry)) {
      return false;
    }
    return (
      entry.type === "compaction" ||
      (entry.type === "message" &&
        isRecord(entry.message) &&
        entry.message.role === "assistant")
    );
  });
}

function usersSinceWarmEpoch(
  entries: readonly unknown[],
  warmEpochEntryId: string | undefined,
): number {
  const start = warmEpochEntryId
    ? entries.findIndex(
        (entry) => isRecord(entry) && entry.id === warmEpochEntryId,
      ) + 1
    : 0;
  return entries
    .slice(start)
    .filter(
      (entry) =>
        isRecord(entry) &&
        entry.type === "message" &&
        isRecord(entry.message) &&
        entry.message.role === "user",
    ).length;
}

function isToolResult(message: AgentMessage): message is ToolResultMessage {
  return message.role === "toolResult";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
