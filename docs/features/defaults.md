# pi-defaults

Keep Pi's persisted model and thinking defaults stable across sessions.

pi-defaults treats `settings.json` as the source of truth for `defaultModel`, `defaultProvider`, and `defaultThinkingLevel`. It does not introduce a second config file. To change the defaults that should apply to future sessions, edit `settings.json` directly.

## Behavior

- `settings.json` remains authoritative for persisted defaults.
- Changing the model or thinking level inside a session intentionally does not update the persisted defaults.
- Starting Pi with `pi --model ...` affects that launched session only and intentionally does not change the persisted defaults.

## License

MIT
