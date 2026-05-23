# pi-guard

Pause before applying edits and ask for your approval.

pi-guard intercepts every `edit` and `write` tool call and presents a modal before the change lands on disk. This prevents the common pattern where an agent silently rewrites files before you have a chance to redirect it. When you want to let the agent run freely, you can turn guard mode off for the session or permanently.

## Usage

**Guard mode is on by default.** Each new session starts with it enabled; the footer shows `guarding` while it is active.

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

| Command         | Effect                   |
| --------------- | ------------------------ |
| `/guard`        | Toggle guard mode on/off |
| `/guard on`     | Enable                   |
| `/guard off`    | Disable                  |
| `/guard status` | Show current state       |

**Keyboard shortcut** — `Ctrl+Shift+G` toggles guard mode and shows a brief notification.

**Footer** — while guard mode is active, `guarding` appears in the status bar. It disappears when guard mode is off.

## Configuration

pi-guard has no config file or CLI flags. It always guards Pi's built-in `edit` and `write` tools when guard mode is on.

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
