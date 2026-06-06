# pi-usage

Pi extension that shows compact subscription usage in the Pi footer for supported providers (ChatGPT Codex, Opencode Go), and replaces limit-error messages with a human-readable summary.

## What it does

- Displays a compact usage status in the Pi footer (e.g. `󰍛 42% (71%)`) whenever a supported provider model is selected
- Automatically refreshes the usage snapshot on a timer after the TTL expires
- Detects rate-limit errors in assistant messages (`message_end`) and replaces the raw JSON blob with a readable `🚫 usage limit reached` message that includes the latest usage figures
- Clears the status and cancels the refresh timer when the session ends or a non-supported model is selected
- **`/usage`** — returns the current usage percentage and reset time (or how long until reset)

## What it intentionally does NOT do

- **No `setFooter`** — uses `setStatus` only (single status key `pi-usage`)
- **No CLI fallback auth** — only Pi OAuth auth via `ctx.modelRegistry.getApiKeyAndHeaders`
- **No `~/.pi/agent/auth.json`** reads
- **No `additional_rate_limits`** — only `rate_limit.primary_window` (5h) and `rate_limit.secondary_window` (weekly) are surfaced
- **No credits, plan, pace, or progress bars** — percentage figures only
- **No unsupported providers** — silently clears the status when an unsupported model is active
- **No config or settings** — no user-configurable options

## Limit-error detection

The limit-error detector is intentionally **heuristic** and uses a **conservative false-negative-preferred approach**: it requires both a limit indicator (`limit`, `quota`, `rate_limit`, `too many requests`, `429`) _and_ a provider indicator (`codex`, `chatgpt`, `openai`, `wham`) to be present before replacing the message. Ambiguous or incomplete errors are left untouched.

## Auth

Only Pi OAuth authentication is supported for Codex. The extension reads the bearer token via `ctx.modelRegistry.getApiKeyAndHeaders` and decodes the JWT to extract the `chatgpt_account_id` claim for the `chatgpt-account-id` request header when present.
