# pi-extensions

Personal extensions for the [Pi](https://github.com/earendil-works/pi) agent harness.

## Packages

| Package                                       | Description                                                                                   |
| --------------------------------------------- | --------------------------------------------------------------------------------------------- |
| [pi-auto-name](packages/pi-auto-name)         | Automatically generate a short session name from the first user prompt.                       |
| [pi-codex-usage](packages/pi-codex-usage)     | Show ChatGPT Codex subscription usage in the Pi footer while a Codex model is active.         |
| [pi-caffeinate](packages/pi-caffeinate)       | Prevent host idle-sleep for the lifetime of a pi session (macOS + Linux).                     |
| [pi-context-prune](packages/pi-context-prune) | Keep the context window small by pruning large, stale tool results and re-fetching on demand. |
| [pi-footer](packages/pi-footer)               | Compact replacement footer with cwd, branch, model, cost, context, and extension statuses.    |
| [pi-readonly](packages/pi-readonly)           | Lightweight approval before agents begin editing or writing files                             |
| [pi-sandbox](packages/pi-sandbox)             | Kernel level sandboxing with pi agents with [nono](https://github.com/always-further/nono)    |

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
