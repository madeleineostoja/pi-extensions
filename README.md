# pi-extensions

Personal extensions for the [Pi](https://github.com/earendil-works/pi) agent harness.

## Packages

| Package                                       | Description                                                                                                                                 |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| [pi-auto-name](packages/pi-auto-name)         | Name new sessions from the first prompt using a lightweight model.                                                                          |
| [pi-btw](packages/pi-btw)                     | Ask a side question about the current session without adding it to the main transcript.                                                     |
| [pi-caffeinate](packages/pi-caffeinate)       | Hold an idle-sleep inhibitor for the session lifetime on macOS and Linux.                                                                   |
| [pi-context-prune](packages/pi-context-prune) | Compact stale or low-value tool results, with `context_recall` for on-demand retrieval.                                                     |
| [pi-defaults](packages/pi-defaults)           | Keep `settings.json` model/provider and thinking defaults stable across sessions.                                                           |
| [pi-footer](packages/pi-footer)               | Replace the built-in footer with a compact status bar for cwd, git, model, cost, and context.                                               |
| [pi-guard](packages/pi-guard)                 | Ask before running risky destructive shell commands.                                                                                        |
| [pi-implement](packages/pi-implement)         | Execute Markdown checkbox plans through strict checkout-owned workstreams, cumulative review, durable recovery, and serialized publication. |
| [pi-lsp](packages/pi-lsp)                     | Read-only semantic navigation and explicit diagnostics for TypeScript, Svelte, and provisioned Ruby.                                        |
| [pi-papercuts](packages/pi-papercuts)         | Keep a durable, human-reviewed queue of recurring project workflow gaps.                                                                    |
| [pi-model-handoff](packages/pi-model-handoff) | Prompt to compact context when handing an active session from one model to another.                                                         |
| [pi-subagents](packages/pi-subagents)         | Run foreground or background General, Explore, and Review agents inside the current Pi session.                                             |
| [pi-readonly](packages/pi-readonly)           | Ask before built-in `edit` and `write` tool calls apply changes.                                                                            |
| [pi-sandbox](packages/pi-sandbox)             | Limit file, subprocess, and network access with policy gates and `nono` sandboxing.                                                         |

## pi-implement run safety

`pi-implement` requires Node.js 24+ and scopes each active run to its invoking checkout. A new run requires a clean named-branch checkout with a resolvable `HEAD` and no active Git operation. It accepts one arbitrary or headingless Markdown checkbox section and recursively ingests only ordinary local Markdown links as its plan corpus. Separate linked worktrees may run concurrently; a second run in the same checkout is rejected by its OS-backed lease. Independent workstreams may overlap, while target-quiet integration and publication remain serialized. Dependent workstreams receive bases containing completed dependencies. Publishable staging commits run ordinary Git hooks, and failures route through durable recovery without changing the target. Its revisioned `run-state.json` is authoritative, while UI, evidence, and plan checkboxes are projections. Tracked projected plans retain exact hash protection, completed and safety-blocked runs cannot resume, and cleanup or abandonment conservatively removes only provably owned resources. See the [pi-implement README](packages/pi-implement/README.md) for operating constraints and the [shared library README](lib/README.md) for the lease and common-Git exclude contracts.

## Install

Install the whole bundle into pi:

```bash
pi install git:github.com/madeleineostoja/pi-extensions
```

This installs every extension listed above. Disable individual ones via `pi config`.

Pin to a tag:

```bash
pi install git:github.com/madeleineostoja/pi-extensions@v0.1.0
```

## License

MIT. See [LICENSE](LICENSE).
