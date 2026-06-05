# pi-context-prune

A Pi extension that keeps the context window small by pruning large, stale tool results and letting the LLM fetch them back on demand.

## What it does

On every context event pi-context-prune scans all `toolResult` messages. Results that meet the staleness and size thresholds are replaced in-context with a reasoned stub. The extension also compacts bash output after assistant consumption, stubs reads that have been superseded by a later edit or written more than once, and runs batch old-history pruning with cache-aware scoring. The original content remains in the active session store and can be retrieved via `context_recall` while that tool-result message is still retained by Pi.

Error results (`isError: true`) are never elided by the standard or batch rules. They may still be stubbed by rot rules (superseded/duplicate) because the failure semantics do not change.

## Stub formats

### Standard elision stub

Emitted when a result is old enough and large enough (both thresholds met):

```
[ToolName result elided: SIZE. Preview: "PREVIEW". Call context_recall("TOOL_CALL_ID") to retrieve.]
```

### Superseded-read stub

Emitted when a `read` result is later overwritten by an `edit` or `write`, regardless of age or size:

```
[read result elided (superseded by later edit/write of PATH): SIZE. Preview: "PREVIEW". Call context_recall("TOOL_CALL_ID") to retrieve original.]
```

### Duplicate-read stub

Emitted when the same file is read more than once with the same `offset`/`limit`. All reads except the most recent are stubbed. The stub references `turn`, the 1-indexed user-turn number during which the kept read occurred:

```
[read result elided (superseded by later read of PATH at turn TURN): SIZE. Preview: "PREVIEW". Call context_recall("TOOL_CALL_ID") to retrieve.]
```

### After-consumption bash stub

Emitted when a successful, low-risk `bash` result is followed by an assistant message. The command text is included when recoverable from the tool call arguments; newlines/tabs are escaped and long commands are truncated in the stub:

```
[bash output compacted after assistant consumption: SIZE. Command: COMMAND. Status: success. Preview: "PREVIEW". Call context_recall("TOOL_CALL_ID") to retrieve full output.]
```

### Batch-pressure stub

Emitted when a candidate is selected by the cache-aware batch old-history pruner:

```
[ToolName result compacted by cache-aware batch pruning: SIZE. Preview: "PREVIEW". Call context_recall("TOOL_CALL_ID") to retrieve.]
```

### Emergency-pressure stub

Emitted when the context window is within `emergencyContextReserveTokens` of its limit:

```
[ToolName result elided (emergency context pressure): SIZE. Preview: "PREVIEW". Call context_recall("TOOL_CALL_ID") to retrieve.]
```

When multiple reasons apply to the same result, the most semantically specific stub takes precedence: superseded-read > duplicate-read > after-consumption-bash > standard-stale.

### Preview segment

All stubs include a `Preview: "..."` segment showing the first 100 characters of the text content, with `\`, `"`, `\n`, and `\t` escaped. When the source exceeds 100 characters, the preview ends with `…` inside the closing quote. The preview segment is omitted only when the result contains no text blocks (e.g. image-only results).

`TOOL_CALL_ID` is the `toolCallId` of the original tool call. `SIZE` is the estimated token count formatted as a human-readable string (e.g. `310 tokens`, `1.2K tokens`, `34K tokens`). Token count is estimated using the same `ceil(chars / 4)` heuristic that Pi uses internally. Image blocks are excluded from this count — elision eligibility is based on text payload only.

## Policy model

pi-context-prune uses a bounded adaptive pruning policy with several mechanisms working together:

1. **After-consumption compaction** — Large, low-risk successful `bash` outputs that have already been consumed by an assistant message are compacted immediately. This saves tokens for completed work without hurting the cache because the assistant turn already broke the prefix.

2. **Young-or-batch read rot** — Superseded and duplicate reads are stubbed immediately when the suffix cost is low enough, or deferred to batch pruning when the suffix is large. This avoids expensive cache invalidations near the tail while still reclaiming rot tokens in old history.

