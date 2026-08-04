# Context

Long sessions accumulate tool output that is no longer useful verbatim. Context replaces eligible output with stable, reasoned stubs while preserving the original result for `context_recall`.

## Pruning behavior

A tool result appears in full when produced. On a later model request, Context may elide successful output that is:

- stale after later user entries;
- superseded by a later edit or write;
- duplicated or covered by a later read; or
- low-risk Bash output already consumed by the assistant.

The original session entry is never changed. Context evaluates deterministic branch-local epochs, persists complete decisions before changing outgoing copies, and replays those decisions after reload, resume, fork, and compaction while source calls remain in active context.

Each stub names the reason and source call:

```text
[read result elided: covered by a later read of PATH at user entry 8. Call context_recall("TOOL_CALL_ID") to retrieve.]
```

| Opportunity  | Selection rule                                                                                    |
| ------------ | ------------------------------------------------------------------------------------------------- |
| Known-cold   | First request after a real model transition or Pi compaction; at least 8k estimated token savings |
| Warm-cache   | After eight user entries; at least 32k savings                                                    |
| Changed tail | Small final fallback epoch                                                                        |

An ordinary stale result first needs four later user entries and enough size to matter. Context does not measure context pressure, trigger compaction, alter compaction settings, or decide when Pi compacts.

## Pruning milestones

Each persisted epoch appears as a quiet Context-owned transcript entry, for example:

```text
context · pruned 6 results (~18k tokens) · warm
```

Expanding it shows a bounded reason breakdown. These are custom session entries outside model context. Older epochs without per-decision savings remain replayable without an invented token total.

## Recall

Use the tool-call ID from an elision stub or recallable outcome.

| Request                                              | Effect                                                        |
| ---------------------------------------------------- | ------------------------------------------------------------- |
| `{ "id": "TOOL_CALL_ID" }`                           | Return the original stored content blocks                     |
| `{ "id": "TOOL_CALL_ID", "lines": "40-80" }`         | Return a positive 1-indexed line or range from one text block |
| `{ "id": "TOOL_CALL_ID", "find": "AssertionError" }` | Search one text block case-insensitively with bounded context |

`lines` and `find` are mutually exclusive. Search returns at most ten source-ordered matches with three surrounding lines and reports truncation or omitted matches. A search with no matches succeeds; missing content, invalid ranges, unsupported content shapes, and empty slices are errors.

Recall preserves a bounded source label for terminal presentation but does not add it to model content or alter pruning decisions.

## Bash outcomes

Choose `bash_outcome` for an action or validation when exit status alone answers the question. Choose ordinary Bash for discovery, diagnostics, listings, diffs, warnings, skipped tests, test counts, or any successful output needed for reasoning.

On successful output, `bash_outcome` returns concise status and retains the ordinary bounded result for immediate recall. Inspect that execution through `context_recall` rather than rerunning it solely to recover output. Success without output remains concise; failures remain directly visible. Its optional display label is normalized, control-safe, and limited to 80 Unicode code points.

`bash_outcome` uses Sandbox's ordinary Bash path and does not create another confinement boundary.

## Managed-process outcomes

`get_process_result` and `stop_process` default to bounded visible output. Choose `resultMode: "outcome"` when only point-in-time status matters; successful results return concise status and exact recall guidance. Failed process output remains visible.

Recall can recover that retained snapshot after compaction or process-record eviction, but it cannot recover output produced later or already dropped by retention. Request a later output-mode result for newer output. Tail and literal-search filters require output mode.
