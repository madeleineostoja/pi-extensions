# Context and Handoff

Long coding sessions accumulate two different kinds of weight: tool output that is no longer worth carrying verbatim, and history that belongs to a model you are about to leave. Pipkin handles both without pretending the work never happened.

## Context: compact tool output without throwing it away

Context runs before each model call and replaces eligible tool results with short, reasoned stubs. The original result remains in Pi's active session store and can be recovered with `context_recall` while that message is retained.

A stub tells you what happened, shows a compact preview, and includes the exact tool-call ID:

```text
[read result elided (superseded by later edit/write of PATH): SIZE.
Preview: "…". Call context_recall("TOOL_CALL_ID") to retrieve original.]
```

### What it recognizes

| Reason             | Typical case                                                                            |
| ------------------ | --------------------------------------------------------------------------------------- |
| Stale or large     | An older result is beyond the ordinary age and size thresholds                          |
| Superseded read    | A later edit or write made the earlier file snapshot obsolete                           |
| Duplicate read     | The same content was read again later                                                   |
| Covered read       | A later read contains the earlier range                                                 |
| Consumed bash      | A successful, low-risk command result has already informed an assistant response        |
| Batch pressure     | Several older results are collectively worth compacting despite prompt-cache trade-offs |
| Emergency pressure | The context window needs a bounded reserve restored                                     |

More specific reasons win when several rules apply. Decisions latch by retained `toolCallId`, so repeated context passes do not keep changing the same stub and destabilizing the prompt prefix.

Ordinary stale and batch selection exclude tool errors. Images are not counted toward ordinary token eligibility. Retroactive read and batch pruning can invalidate a cached suffix, so the adaptive policy uses cache telemetry, cooldowns, semantic-risk limits, and minimum net savings before doing it.

### Recall exactly what you need

Pass the ID printed in the stub:

```json
{ "id": "TOOL_CALL_ID" }
```

For a result containing one text block, request only a 1-indexed line or range:

```json
{ "id": "TOOL_CALL_ID", "lines": "40-80" }
```

Recall returns the retained original content unchanged. The recalled tool result stays visually compact in the interactive renderer so recovering one detail does not flood the terminal.

### See what Context is doing

Run `/context-prune` for cumulative and latest-pass statistics: estimated tokens reclaimed, recalls, reason and tool breakdowns, cache usage, batch decisions, emergency pressure, and adaptive-policy diagnostics. This turns pruning from invisible magic into something you can inspect and tune.

All settings are optional under `<agent-dir>/pipkin/config.json#context`. See [Configuration](../configuration.md#context-settings) for the complete defaults table.

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

The command makes no state change when there is no prior assistant model, the last assistant already used the selected model, the previous model is unavailable, or its authentication cannot be obtained.

Handoff is explicit. It does not automatically compact at a pressure threshold, replay prompts, rewrite session files, or implement a separate input queue.
