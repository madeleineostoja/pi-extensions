# pi-auto-name

Automatically generate a short session name from the first user prompt.

When a new interactive coding session starts from a first user prompt, pi-auto-name generates a concise title using a configured model and sets Pi's canonical session name. Native Pi surfaces—`/resume`, the terminal title, and window title—pick it up automatically.

## Usage

Automatic naming happens on the first non-empty agent prompt in an unnamed session. Generation runs asynchronously so the main agent turn is never delayed.

No model is configured by default. Without a configured model, pi-auto-name falls back to a local title derived from the prompt.

Set the model with the slash command:

```text
/auto-name openai/gpt-4.1-nano
```

Model refs use `provider/model-id` format and are persisted to the global user config at `<agent-dir>/extensions/pi-auto-name/config.json`. For best latency and cost, choose a cheap non-reasoning model when available.

You can also edit the config file directly:

```json
{
  "model": "openai/gpt-4.1-nano"
}
```

## Behavior

- Never overwrites an existing or manually set session name.
- Uses only the configured model; there is no built-in default model.
- Requests minimal reasoning to support providers that require an explicit reasoning level.
- Falls back to a local prompt-derived title when no model is configured or the model returns no usable title.
- Generated titles are sanitized: trimmed, collapsed, stripped of surrounding quotes/backticks and leading `Title:` / `Name:` style prefixes, truncated to 40 characters on a word boundary, and taken from the first non-empty output line only.

## License

MIT