3. **Batch old-history pruning** — Deferred candidates are sorted by semantic risk and evaluated as a batch. A candidate is selected only when the aggregate saved tokens exceed a minimum, the net value (saved tokens minus suffix damage and recall risk) is positive, and semantic risk is within bounds. A configurable cooldown prevents batch pruning from running every turn.

4. **Bounded adaptive scoring** — Each pruning reason has a profile with `minSuffixBudget`, `baselineSuffixBudget`, `maxSuffixBudget`, and `semanticRisk`. The effective suffix budget and minimum saved tokens are adjusted per-turn based on cache hit telemetry and recall rates, but only within the profile's bounds. The adaptive state is reset when the provider or model changes.

5. **Cache telemetry** — Assistant-message usage data (input, cache read, cache write) is ingested to compute a rolling cache-hit rate. High cache hits make the policy slightly more conservative; low cache hits or rising rot pressure make it slightly more aggressive. The step size is capped to avoid oscillation.

6. **Guardrails** — Ordinary source reads are never aggressively compacted solely because they are large. Emergency pressure can bypass the cooldown and minimum thresholds, but it still respects the batch candidate cap. Unknown config keys are ignored and malformed values fall back to defaults with a warning.

7. **Recall guarantees** — `context_recall` returns the original raw tool result content, unchanged, as long as Pi still retains the original tool-result message in the active session store. Elision decisions are latched per active `toolCallId` and preserved across context passes so that once a retained result is stubbed it stays stubbed with the same reason.

## Thresholds

| Config key   | Default | Effect of increasing                         | Effect of decreasing                                       |
| ------------ | ------- | -------------------------------------------- | ---------------------------------------------------------- |
| `staleTurns` | `4`     | Elide results later (more context kept live) | Elide results sooner (smaller context, more recall needed) |
| `minTokens`  | `256`   | Only elide larger results                    | Elide even small results                                   |

Both thresholds must be met simultaneously for a result to be eligible for the **standard-stale** rule. They are retained for backward compatibility; the newer rot, bash, batch, and emergency rules use their own profiles and guardrails.

**Rot rules and batch rules bypass these thresholds.** Superseded-read, duplicate-read, after-consumption-bash, and batch-pressure detection stub results based on semantic value and suffix cost, not on age or size alone.

Note: image blocks within a tool result do not count toward `minTokens`. Elision eligibility is based on text payload only.

## Config file

pi-context-prune reads optional configuration from:

```
~/.pi/agent/extensions/pi-context-prune/config.json
```

The file is loaded once at session start. A missing file is silently ignored and defaults are used. A malformed or invalid file emits a warning and defaults are used. To apply config changes, reload the extension.

### Schema

```json
{
  "staleTurns": 4,
  "minTokens": 256,
  "supersededReadsEnabled": true,
  "duplicateReadsEnabled": true,
  "adaptivePolicyEnabled": true,
  "afterConsumptionBashEnabled": true,
  "batchPruningEnabled": true,
  "emergencyContextReserveTokens": 16000,
  "emergencyOrdinaryReadMinSavedTokens": 4000,
  "emergencyMaxOrdinaryReads": 2,
  "batchCooldownTurns": 2,
  "batchMinCandidates": 2,
  "batchMinSavedTokens": 8000,
  "batchMinNetValue": 3000,
  "batchMaxCandidates": 8,
  "batchMaxSemanticRisk": 3.0
}
```

All keys are optional. Any key omitted falls back to the default shown above.

