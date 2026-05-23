# pi-ctx

A Pi extension that keeps the context window small by pruning large, stale tool results and letting the LLM fetch them back on demand.

## What it does

On every context event pi-ctx scans all `toolResult` messages. Results that meet the staleness and size thresholds are replaced in-context with a one-line stub. Files that have been superseded by a later edit or written more than once are stubbed immediately, regardless of age or size. The original content is never discarded — it remains in the session store and can be retrieved at any time via `ctx_recall`.

Error results (`isError: true`) are never elided by the standard rule, only by the rot rules (superseded/duplicate), so the LLM always has access to failures.

## Stub formats

### Standard elision stub

Emitted when a result is old enough and large enough (both thresholds met):

```
[ToolName result elided: SIZE. Preview: "PREVIEW". Call ctx_recall("TOOL_CALL_ID") to retrieve.]
```

### Superseded-read stub

Emitted when a `read` result is later overwritten by an `edit` or `write` in the same pass, regardless of age or size:

```
[read result elided (superseded by later edit/write of PATH): SIZE. Preview: "PREVIEW". Call ctx_recall("TOOL_CALL_ID") to retrieve original.]
```

### Duplicate-read stub

Emitted when the same file is read more than once with the same `offset`/`limit` in the same pass. All reads except the most recent are stubbed, regardless of age or size. The stub references `turn`, the 1-indexed user-turn number during which the kept read occurred (counting user messages up to and including that message's position):

```
[read result elided (superseded by later read of PATH at turn TURN): SIZE. Preview: "PREVIEW". Call ctx_recall("TOOL_CALL_ID") to retrieve.]
```

When both the superseded and duplicate rules match the same result, the superseded stub takes precedence.

### Preview segment

All stubs include a `Preview: "..."` segment showing the first 100 characters of the text content, with `\`, `"`, `\n`, and `\t` escaped. When the source exceeds 100 characters, the preview ends with `…` inside the closing quote. The preview segment is omitted only when the result contains no text blocks (e.g. image-only results).

`TOOL_CALL_ID` is the `toolCallId` of the original tool call. `SIZE` is the estimated token count formatted as a human-readable string (e.g. `310 tokens`, `1.2K tokens`, `34K tokens`). Token count is estimated using the same `ceil(chars / 4)` heuristic that Pi uses internally. Image blocks are excluded from this count — elision eligibility is based on text payload only.

## Thresholds

| Config key   | Default | Effect of increasing                         | Effect of decreasing                                       |
| ------------ | ------- | -------------------------------------------- | ---------------------------------------------------------- |
| `staleTurns` | `4`     | Elide results later (more context kept live) | Elide results sooner (smaller context, more recall needed) |
| `minTokens`  | `256`   | Only elide larger results                    | Elide even small results                                   |

Both thresholds must be met simultaneously for a result to be elided by the standard rule.

**Rot rules bypass thresholds.** Superseded-read and duplicate-read detection stub results immediately, without checking `staleTurns` or `minTokens`. The pass remains fully deterministic — no wall-clock time, random values, or external I/O is used.

Note: image blocks within a tool result do not count toward `minTokens`. Elision eligibility is based on text payload only.

## Config file

pi-ctx reads optional configuration from:

```
~/.pi/agent/extensions/pi-ctx/config.json
```

The file is loaded once at session start. A missing file is silently ignored and defaults are used. A malformed or invalid file emits a warning and defaults are used. To apply config changes, reload the extension.

### Schema

```json
{
  "staleTurns": 4,
  "minTokens": 256,
  "supersededReadsEnabled": true,
  "duplicateReadsEnabled": true
}
```

All keys are optional. Any key omitted falls back to the default shown above.

| Key                      | Type         | Default | Description                                                                                    |
| ------------------------ | ------------ | ------- | ---------------------------------------------------------------------------------------------- |
| `staleTurns`             | number (≥ 0) | `4`     | Minimum user turns in the past before a result is eligible for standard elision                |
| `minTokens`              | number (≥ 0) | `256`   | Minimum estimated token count before a result is eligible for standard elision                 |
| `supersededReadsEnabled` | boolean      | `true`  | Stub read results that were later overwritten in the same pass                                 |
| `duplicateReadsEnabled`  | boolean      | `true`  | Stub all but the most recent read of the same file (at the same offset/limit) in the same pass |

## `ctx_recall` tool

The LLM calls `ctx_recall` to retrieve an elided result. Parameters:

- `id` (required) — the `toolCallId` from the stub
- `lines` (optional) — a 1-indexed line range such as `"10-20"` or `"5"` to fetch only part of the content; only supported for single-text-block results with no image blocks

## `/ctx` command

Run `/ctx` in the Pi chat to see elision statistics for the current session:

```
tokens elided (cumulative): 8.5K tokens
entries elided (latest pass): 3
ctx_recall invocations: 1

by tool:
  read   7K tokens  (2 entries, 1 recall)
  bash   1.5K tokens   (1 entry, 0 recalls)
```

- **tokens elided (cumulative)** — total estimated tokens elided across the session, deduplicated by `toolCallId`
- **entries elided (latest pass)** — how many tool results were replaced with stubs on the most recent context event
- **ctx_recall invocations** — how many times the LLM has called `ctx_recall` this session
- **by tool** — token count, entry count, and recall count broken down per tool name, sorted descending by tokens

## Cache-stability invariant

The elision pass is fully deterministic: given identical input messages the output is always identical, which means Pi's prompt cache stays warm for unchanged prefixes. The pass reads only the message list — no random values, wall-clock time, or external I/O.

Note that retroactive elision (rot rules) is by design a cache trade-off: when a new edit or duplicate read triggers stubbing of an earlier result, the prefix cache is invalidated up to that result's position. This is intentional — the context saving is worth the one-time cache miss.
