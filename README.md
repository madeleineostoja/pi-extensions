# pi-extensions

Personal extensions for the [Pi](https://github.com/earendil-works/pi) agent harness.

## Packages

| Package                                       | Description                                                                                                                                                           |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [pi-auto-name](packages/pi-auto-name)         | Name new sessions from the first prompt using a lightweight model.                                                                                                    |
| [pi-btw](packages/pi-btw)                     | Ask a side question about the current session without adding it to the main transcript.                                                                               |
| [pi-caffeinate](packages/pi-caffeinate)       | Hold an idle-sleep inhibitor for the session lifetime on macOS and Linux.                                                                                             |
| [pi-context-prune](packages/pi-context-prune) | Compact stale or low-value tool results, with `context_recall` for on-demand retrieval.                                                                               |
| [pi-defaults](packages/pi-defaults)           | Keep `settings.json` model/provider and thinking defaults stable across sessions.                                                                                     |
| [pi-footer](packages/pi-footer)               | Replace the built-in footer with a compact status bar for cwd, git, model, cost, and context.                                                                         |
| [pi-guard](packages/pi-guard)                 | Ask before running risky destructive shell commands.                                                                                                                  |
| [pi-implement](packages/pi-implement)         | Run `/implement` on a markdown plan checklist with isolated cumulative candidates, typed review findings, strict revisioned state, and retained stalled-run recovery. |
| [pi-lsp](packages/pi-lsp)                     | Read-only semantic navigation and explicit diagnostics for TypeScript, Svelte, and provisioned Ruby.                                                                  |
| [pi-papercuts](packages/pi-papercuts)         | Keep a durable, human-reviewed queue of recurring project workflow gaps.                                                                                              |
| [pi-model-handoff](packages/pi-model-handoff) | Prompt to compact context when handing an active session from one model to another.                                                                                   |
| [pi-subagents](packages/pi-subagents)         | Run foreground or background General, Explore, and Review agents inside the current Pi session.                                                                       |
| [pi-readonly](packages/pi-readonly)           | Ask before built-in `edit` and `write` tool calls apply changes.                                                                                                      |
| [pi-sandbox](packages/pi-sandbox)             | Limit file, subprocess, and network access with policy gates and `nono` sandboxing.                                                                                   |

## pi-implement run safety

`pi-implement` requires Node.js 24+ and scopes each active run to its starting checkout and branch. Separate linked worktrees on separate branches may run concurrently; a second run against the same checkout is rejected. Candidate-worker concurrency controls overlap, while staging and publication remain serialized per run. User or third-party mutation of an active target checkout, branch, or pi-owned workspace is unsupported; persistent locks or unexplained target changes pause with approved candidates retained, and pi-implement never removes Git lock files. Its canonical revisioned state is authoritative for recovery, while events, UI, artifacts, and plan checkboxes are rebuildable projections. Old retained runs require start-over. See the [pi-implement README](packages/pi-implement/README.md#run-ownership-and-recovery) for operating constraints.

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
