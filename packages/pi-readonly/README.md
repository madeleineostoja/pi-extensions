# pi-readonly

Pause before applying edits and ask for your approval.

pi-readonly intercepts every `edit` and `write` tool call and presents a modal before the change lands on disk. This prevents the common pattern where an agent silently rewrites files before you have a chance to redirect it. When you want to let the agent run freely, you can turn readonly mode off for the session.

## Usage

**Readonly mode is on by default.** Each new session starts with it enabled; the footer shows `readonly` while it is active.

**When the agent proposes an edit or write**, a modal appears:

```
Readonly: proposed edit — apply?
> Accept
  Accept for this session
  Steer
```

- **Accept** — applies the change and continues.
- **Accept for this session** — applies the change and disables readonly mode for the rest of the session.
- **Steer** (or press Escape/cancel) — blocks the edit. If you typed feedback, the agent receives it; if you dismissed without feedback, the agent is told to ask for clarification before retrying.

**Slash command**

| Command         | Effect                      |
| --------------- | --------------------------- |
| `/readonly`     | Toggle readonly mode on/off |
| `/readonly on`  | Enable                      |
| `/readonly off` | Disable                     |

Current state is always visible in the footer (`readonly` or `editing`).

**Keyboard shortcut** — `Ctrl+Shift+R` toggles readonly mode.

**Footer** — while readonly mode is active, `readonly` appears in the status bar. It shows `editing` when readonly mode is off.

## Configuration

pi-readonly has no config file or CLI flags. It always gates Pi's built-in `edit` and `write` tools when readonly mode is on.

## Caveats

These are deliberate non-features.

- **No persistence.** Readonly mode resets to on when a new session starts (`startup`, `new`, `fork`). On reload or resume, the prior in-session state is preserved — if you turned readonly off before reloading, it stays off. There is no config file to make it default-off across sessions.
- **No per-path config.** Readonly mode is global — you cannot exempt certain directories or file types.
- **No bash-redirect interception.** Shell commands that write files (e.g. `echo foo > bar.txt`) bypass the `edit`/`write` tool hooks entirely and are not gated.
- **Non-interactive sessions run without readonly mode.** In print mode (`pi -p "..."`), RPC mode, and other non-interactive contexts there is no UI to present the approval modal. Readonly mode is automatically disabled at session start and a one-time message is written to stderr. Edits proceed without confirmation.

## Keybinding conflicts

If `Ctrl+Shift+R` collides with your terminal or another extension, remap it in `~/.pi/agent/keybindings.json`.

## License

MIT
