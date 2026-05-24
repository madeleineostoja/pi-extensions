# pi-extensions

Personal extensions for the [Pi](https://github.com/earendil-works/pi) agent harness.

## Packages

| Package                                 | Description                                                                                   |
| --------------------------------------- | --------------------------------------------------------------------------------------------- |
| [pi-caffeinate](packages/pi-caffeinate) | Prevent host idle-sleep for the lifetime of a pi session (macOS + Linux).                     |
| [pi-ctx](packages/pi-ctx)               | Keep the context window small by pruning large, stale tool results and re-fetching on demand. |
| [pi-guard](packages/pi-guard)           | Lightweight approval before agents begin editing or writing files                             |
| [pi-sandbox](packages/pi-sandbox)       | Kernel level sandboxing with pi agents with [nono](https://github.com/always-further/nono)    |

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
