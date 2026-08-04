# Context

Long coding sessions accumulate tool output that is no longer worth carrying verbatim. Pipkin prunes it without pretending the work never happened.

## Deterministic pruning with recall

Context shows a tool result in full when it is first produced. On a later model request it may replace stale, superseded, repeated, covered, or already-consumed low-risk bash output with a reasoned stub. The original session entry is never changed.

Pruning happens in deterministic branch-local epochs. Context evaluates every eligible unlatched result, chooses at most one earliest qualifying suffix, persists its complete decisions, and only then changes the outgoing message copies. Existing epoch decisions replay after reload, resume, fork, and compaction while their source calls remain in active context. Every stub is stable and includes its source ID:

```text
[read result elided: covered by a later read of PATH at user entry 8. Call context_recall("TOOL_CALL_ID") to retrieve.]
```

A successful result can qualify because it is stale after four later user entries and large enough, because a later edit or write supersedes a read, because a later read returns the same or covering lines without an intervening mutation, or because a later assistant consumed low-risk bash output. Read comparisons use Pi's returned-line truncation details, not requested bounds.

Epochs prefer a known-cold opportunity with at least 8k savings, then a qualified warm-cache opportunity with at least 32k savings after eight user entries, then a small changed tail. A known-cold opportunity is the first model request after either a real model transition or Pi compaction, before the current model has produced another assistant entry. Context does not measure pressure, invoke compaction, alter Pi's compaction settings, or make a compaction decision. Native Pi compaction remains the sole owner of context-window pressure.

### Durable pruning milestones

Every persisted pruning epoch, including tail epochs, appears in the transcript as a quiet Context-owned milestone. Its collapsed line reports the epoch kind, result count, and approximate pruned tokens, for example:

```text
context · pruned 6 results (~18k tokens) · warm
```

Expanding the entry uses Pi's ordinary transcript expansion state to show its bounded pruning-reason breakdown with result counts and approximate savings. These are custom session entries, not messages: they remain outside model context. Older v1 epochs without per-decision savings stay replayable and render their count and kind without inventing a token total.

New epoch decisions persist their estimated token savings alongside the reason and stable stub. The estimate is the same calculation Context used to select the epoch, including for tail decisions.

### Recall exactly what you need

Pass the tool-call ID returned by a recallable outcome or printed in a pruning stub:

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

## Managed process outcomes

`get_process_result` and `stop_process` default to bounded visible output. For a successful snapshot, readiness wait, timeout, cancellation-finalization, terminal join, or stop where only status matters, pass `resultMode:"outcome"`. It returns a concise status and exact `context_recall` instruction while retaining the same bounded point-in-time process result. Full recall, a line range, and literal search work after compaction or record eviction, but cannot recover newer or dropped output. Use a later output-mode call for newer live output; failed process output remains visible instead of being hidden as an outcome.

For example, start overlapping finite work, continue independent work, then call `get_process_result` once with `wait:true, resultMode:"outcome"`. A server can instead wait once with `untilContains:"ready"`; inspect targeted later output with `find:"error"`, or stop it explicitly when no longer needed.

## Bash outcomes

Choose `bash_outcome` for an action or validation when exit status alone answers the current question, especially when successful output may be noisy and regardless of the command's finite duration. Choose ordinary `bash` for inspection, discovery, diagnostics, or when successful output informs reasoning or reporting, such as search results, diffs, listings, warnings, skipped tests, or test counts.

`bash_outcome` shares Sandbox's ordinary Bash execution. While it runs, the collapsed tool row stays compact and expansion reveals accumulated output. Failures remain visible, including for chained commands. On success with output it returns a concise status while retaining the same ordinary bounded Bash result for immediate `context_recall`; inspect that execution through recall instead of rerunning solely to recover its output. A successful command with no output returns concise status without recall guidance, although its uniform retained envelope remains available internally. An optional display-only label is control-safe normalized, whitespace-collapsed, and must be 1–80 Unicode code points; it never changes the command.
