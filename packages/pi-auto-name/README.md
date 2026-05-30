# pi-auto-name

Automatically generate a short session name from the first user prompt.

When a new interactive coding session starts from a first user prompt, pi-auto-name generates a concise title using a lightweight model and sets Pi's canonical session name. Native Pi surfaces—`/resume`, the terminal title, and window title—pick it up automatically.

## Usage

Automatic naming happens on the first non-empty agent prompt in an unnamed session. Generation runs asynchronously so the main agent turn is never delayed.

The default naming model is `openrouter/openai/gpt-oss-20b`.
Model overrides can be stored in `<agent-dir>/extensions/pi-auto-name/config.json` and persist across restarts.

## Behavior

- Never overwrites an existing or manually set session name.
- Skips cleanly if the model is missing, unauthenticated, errors, or returns invalid output.
- At most one warning notification per session for configuration or auth problems.
- Generated titles are sanitized: trimmed, collapsed, stripped of surrounding quotes/backticks and leading `Title:` / `Name:` style prefixes, truncated to 40 characters on a word boundary, and taken from the first non-empty output line only.

## License

MIT
