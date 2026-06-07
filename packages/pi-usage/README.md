# pi-usage

Pi extension that shows compact subscription usage in the Pi footer for ChatGPT Codex and Opencode Go. It also rewrites raw Codex limit-error messages into a readable summary.

## Supported providers

- **Codex**: models whose provider is `openai-codex` or starts with `openai-codex-`. Credentials come from Pi via `ctx.modelRegistry.getApiKeyAndHeaders`.
- **Opencode Go**: models whose provider is `opencode`. Pi model availability enables the provider, but dashboard credentials are read from `~/.pi/agent/pi-usage.json`.

## Footer

When the current model is supported, the footer status uses the `pi-usage` key and renders:

```txt
󰍛 codex 42% (71%)
󰍛 opencode 42% (17%)
```

The first percentage is the primary/rolling window. The parenthesized percentage is the secondary/weekly window. Opencode monthly usage is intentionally omitted from the footer and shown only by `/usage`.

Unsupported models clear the status and cancel the refresh timer.

## Commands

- **`/usage`**: reports all currently available supported providers from Pi's model registry.
- **`/usage auth`**: prompts for Opencode Go dashboard credentials and writes them to `~/.pi/agent/pi-usage.json`.

Example `/usage` output:

```txt
Codex
5h: 42% used. Resets at 14:20 (2h 11m remaining).
Weekly: 71% used.

Opencode
Rolling: 12% used. Resets in 3h 40m.
Weekly: 18% used. Resets in 4d.
Monthly: 8% used. Resets in 21d.
```

If Opencode is available but credentials are missing or invalid, the footer and `/usage` entry tell you to run `/usage auth`.

## Opencode config

`/usage auth` stores:

```json
{
  "opencode": {
    "workspaceId": "wrk_...",
    "authCookie": "Fe26.2**..."
  }
}
```

The config file is written under `~/.pi/agent/pi-usage.json` with restricted permissions where supported. The extension does not read Opencode environment variables or alternate config paths.

Opencode usage is currently scraped from `https://opencode.ai/workspace/{workspaceId}/go` using the saved `auth` cookie. The fetch/parsing code is isolated so it can be replaced when the official usage API lands; the current proposed endpoint is tracked in https://github.com/anomalyco/opencode/pull/16513.

## Limit-error detection

Codex limit-error replacement is Codex-only. The detector is intentionally heuristic and false-negative-preferred: it requires both a limit indicator (`limit`, `quota`, `rate_limit`, `too many requests`, `429`) and a provider indicator (`codex`, `chatgpt`, `openai`, `wham`) before replacing a message.
