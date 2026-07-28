# Context and Handoff

Long coding sessions accumulate two different kinds of weight: tool output that is no longer worth carrying verbatim, and history that belongs to a model you are about to leave. Pipkin handles both without pretending the work never happened.

## Context: deterministic pruning with recall

Context shows a tool result in full when it is first produced. On a later model request it may replace stale, superseded, repeated, covered, or already-consumed low-risk bash output with a reasoned stub. The original session entry is never changed.

Pruning happens in deterministic branch-local epochs. Context evaluates every eligible unlatched result, chooses at most one earliest qualifying suffix, persists its complete decisions, and only then changes the outgoing message copies. Existing epoch decisions replay after reload, resume, fork, and compaction while their source calls remain in active context. Every stub is stable and includes its source ID:

```text
[read result elided: covered by a later read of PATH at user entry 8. Call context_recall("TOOL_CALL_ID") to retrieve.]
```

A successful result can qualify because it is stale after four later user entries and large enough, because a later edit or write supersedes a read, because a later read returns the same or covering lines without an intervening mutation, or because a later assistant consumed low-risk bash output. Read comparisons use Pi's returned-line truncation details, not requested bounds.

Epochs prefer a matching fresh model transition with at least 8k savings, then a qualified warm-cache opportunity with at least 32k savings after eight user entries, then a small changed tail. Context does not measure pressure, invoke compaction, alter Pi's compaction settings, or make a compaction decision. Native Pi compaction remains the sole owner of context-window pressure.

### Recall exactly what you need

Pass the ID printed in a stub:

```json
{ "id": "TOOL_CALL_ID" }
```

The full call returns the original stored content blocks unchanged. For one-text-block results, request a positive 1-indexed line or range:

```json
{ "id": "TOOL_CALL_ID", "lines": "40-80" }
```

Missing IDs, invalid ranges, non-text or multi-block slices, unavailable content, and empty slices are real tool failures. Recall does not alter the original pruning decision.

## Handoff: switch models without dragging the whole transcript

A model switch can make the next request unexpectedly expensive and leave the new model reading a long conversation optimized for the old one. Handoff makes that cost visible, then lets the previous model summarize its own work.

After a meaningful TUI model switch, Pipkin shows a non-blocking estimate:

```text
Switched to Model · 200k context (~$0.12) · /handoff (~6k)
```

The notice can include:

- current context tokens;
- estimated next-message input cost on the selected model;
- estimated context size after compaction.

Cost is omitted for subscription or OAuth usage where token pricing is not applicable. Restore events, same-model changes, empty history, and non-TUI switches stay quiet.

### Use `/handoff`

After switching models, run:

```text
/handoff
```

Pipkin finds the last assistant model. If it differs from the selected model, that previous model produces a continuation-focused summary through Pi's native compaction path. The new model remains selected.

The summary is instructed to preserve goals, decisions, file paths, symbols, blockers, unresolved questions, and remaining work. Pi still owns cut-point selection, retained recent context, cancellation, progress, and queued input.

Handoff is explicit. It does not automatically compact at a pressure threshold, replay prompts, rewrite session files, or implement a separate input queue.
