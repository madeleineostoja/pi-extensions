# pi-usage

Pi extension that shows compact subscription usage in the Pi footer for ChatGPT Codex and Opencode Go. It also rewrites raw Codex limit-error messages into a readable summary.

## Supported providers

- **Codex**: models whose provider is `openai-codex` or starts with `openai-codex-`. Credentials come from Pi via `ctx.modelRegistry.getApiKeyAndHeaders`.
- **Opencode Go**: models whose provider is `opencode-go` or `opencode`. Pi model availability enables the provider, but dashboard credentials are read from `~/.pi/agent/pi-usage.json`.

## Footer

When the current model is supported, the footer status uses the `pi-usage` key and renders:

```txt
󰍛 codex 42% (71%)
󰍛 opencode main 42% (17%)
```

The first percentage is the primary/rolling window. The parenthesized percentage is the secondary/weekly window. Opencode monthly usage is intentionally omitted from the footer and shown only by `/usage`.

Unsupported models clear the status and cancel the refresh timer.

## Commands

- **`/usage`**: reports all currently available supported providers from Pi's model registry. For Opencode, shows all configured accounts and marks the active one.
- **`/usage auth`**: prompts for Opencode Go account configuration and writes it to `~/.pi/agent/pi-usage.json`.

Example `/usage` output:

```txt
Codex
5h: 42% used. Resets at 14:20 (2h 11m remaining).
Weekly: 71% used. Resets in 4d.

Opencode

→ main (opencode-go)
  Rolling: 42% used. Resets in 2h.
  Weekly: 17% used. Resets in 4d.

  side (opencode-go-1)
  Rolling: 81% used. Resets in 55m.
  Weekly: 63% used. Resets in 2d.
```

If Opencode is available but credentials are missing or invalid, the footer and `/usage` entry tell you to run `/usage auth`.

## Opencode config

`/usage auth` stores account-scoped config:

```json
{
  "opencode": {
    "accounts": {
      "opencode-go": {
        "label": "main",
        "workspaceId": "wrk_...",
        "authCookie": "Fe26.2**..."
      },
      "opencode-go-1": {
        "label": "side",
        "workspaceId": "wrk_..."
      }
    }
  }
}
```

The config file is written under `~/.pi/agent/pi-usage.json` with restricted permissions where supported. The extension does not read Opencode environment variables or alternate config paths.

- **`authCookie`** is optional when `pi-multi-auth` is installed and provides the active credential.
- If `pi-multi-auth` is absent, `authCookie` is required for any account whose usage should be fetched.
- The footer shows usage for the active `pi-multi-auth` account when available; otherwise the first account with a cookie.
- `/usage` shows all configured accounts.

## pi-multi-auth integration

`pi-usage` optionally integrates with `pi-multi-auth` (MasuRii/pi-multi-auth) as a read-only peer:

- Reads the active `opencode-go` credential id from `multi-auth.json`.
- Reads the credential secret from `auth.json`.
- Uses the account-specific `workspaceId` from `pi-usage.json`.
- If the active multi-auth account lacks a workspace mapping, shows an actionable error.

No dependency on `pi-multi-auth` is declared; the integration works when the runtime files are present.

Opencode usage is currently scraped from `https://opencode.ai/workspace/{workspaceId}/go` using the saved `auth` cookie. The fetch/parsing code is isolated so it can be replaced when the official usage API lands; the current proposed endpoint is tracked in https://github.com/anomalyco/opencode/pull/16513.

## Limit-error detection

Codex limit-error replacement is Codex-only. The detector is intentionally heuristic and false-negative-preferred: it requires both a limit indicator (`limit`, `quota`, `rate_limit`, `too many requests`, `429`) and a provider indicator (`codex`, `chatgpt`, `openai`, `wham`) before replacing a message.
