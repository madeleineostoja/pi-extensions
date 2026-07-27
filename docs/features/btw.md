# pi-btw

Pi extension that adds a `/btw <question>` command for side questions about the current session.

## Install

This extension is part of the `pi-extensions` repo bundle. When you install the bundle from source:

```
cd /path/to/pi-extensions
pi install
```

Pi automatically enables every package listed in the root `package.json` `pi.extensions` array, including `pi-btw`. No additional configuration is required.

## Usage

```
/btw what does this function do?
```

Side questions are ephemeral: they do not enter the main conversation transcript. The current model answers from the session context plus your general knowledge. `/btw` has no tools and cannot read files, run commands, or mutate state.

## Keys

- `Esc` — dismiss the overlay (abort the in-flight request if still pending)
- `↑/↓` — scroll when overlay content overflows
- `x` — clear the process-local `/btw` history for this session

## Distinction from subagents

`/btw` is intentionally lightweight: it uses a direct model completion, has no tools, and does not spawn a background Pi session. For full tool-capable background work, use the bundled `pi-subagents` extension's `Agent` tooling.
