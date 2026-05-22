# pi-guard

Pause before applying edits and ask for your approval.

pi-guard intercepts every `edit` and `write` tool call and presents a modal before the change lands on disk. This prevents the common pattern where an agent silently rewrites files before you have a chance to redirect it. When you want to let the agent run freely, you can turn guard mode off for the session or permanently.

## Install

<!-- TODO: update once published -->
```
pi install git:github.com/<user>/pi-guard
```

If published to npm:

```
pi install npm:pi-guard
```

## Usage

**Guard mode is on by default.** Each new session starts with it enabled; the footer shows `📝 guarding edits` while it is active.

**When the agent proposes an edit or write**, a modal appears:

```
Guard: proposed edit — apply?
> Accept
  Accept and stop guarding
  Steer
```

- **Accept** — applies the change and continues.
- **Accept and stop guarding** — applies the change and disables guard mode for the rest of the session.
- **Steer** (or press Escape/cancel) — blocks the edit. If you typed feedback, the agent receives it; if you dismissed without feedback, the agent is told to ask for clarification before retrying.

**Slash command**

| Command | Effect |
|---|---|
| `/guard` | Toggle guard mode on/off |
| `/guard on` | Enable |
| `/guard off` | Disable |
| `/guard status` | Show current state |

**Keyboard shortcut** — `Ctrl+Shift+G` toggles guard mode and shows a brief notification.

**Footer** — while guard mode is active, `📝 guarding edits` appears in the status bar. It disappears when guard mode is off.

## Configuration

### Guarded tools

By default, pi-guard intercepts `edit` and `write` tool calls. You can change the set using the `--guard-tools` flag:

```
pi --guard-tools=edit,write,custom-edit
```

The value is a comma-separated list of tool names. **The list replaces the default entirely**, so if you want to keep `edit` and `write` alongside your custom tool, include them explicitly. If you want to guard only `edit` and not `write`, pass `--guard-tools=edit`.

| Value | Effect |
|---|---|
| _(unset)_ | Guard `edit` and `write` (default) |
| `edit,write,custom-edit` | Guard all three; `custom-edit` is now intercepted |
| `edit` | Guard only `edit`; `write` is no longer intercepted |
| _(empty string)_ | Falls back to default (`edit,write`) with a warning notification |

## Composition

pi-guard handles only the interception and approval flow. Related extensions in the ecosystem:

- [pi-tool-display](https://github.com/MasuRii/pi-tool-display) — surfaces tool calls in the UI so you can see what the agent is doing without blocking it.
- [pi-sandbox](https://github.com/carderne/pi-sandbox) — restricts which paths and commands the agent may touch at all.

The three can be used together; they operate on different layers (display, approval, restriction).

## Caveats

These are deliberate non-features.

- **No persistence.** Guard mode resets to on when a new session starts (`startup`, `new`, `fork`). On reload or resume, the prior in-session state is preserved — if you turned guard off before reloading, it stays off. There is no config file to make it default-off across sessions.
- **No per-path config.** Guard mode is global — you cannot exempt certain directories or file types.
- **No bash-redirect interception.** Shell commands that write files (e.g. `echo foo > bar.txt`) bypass the `edit`/`write` tool hooks entirely and are not guarded.
- **Non-interactive sessions run without the guard.** In print mode (`pi -p "..."`), RPC mode, and other non-interactive contexts there is no UI to present the approval modal. Guard mode is automatically disabled at session start and a one-time message is written to stderr. Edits proceed without confirmation.

## Keybinding conflicts

If `Ctrl+Shift+G` collides with your terminal or another extension, remap it in `~/.pi/agent/keybindings.json`.

## License

MIT
