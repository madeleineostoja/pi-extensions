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
  "models": {
    "utility": { "model": "provider/fast-model", "thinking": "minimal" },
    "low": { "model": "provider/low-cost-model", "thinking": "low" },
    "medium": { "model": "provider/coding-model", "thinking": "medium" },
    "high": { "model": "provider/reasoning-model", "thinking": "high" }
  },
  "implement": {
    "workerConcurrency": 3
  },
  "sandbox": {}
}
```

Only `models` is needed to unlock the complete model-powered feature set. `implement` and `sandbox` are optional.

## Model presets

Pipkin routes work by role rather than hard-coding a provider. Each preset needs a non-empty `provider/model` reference and a Pi-supported thinking level: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`.

| Preset    | Used by                                                 |
| --------- | ------------------------------------------------------- |
| `utility` | Asynchronous session naming                             |
| `low`     | Explore agents, including nested exploration            |
| `medium`  | Implement workers and recovery agents                   |
| `high`    | Review agents, Implement planning, and Implement review |

General agents inherit the active parent model and thinking level. BTW uses the model associated with the current conversation flow. Explicit `Agent` tool arguments override a public agent's model or thinking for that invocation only; they are not saved.

All four preset keys must be present and no unknown preset keys are accepted. Pipkin does not silently switch provider when a preset is missing or malformed. The presets may all reference one model if tiered routing is not useful for your setup.

Pi still owns credentials and its `settings.json`. Keep API keys out of this file.

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

## Sandbox settings and project policy

The optional central `sandbox` object uses the same shape as project policy. Sandbox resolves policy in this order:

1. built-in defaults;
2. `<agent-dir>/pipkin/config.json#sandbox`;
3. `<cwd>/.pi/pipkin/sandbox.json`.

Later objects override earlier ones, and arrays replace rather than merge. This makes the central section useful for personal defaults and the checkout file useful for project-specific paths and hosts.

See [Safety](features/safety.md) for the complete policy shape, defaults, and interactive grant commands.

## When changes take effect

Configuration is snapshotted when the consuming extension is constructed. Pi's `/reload` rebuilds the bundle and rereads the central file. Sandbox also provides `/sandbox reload` to reread its central and project policy without a full extension reload.

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
  sandbox.json
```

Implement and Papercuts arrange local Git exclusion through the repository's common `.git/info/exclude`; they do not modify committed `.gitignore`. Linked worktrees retain checkout-specific run and papercut state.

Agent-level logs live under `<agent-dir>/pipkin/logs/`, including Sandbox audit output and the Caffeinate log.

## No legacy migration

Current paths are a hard cutover. Pipkin does not read, copy, migrate, or diagnose old `extensions/pi-*` configuration, root `.pi/sandbox.json`, `.pi/implement`, `.pi/papercuts.json`, or `.pi/papercuts.lock`. Existing files at those locations remain available for manual inspection only.
