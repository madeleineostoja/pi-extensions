# Pipkin

Personal [Pi](https://github.com/earendil-works/pi) agent harness.

## Features

| Feature                                         | Description                                                                                                                                 |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| [Sandbox](docs/features/sandbox.md)             | Limit file, subprocess, and network access with policy gates and `nono` sandboxing.                                                         |
| [Edit Approval](docs/features/edit-approval.md) | Ask before built-in `edit` and `write` tool calls apply changes.                                                                            |
| [Shell Guard](docs/features/shell-guard.md)     | Ask before running risky destructive shell commands.                                                                                        |
| [Context](docs/features/context.md)             | Compact stale or low-value tool results, with `context_recall` for on-demand retrieval.                                                     |
| [Defaults](docs/features/defaults.md)           | Keep `settings.json` model/provider and thinking defaults stable across sessions.                                                           |
| [UI](docs/features/ui.md)                       | Replace the built-in footer with a compact status bar for cwd, git, model, cost, and context.                                               |
| [Personality](docs/features/personality.md)     | Name new sessions from the first prompt using a lightweight model.                                                                          |
| [LSP](docs/features/lsp.md)                     | Read-only semantic navigation and explicit diagnostics for TypeScript, Svelte, and provisioned Ruby.                                        |
| [Subagents](docs/features/subagents.md)         | Run foreground or background General, Explore, and Review agents inside the current Pi session.                                             |
| [Implement](docs/features/implement.md)         | Execute Markdown checkbox plans through strict checkout-owned workstreams, cumulative review, durable recovery, and serialized publication. |
| [Papercuts](docs/features/papercuts.md)         | Keep a durable, human-reviewed queue of recurring project workflow gaps.                                                                    |
| [Handoff](docs/features/handoff.md)             | Prompt to compact context when handing an active session from one model to another.                                                         |
| [BTW](docs/features/btw.md)                     | Ask a side question about the current session without adding it to the main transcript.                                                     |
| [Caffeinate](docs/features/caffeinate.md)       | Hold an idle-sleep inhibitor for the session lifetime on macOS and Linux.                                                                   |

## Implement run safety

Implement requires Node.js 24+ and scopes each active run to its invoking checkout. A new run requires a clean named-branch checkout with a resolvable `HEAD` and no active Git operation. It accepts one arbitrary or headingless Markdown checkbox section and recursively ingests only ordinary local Markdown links as its plan corpus. Separate linked worktrees may run concurrently; a second run in the same checkout is rejected by its OS-backed lease. Independent workstreams may overlap, while target-quiet integration and publication remain serialized. Dependent workstreams receive bases containing completed dependencies. Publishable staging commits run ordinary Git hooks, and failures route through durable recovery without changing the target. Its revisioned `run-state.json` is authoritative, while UI, evidence, and plan checkboxes are projections. Tracked projected plans retain exact hash protection, recoverable target dirt pauses with exact paths and can resume after cleanup, completed and safety-blocked runs cannot resume, and cleanup or abandonment conservatively removes only provably owned resources. See [Implement](docs/features/implement.md) for operating constraints and the [internal library](docs/features/library.md) for lease and common-Git exclude contracts.

## Install

Install the complete bundle into Pi:

```bash
pi install git:github.com/madeleineostoja/pi-extensions
```

Pin to a tag:

```bash
pi install git:github.com/madeleineostoja/pi-extensions@v0.1.0
```

## License

MIT. See [LICENSE](LICENSE).
