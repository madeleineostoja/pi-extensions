# Configuration and state

Pipkin keeps personal preferences under Pi's agent directory and checkout-owned policy or state beside the checkout that owns it. Pi remains responsible for model credentials.

## Quick setup

Create `<getAgentDir()>/pipkin/config.json`. With Pi's default agent directory, the path is `~/.pi/agent/pipkin/config.json`.

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

Only `models` is required for the complete model-powered feature set. `nickname` and `implement` are optional. Pipkin rejects unknown top-level keys.

Configuration is snapshotted when each consuming extension is constructed. Run Pi's `/reload` after changing it.

## Model presets

Each preset requires:

- a non-empty `provider/model` reference; and
- a Pi-supported thinking level: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`.

| Preset    | Roles                                                                     |
| --------- | ------------------------------------------------------------------------- |
| `utility` | Session and Implement-run naming                                          |
| `low`     | Explore agents, including nested exploration                              |
| `medium`  | Implement implementation, revision, reconciliation, and whole-plan repair |
| `high`    | Review agents and Implement planning and review                           |

All four preset keys must be present; unknown preset keys are rejected. Pipkin does not silently substitute another provider for a missing or malformed preset. All presets may reference the same model if tiered routing is unnecessary.

BTW uses the current conversation model. Explicit `model` or `thinking` arguments override a public `Agent` invocation only and are not saved.

Pi owns provider credentials and `settings.json`; keep API keys out of Pipkin configuration.

## Nickname

`nickname` is an optional display name used only in Personality's fresh-session greeting. Pipkin collapses whitespace and requires a non-empty, control-free value of at most 40 characters.

## Implement settings

| Setting                       | Default | Valid values                    | Effect                                                              |
| ----------------------------- | ------: | ------------------------------- | ------------------------------------------------------------------- |
| `implement.workerConcurrency` |     `3` | Positive integer, capped at `8` | Maximum independent Implement workstreams that may run concurrently |

Publication remains serialized regardless of worker concurrency. See [Implementation](features/implementation.md).

## Reference credentials

Reference optionally reads `<getAgentDir()>/pipkin/auth.json`, separate from `config.json`:

```json
{
  "context7": "…",
  "github": "…"
}
```

| Key        | Purpose                                                                                |
| ---------- | -------------------------------------------------------------------------------------- |
| `context7` | Context7 documentation requests                                                        |
| `github`   | GitHub code search; repository access determines searchable private or internal source |

Both values are optional non-empty strings. Unrelated keys are ignored. Use a dedicated least-privilege GitHub token. `package_search` always requests public repositories.

Reference does not read GitHub CLI, npm, repository, or environment credentials. Never place real credentials in documentation, repository files, or tool inputs. See [Reference](features/reference.md).

## Durable state

Checkout-owned state lives under `.pi/pipkin/`:

```text
<checkout>/.pi/pipkin/
  implement/
    checkout.lock
    checkout.owner.json
    runs/<run-id>/
      execution-plan.json
      source-corpus.json
      run-state.json
      artifacts/
    worktrees/<run-id>/
    trash/
  papercuts.json
  papercuts.lock
```

This tree shows the durable ownership layout; terminal cleanup may remove owned worktrees and trash entries.

Implement state belongs to each checkout. Papercuts resolves the canonical primary worktree so linked worktrees share one registry. Both arrange local exclusion through the repository's common `.git/info/exclude`; neither changes committed `.gitignore`.

## No legacy migration

Current paths are a hard cutover. Pipkin does not read, copy, migrate, or diagnose old `extensions/pi-*` configuration, root `.pi/implement`, `.pi/papercuts.json`, or `.pi/papercuts.lock`. Existing files at those paths remain available for manual inspection only.
