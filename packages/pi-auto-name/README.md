# pi-auto-name

Automatically generate a short session name from the first user prompt.

When a new interactive coding session starts from a first user prompt, pi-auto-name generates a concise title using a configured model and sets Pi's canonical session name. Native Pi surfaces—`/resume`, the terminal title, and window title—pick it up automatically.

## Usage

Automatic naming happens on the first non-empty agent prompt in an unnamed session. Generation runs asynchronously so the main agent turn is never delayed.

No model is configured by default. Until you configure one, pi-auto-name warns once per session and skips naming.

Set the model with the slash command:

```text
/auto-name openrouter/openai/gpt-oss-20b
```

Model refs use `provider/model-id` format and are persisted to the global user config at `<agent-dir>/extensions/pi-auto-name/config.json`.

You can also edit the config file directly:

```json
{
  "model": "openrouter/openai/gpt-oss-20b"
}
```

## Behavior

- Never overwrites an existing or manually set session name.
- Skips cleanly if no model is configured, or if the configured model is missing, unauthenticated, errors, or returns invalid output.
- Warns once per session until a model is configured, and at most once per session for other configuration or auth problems.
- Generated titles are sanitized: trimmed, collapsed, stripped of surrounding quotes/backticks and leading `Title:` / `Name:` style prefixes, truncated to 40 characters on a word boundary, and taken from the first non-empty output line only.

## License

MIT
