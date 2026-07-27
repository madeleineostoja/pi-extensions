# Personality

Automatically generate a short session name from the first user prompt.

Personality uses the Pipkin `utility` model preset and sets Pi's canonical session name. Native Pi surfaces—`/resume`, the terminal title, and window title—pick it up automatically.

## Usage

Automatic naming happens on the first non-empty agent prompt in an unnamed session. Generation runs asynchronously so the main agent turn is never delayed.

Configure all Pipkin model presets in `<agent-dir>/pipkin/config.json`; Personality uses only `models.utility`:

```json
{
  "models": {
    "utility": { "model": "openai/gpt-4.1-nano", "thinking": "minimal" },
    "low": { "model": "provider/low", "thinking": "low" },
    "medium": { "model": "provider/medium", "thinking": "medium" },
    "high": { "model": "provider/high", "thinking": "high" }
  }
}
```

When Utility cannot run, Personality falls back to a local prompt-derived title.

## Behavior

- Never overwrites an existing or manually set session name.
- Uses only the Utility preset; there is no alternate model route.
- Uses the preset thinking level.
- Generated titles are sanitized: trimmed, collapsed, stripped of surrounding quotes/backticks and leading `Title:` / `Name:` style prefixes, truncated to 40 characters on a word boundary, and taken from the first non-empty output line only.

## License

MIT
