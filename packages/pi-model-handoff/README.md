# pi-model-handoff

Pi extension that shows an informational context-size notice when switching models and provides an explicit `/handoff` command to compact the already-incurred context for model-to-model continuation.

## How it works

When you switch models inside Pi, `pi-model-handoff` computes the current context size, the next-message input cost on the new model, and the estimated size after a handoff compaction. It then shows a single non-blocking notification:

```
Switched to Kimi K2.6 · 200k context (~$0.12) · /handoff (~6k)
```

- **200k** — current context tokens.
- **~$0.12** — NZD-converted next-message input cost on the new model (omitted for subscription/OAuth models when no rate is cached).
- **~6k** — estimated post-handoff context size.

If there is nothing to summarize, or the switch is a restore, same-model change, or outside TUI mode, the extension stays silent.

## `/handoff` command

After switching, you can run `/handoff` at any time to compact the conversation history. The command:

1. Reads the **last assistant message** in the transcript.
2. If that message was produced by a model different from the current one, uses that model to write a continuation-focused handoff summary (reusing Pi's native compaction system).
3. Leaves the current model selected.

If the last assistant message is from the current model, or there is no prior assistant message, or the previous model is no longer registered, `/handoff` fails with an error notification and makes no state change.

## Reusing Pi's compaction

The extension does not implement its own summarization. It reuses Pi's native compaction path with the same `HANDOFF_INSTRUCTIONS` prompt that preserves goals, decisions, file paths, symbols, blockers, open questions, and remaining work without assuming a fixed next-step plan. Pi continues to own cut-point selection, recent-context retention, progress display, cancellation, and queued-input behaviour.

## Limitations

- No automatic handoff based on context-window pressure.
- No custom session rewriting, prompt replay, or input queue implementation.
- Subscription/OAuth model costs are excluded from the notice when no rate is cached.

## License

MIT
