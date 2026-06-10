# pi-model-handoff

Pi extension that offers a low-noise context handoff when switching from a frontier model to a cheaper implementation model.

## How it works

When you switch models inside Pi, `pi-model-handoff` analyses whether sending the full conversation transcript to the new model would be wasteful. If the switch looks like a downshift and Pi would summarize more old context than it keeps live, the extension prompts you immediately after the switch:

```
Model handoff: source-model → target-model
- Full context: ~10k (~$0.0850)
- Estimated handoff context: ~3.2k (~$0.0272)
- Estimated savings: ~6.8k (~$0.0578)
Create handoff
Continue full context
```

Cost estimates are converted to NZD when the shared rate cache is available; they are omitted when no rate is cached.

- **Create handoff** — triggers Pi's manual compaction using the _previous_ model to write an implementation-focused summary, then resumes with the new model.
- **Continue full context** — leaves the conversation untouched and proceeds normally.

The extension reuses Pi's native compaction system. Pi continues to own cut-point selection, recent-context retention, progress display, cancellation, and queued-input behaviour.

## Heuristic

The extension only prompts when:

1. The model switch is interactive: TUI mode, not a restore, with a previous model and a different target model.
2. Pi has old context it can summarize.
3. The estimated context savings are at least 20%.
4. If target pricing is available, sending the full context to the target model would cost more than NZD $0.50. If NZD conversion is unavailable, the same numeric threshold is applied in USD.
5. If target pricing is unavailable for any reason, including OAuth/subscription models, the full context must exceed 50k tokens.

When a switch is skipped, the extension emits a short info message with the reason.

## Limitations

- The handoff runs immediately after the model switch, not on the next user prompt.
- No automatic handoff based on context-window pressure; this is about cost/noise after model switching.
- No custom session rewriting, prompt replay, or input queue implementation.
- Subscription/OAuth model costs remain excluded from the prompt.

## License

MIT
