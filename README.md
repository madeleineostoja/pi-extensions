# pi-extensions

Personal extensions for the [Pi](https://github.com/earendil-works/pi) agent harness.

## Packages

| Package                                       | Description                                                                                       |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| [pi-auto-name](packages/pi-auto-name)         | Name new sessions from the first prompt using a lightweight model.                                |
| [pi-btw](packages/pi-btw)                     | Ask a side question about the current session without adding it to the main transcript.           |
| [pi-caffeinate](packages/pi-caffeinate)       | Hold an idle-sleep inhibitor for the session lifetime on macOS and Linux.                         |
| [pi-usage](packages/pi-usage)                 | Show ChatGPT Codex and Opencode Go subscription usage in the footer and rewrite raw limit errors. |
| [pi-context-prune](packages/pi-context-prune) | Compact stale or low-value tool results, with `context_recall` for on-demand retrieval.           |
| [pi-footer](packages/pi-footer)               | Replace the built-in footer with a compact status bar for cwd, git, model, cost, and context.     |
| [pi-guard](packages/pi-guard)                 | Ask before running risky destructive shell commands.                                              |
| [pi-implement](packages/pi-implement)         | Run `/implement` on a `/plan` checklist, reviewing and committing one task at a time.             |
| [pi-model-handoff](packages/pi-model-handoff) | Prompt to compact context when downshifting from a frontier model to a cheaper model.             |
| [pi-readonly](packages/pi-readonly)           | Ask before built-in `edit` and `write` tool calls apply changes.                                  |
| [pi-sandbox](packages/pi-sandbox)             | Limit file, subprocess, and network access with policy gates and `nono` sandboxing.               |

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
