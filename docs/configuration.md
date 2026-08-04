# Configuration and state

Pipkin keeps global preferences in one agent-level file and checkout-specific policy or state beside the checkout that owns it. Model credentials remain Pi's responsibility and never belong in Pipkin configuration.

## Quick setup

Create:

```text
<getAgentDir()>/pipkin/config.json
```

With Pi's default agent directory, that is `~/.pi/agent/pipkin/config.json`. Pipkin uses Pi's `getAgentDir()`, so custom agent directories work without path rewriting.

```json
{
  "nickname": "Mads",
  "models": {
    "utility": { "model": "provider/fast-model", "thinking": "minimal" },
    "low": { "model": "provider/low-cost-model", "thinking": "low" },
    "medium": { "model": "provider/coding-model", "thinking": "medium" },
    "high": { "model": "provider/reasoning-model", "thinking": "high" }
  },
  "implement": {
    "workerConcurrency": 3
  }
}
```

Only `models` is needed to unlock the complete model-powered feature set. `implement` and `nickname` are optional.

## Nickname

`nickname` is an optional 1–40 character display name. Pipkin trims and collapses its whitespace, rejects empty values and control characters, and uses it only in Personality's deterministic greeting for fresh TUI startup and `/new` sessions.

## Model presets

Pipkin routes work by role rather than hard-coding a provider. Each preset needs a non-empty `provider/model` reference and a Pi-supported thinking level: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`.

| Preset    | Used by                                                 |
| --------- | ------------------------------------------------------- |
| `utility` | Asynchronous session naming                             |
| `low`     | Explore agents, including nested exploration            |
| `medium`  | Implement and revision workers                          |
| `high`    | Review agents, Implement planning, and Implement review |

General agents inherit the active parent model and thinking level. BTW uses the model associated with the current conversation flow. Explicit `Agent` tool arguments override a public agent's model or thinking for that invocation only; they are not saved.

All four preset keys must be present and no unknown preset keys are accepted. Pipkin does not silently switch provider when a preset is missing or malformed. The presets may all reference one model if tiered routing is not useful for your setup.

Pi still owns model credentials and its `settings.json`. Keep API keys out of this file.

## Reference credentials

Reference optionally reads `<getAgentDir()>/pipkin/auth.json`, separate from `config.json`. Its bounded JSON object recognizes only optional non-empty string fields named `context7` and `github`; unrelated keys are ignored. Use `context7` for Context7 and a dedicated least-privilege `github` token. The token's repository access defines the scope of `code_search`, including private or internal source when permitted; `package_search` explicitly requests public repositories. Reference never reads GitHub CLI, repository, npm, or environment credentials.

Do not place real credentials in documentation, repository files, or tool inputs.

## Implement settings

```json
{
  "implement": {
    "workerConcurrency": 3
  }
}
```

`workerConcurrency` controls how many independent Implement workstreams may run concurrently. It defaults to `3`, must be a positive integer, and is capped at `8`. Publication to the target remains serialized regardless of this value.

See [Implementation](features/implementation.md).

## When changes take effect

Configuration is snapshotted when the consuming extension is constructed. Pi's `/reload` rebuilds the bundle and rereads the central file.

## Durable state

Pipkin's checkout-owned state lives under `.pi/pipkin/`:

```text
<checkout>/.pi/pipkin/
  implement/
    checkout.lock
    checkout.owner.json
    runs/<run-id>/
      execution-plan.json
      run-state.json
      artifacts/
  papercuts.json
  papercuts.lock
```

Implement arranges checkout-specific state and Papercuts uses the canonical primary worktree's shared registry. Both arrange local Git exclusion through the repository's common `.git/info/exclude`; they do not modify committed `.gitignore`. Linked worktrees retain Implement state while sharing Papercut findings.

## No legacy migration

Current paths are a hard cutover. Pipkin does not read, copy, migrate, or diagnose old `extensions/pi-*` configuration, root `.pi/implement`, `.pi/papercuts.json`, or `.pi/papercuts.lock`. Existing files at those locations remain available for manual inspection only.