| Key                             | Type         | Default | Description                                                                                     |
| ------------------------------- | ------------ | ------- | ----------------------------------------------------------------------------------------------- |
| `staleTurns`                    | number (≥ 0) | `4`     | Minimum user turns before a result is eligible for standard elision (compatibility fallback)    |
| `minTokens`                     | number (≥ 0) | `256`   | Minimum estimated tokens before a result is eligible for standard elision (compatibility floor) |
| `supersededReadsEnabled`        | boolean      | `true`  | Enable superseded-read young-or-batch rot detection                                             |
| `duplicateReadsEnabled`         | boolean      | `true`  | Enable duplicate-read young-or-batch rot detection                                              |
| `adaptivePolicyEnabled`         | boolean      | `true`  | Adjust per-reason profiles from cache/recall telemetry                                          |
| `afterConsumptionBashEnabled`   | boolean      | `true`  | Enable after-consumption bash compaction                                                        |
| `batchPruningEnabled`           | boolean      | `true`  | Enable batch old-history pruning for deferred candidates                                        |
| `emergencyContextReserveTokens` | number (≥ 0) | `16000` | Context window headroom below which emergency-pressure elision is triggered                     |
| `emergencyOrdinaryReadMinSavedTokens` | number (≥ 0) | `4000` | Minimum saved tokens for a young, consumed ordinary `read` to be eligible for emergency elision |
| `emergencyMaxOrdinaryReads`     | number (≥ 0) | `2`     | Maximum number of young ordinary reads that may be elided per emergency pass                  |
| `batchCooldownTurns`            | number (≥ 0) | `2`     | Minimum turns between non-emergency batch pruning passes                                        |
| `batchMinCandidates`            | number (≥ 1) | `2`     | Minimum number of deferred candidates required to run a batch pass                              |
| `batchMinSavedTokens`           | number (≥ 0) | `8000`  | Minimum aggregate saved tokens for a non-emergency batch pass                                   |
| `batchMinNetValue`              | number       | `3000`  | Minimum aggregate net value (benefit minus damage and risk) for a non-emergency batch pass      |
| `batchMaxCandidates`            | number (≥ 1) | `8`     | Maximum number of candidates selected per batch pass                                            |
| `batchMaxSemanticRisk`          | number (≥ 0) | `3.0`   | Maximum total semantic risk allowed for a non-emergency batch pass                              |

## `context_recall` tool

The LLM calls `context_recall` to retrieve an elided result. Parameters:

- `id` (required) — the `toolCallId` from the stub
- `lines` (optional) — a 1-indexed line range such as `"10-20"` or `"5"` to fetch only part of the content; only supported for single-text-block results with no image blocks

The tool description mentions that stubs come in several forms (standard, superseded, duplicate, after-consumption, batch-pressure, emergency-pressure) but the recall contract is identical for all of them while the original tool-result message remains in the active session store.

## `/context-prune` command

Run `/context-prune` in the Pi chat to see elision statistics and adaptive diagnostics for the current session:

```
tokens elided (cumulative): 52K tokens
entries elided (latest pass): 4
context_recall invocations: 3
recent cache hit: 78.0%
context usage: 94,000 / 1,000,000 tokens (9.4%)

by reason:
  after-consumption-bash   21K tokens (5 entries, 0 recalls)
  batch-pressure           18K tokens (3 entries, 1 recall)

by tool:
  bash   24K tokens (6 entries, 0 recalls)
  read   20K tokens (3 entries, 2 recalls)

policy:
  after-consumption-bash   aggressiveness 0.62
  superseded-read-young    aggressiveness 0.34
```

- **tokens elided (cumulative)** — total estimated tokens elided across the session, deduplicated by `toolCallId`
- **entries elided (latest pass)** — how many tool results were replaced with stubs on the most recent context event
- **context_recall invocations** — how many times the LLM has called `context_recall` this session
- **recent cache hit** — rolling cache-hit rate for the current provider/model from assistant usage telemetry
- **context usage** — current token usage and context window size when available
- **by reason** — token count, entry count, and recall count broken down per elision reason
- **by tool** — token count, entry count, and recall count broken down per tool name, sorted descending by tokens
- **policy** — current adaptive aggressiveness value per reason (only shown when adaptive policy is enabled and enough telemetry has been collected)

## Cache-stability invariant

The elision pass is deterministic: given identical input messages and identical pruning state the output is always identical, which means Pi's prompt cache stays warm for unchanged prefixes. The pass reads only the message list and pruning state — no random values, wall-clock time, or external I/O.

Retroactive elision (rot rules and batch rules) is a deliberate cache trade-off: when a new edit, duplicate read, or batch selection triggers stubbing of an earlier result, the prefix cache is invalidated up to that result's position. The policy limits this damage with suffix budgets, cooldowns, and cache-hit feedback.
