# Context

Long coding sessions accumulate tool output that is no longer worth carrying verbatim. Pipkin prunes it without pretending the work never happened.

## Deterministic pruning with recall

Context shows a tool result in full when it is first produced. On a later model request it may replace stale, superseded, repeated, covered, or already-consumed low-risk bash output with a reasoned stub. The original session entry is never changed.

Pruning happens in deterministic branch-local epochs. Context evaluates every eligible unlatched result, chooses at most one earliest qualifying suffix, persists its complete decisions, and only then changes the outgoing message copies. Existing epoch decisions replay after reload, resume, fork, and compaction while their source calls remain in active context. Every stub is stable and includes its source ID:

```text
[read result elided: covered by a later read of PATH at user entry 8. Call context_recall("TOOL_CALL_ID") to retrieve.]
```

A successful result can qualify because it is stale after four later user entries and large enough, because a later edit or write supersedes a read, because a later read returns the same or covering lines without an intervening mutation, or because a later assistant consumed low-risk bash output. Read comparisons use Pi's returned-line truncation details, not requested bounds.

Epochs prefer a matching fresh model transition with at least 8k savings, then a qualified warm-cache opportunity with at least 32k savings after eight user entries, then a small changed tail. Context does not measure pressure, invoke compaction, alter Pi's compaction settings, or make a compaction decision. Native Pi compaction remains the sole owner of context-window pressure.

### Durable pruning milestones

Every persisted pruning epoch, including tail epochs, appears in the transcript as a quiet Context-owned milestone. Its collapsed line reports the epoch kind, result count, and approximate pruned tokens, for example:

```text
context · pruned 6 results (~18k tokens) · warm
```

Expanding the entry uses Pi's ordinary transcript expansion state to show its bounded pruning-reason breakdown with result counts and approximate savings. These are custom session entries, not messages: they remain outside model context. Older v1 epochs without per-decision savings stay replayable and render their count and kind without inventing a token total.

New epoch decisions persist their estimated token savings alongside the reason and stable stub. The estimate is the same calculation Context used to select the epoch, including for tail decisions.

### Recall exactly what you need

Pass the ID printed in a stub:

```json
{ "id": "TOOL_CALL_ID" }
```

The full call returns the original stored content blocks unchanged. For one-text-block results, request a positive 1-indexed line or range:

```json
{ "id": "TOOL_CALL_ID", "lines": "40-80" }
```

Or search one text result with a non-empty case-insensitive literal. Search returns up to ten source-ordered matches with three surrounding lines, preserving the original numbered source text:

```json
{ "id": "TOOL_CALL_ID", "find": "AssertionError" }
```

`lines` and `find` cannot be combined. Missing IDs, invalid ranges, empty literals, non-text or multi-block slices/searches, unavailable content, and empty slices are real tool failures. A search with no matches succeeds and says so. Search output is bounded; narrow the literal when it reports omitted matches or truncation.

Recall also keeps a bounded source label for terminal presentation, such as the originating tool or Bash command. That label is metadata only: it is never prepended to or substituted for the recalled model content. Recall does not alter the original pruning decision.

## Bash outcomes

Choose `bash_outcome` when the next reasoning step only needs to know whether Bash succeeded, regardless of the command's finite duration. It shares Sandbox's ordinary Bash execution and leaves failures visible normally. On success it returns a concise status while retaining the same ordinary bounded Bash result for `context_recall`; choose ordinary `bash` when successful output may affect the next decision. An optional display-only label is control-safe normalized, whitespace-collapsed, and must be 1–80 Unicode code points; it never changes the command.
