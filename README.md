<div align="center">
  <h1>Pipkin</h1>
  <img src="docs/pipkin.png" alt="Pipkin" width="256">
  <p><strong>A small companion for big Pi sessions</strong></p>
  <p>
    <a href="https://github.com/madeleineostoja/pipkin/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/madeleineostoja/pipkin/actions/workflows/ci.yml/badge.svg"></a>
    <img alt="Node.js 24+" src="https://img.shields.io/badge/Node.js-24%2B-339933?logo=nodedotjs&logoColor=white">
    <a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/license-MIT-blue.svg"></a>
  </p>
</div>

Pipkin is an extension bundle for the [Pi](https://pi.dev) coding-agent harness. It adds autonomous plan implementation, focused subagents, context pruning with recall, semantic code navigation, bounded reference and web retrieval, managed processes, and macOS repository-write containment.

## Getting started

Pipkin requires Node.js 24 or later and an existing Pi installation.

```sh
pi install git:github.com/madeleineostoja/pipkin
```

Configure the models Pipkin should use in `~/.pi/agent/pipkin/config.json`:

```json
{
  "nickname": "Mads",
  "models": {
    "utility": { "model": "provider/fast-model", "thinking": "minimal" },
    "low": { "model": "provider/low-cost-model", "thinking": "low" },
    "medium": { "model": "provider/coding-model", "thinking": "medium" },
    "high": { "model": "provider/reasoning-model", "thinking": "high" }
  }
}
```

All four model presets are required for the complete model-powered feature set. See [Configuration and state](docs/configuration.md) for validation, model routing, optional settings, credentials, and durable paths.

## Features

### Implement

Give Implement a Markdown plan and it owns the run from dependency-aware scheduling through reviewed publication:

```text
/implement docs/plan.md
```

**Plan → dependency graph → isolated parallel work → review and repair → protected publication**

Implement coordinates trusted workers in disposable Git worktrees, publishes through one serialized integration lane, and retains durable evidence for inspection and cleanup. The target branch moves only after hooks, candidate verification, and compare-and-swap checks succeed.

[Implementation guide →](docs/features/implementation.md)

### Safety and context

- **Sandbox** contains model Bash and direct `write`/`edit` calls on macOS. Inspection children can protect source and Git while retaining disposable dependency runtime writes; Linux remains instruction-only.
- **Readonly** independently asks for confirmation before resolved `edit` and `write` calls.
- **Context** prunes stale or superseded tool output while preserving original results for `context_recall`.
- **Processes** runs foreground non-interactive commands while the main agent continues independent work.

[Safety →](docs/features/safety.md) · [Context →](docs/features/context.md)

### Agents and research

- **Explore** maps unfamiliar code; **Review** independently assesses a concrete artifact. Both run through `Agent` and remain visible through `/agents`.
- **Reference** searches bounded library documentation, package ecosystems, and credential-visible GitHub source.
- **Web Fetch** retrieves readable content from direct public URLs without authentication or page JavaScript.
- **LSP** provides read-only definitions, references, symbols, types, hover information, and diagnostics for supported languages.

[Agents →](docs/features/agents.md) · [Reference →](docs/features/reference.md) · [Web Fetch →](docs/features/web-fetch.md) · [Workflow tools →](docs/features/workflow-tools.md)

### Session utilities

- **UI** presents compact session status and bounded live activity.
- **Personality** gives fresh sessions a contextual welcome and unnamed sessions useful titles.
- **Papercuts** records recurring incidental friction only after an agent exercises a workaround and completes or safely continues its actual task.
- **BTW** answers one ephemeral side question with the current model and session context; press `s` after completion to promote a useful exchange into the transcript and context.

[Interface and Personality →](docs/features/interface-and-personality.md) · [Workflow tools →](docs/features/workflow-tools.md)

## Human controls

### Slash commands

| Command               | Purpose                                                                   |
| --------------------- | ------------------------------------------------------------------------- |
| `/sandbox [on\|off]`  | Inspect or change Sandbox mode for the current session                    |
| `/readonly [on\|off]` | Inspect or change confirmation for `edit` and `write`                     |
| `/processes`          | Inspect and stop current-session managed processes                        |
| `/agents`             | Inspect activity/results, guide, or stop managed agents                   |
| `/implement …`        | Start, inspect, stop, restart, or clean Implement runs                    |
| `/papercuts`          | Browse and close recorded Papercut findings                               |
| `/btw <question>`     | Ask an ephemeral side question; press `s` to promote a completed exchange |

### Keyboard shortcut

| Shortcut | Purpose                                                    |
| -------- | ---------------------------------------------------------- |
| `Ctrl+R` | Toggle Readonly's `edit` and `write` confirmation workflow |

## Model tools

These tools are called by the agent rather than typed as slash commands.

| Tool                    | Purpose                                                                                |
| ----------------------- | -------------------------------------------------------------------------------------- |
| `bash_outcome`          | Run an action or validation when exit status alone is enough                           |
| `context_recall`        | Recover retained output or content hidden behind a pruning stub                        |
| `lsp`                   | Query definitions, types, implementations, references, symbols, hover, and diagnostics |
| `start_process`         | Start managed foreground work while independent work continues                         |
| `get_process_result`    | Join or intentionally inspect a managed process                                        |
| `stop_process`          | Stop managed work that is no longer needed                                             |
| `Agent`                 | Start an Explore or Review managed subagent and return its ID                          |
| `get_subagent_result`   | Join or inspect a managed subagent                                                     |
| `steer_subagent`        | Queue guidance for a running managed subagent                                          |
| `inspect_implement_run` | List or inspect durable Implement runs and artifact paths                              |
| `docs`                  | Retrieve bounded library documentation                                                 |
| `package_search`        | Search documentation, npm, and public GitHub package ecosystems                        |
| `code_search`           | Search bounded GitHub source visible to the configured credential                      |
| `web_fetch`             | Retrieve bounded readable content from one public URL                                  |
| `batch_web_fetch`       | Retrieve one to eight public URLs with fixed concurrency                               |
| `record_papercut`       | Record qualifying incidental friction after an exercised workaround                    |

## Important safety boundaries

Pipkin extensions run with the Pi process's permissions. Sandbox protects against ordinary accidental repository writes by trusted agents; it is not hostile-code isolation. It does not confine extension JavaScript, provider traffic, language servers, remote mutations, inherited credentials, or unrestricted networking. Linux has no kernel enforcement. Use a devcontainer, VM, remote sandbox, or equivalent external boundary for hostile or unattended work.

Public subagents share the invoking working tree. Implement intentionally changes Git state, but gives its managed workers owned disposable worktrees and retains publication control. Read the [Safety guide](docs/features/safety.md) before relying on these boundaries.

If `pi-smart-fetch` is separately installed, remove it before reloading Pipkin to avoid duplicate Web Fetch tool registrations.

## Documentation

- [Configuration and state](docs/configuration.md)
- [Safety](docs/features/safety.md)
- [Context](docs/features/context.md)
- [Agents](docs/features/agents.md)
- [Implementation](docs/features/implementation.md)
- [Reference](docs/features/reference.md)
- [Web Fetch](docs/features/web-fetch.md)
- [Interface and Personality](docs/features/interface-and-personality.md)
- [Workflow tools](docs/features/workflow-tools.md)
- [Architecture](docs/architecture.md)
- [Development](docs/development.md)

MIT [LICENSE](LICENSE).
