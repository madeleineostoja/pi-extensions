# codex-usage

Pi extension that shows ChatGPT Codex subscription usage in the Pi footer while a Codex model is active, and makes Codex limit-hit output readable.

## What it does

- Displays Codex subscription usage (requests used / remaining) in the Pi footer when a Codex model is the active model.
- Formats limit-hit error output from Codex into a clear, human-readable message.

## What it does NOT do

- Slash commands
- Replacing or fully overriding the footer (augments only)
- Codex CLI fallback auth
- `additional_rate_limits` fields
- Credits or plan type display
- Non-Codex provider usage
- Persisting configuration to disk
