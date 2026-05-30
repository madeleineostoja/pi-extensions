# pi-guard

Pause before risky local destructive shell actions.

pi-guard intercepts built-in `bash` tool calls that can delete, discard, overwrite, or damage local work, and presents a confirmation modal before they run. It is a best-effort heuristic, not a security sandbox, not a production-infrastructure permission system, and does not gate normal `edit` or `write` tool calls (see `pi-readonly` for that).

## Usage

**Guard is on by default in interactive sessions.** Each fresh session starts with it enabled; the footer shows `guard` while it is active.

**When the agent proposes a risky shell command**, a modal appears showing the detected risk:

```
Guard: confirm risky command?
File removal: src/old.ts
> Allow once
  Allow similar this session
  Allow all this session
  Block
```

- **Allow once** — runs the command and continues.
- **Allow similar this session** — runs the command and suppresses future prompts for the same risk category.
- **Allow all this session** — runs the command and disables guard for the rest of the session.
- **Block** (or press Escape/cancel) — blocks the command. If you provide feedback, the agent receives it; if you dismiss without feedback, the agent is told not to retry blindly.

**Slash command**

| Command      | Effect              |
| ------------ | ------------------- |
| `/guard`     | Toggle guard on/off |
| `/guard on`  | Enable              |
| `/guard off` | Disable             |

Current state is always visible in the footer (`guard` or `guard off`).

**Keyboard shortcut** — `Ctrl+G` toggles guard mode.

## Guarded categories

- Local file removal (`rm`, `rmdir`, `unlink`, `shred`, `find ... -delete`)
- Git local-loss operations (`git clean`, `git reset --hard`, force push, stash drop, branch deletion)
- Shell overwrite/truncate bypasses (`> file`, `: > file`, `truncate -s 0`, `dd`, `sed -i`, `mv`/`cp` overwrite, `install` overwrite)
- Permissions damage (`chmod -R`, `chmod 777`, `chown -R`)
- Sync overwrite/delete (`rsync --delete`, `rsync --delete-excluded`)
- Inline interpreter escape hatches (`python -c`, `node -e`, `ruby -e`, `perl -e` containing filesystem deletion APIs)

## Limitations

- **No edit/write gating.** Normal `edit` and `write` tool calls are handled by `pi-readonly`.
- **No sandbox or outside-cwd policy.** Filesystem boundaries are handled by `pi-sandbox`.
- **No production-infrastructure rules.** Commands like `kubectl delete`, `terraform destroy`, and cloud CLI operations are not guarded.
- **No secrets scanning.** Protected-file policies are out of scope.
- **Non-interactive sessions run without guard.** In print mode, RPC mode, and other non-interactive contexts there is no UI to present the approval modal. Guard is automatically disabled at session start and a one-time status message is added to the response log.
- **Git-aware recoverability.** Deleting clean tracked files is allowed because Git can restore them. Deleting untracked files or dirty tracked files prompts.
- **Best-effort parsing.** Commands with shell variables, globs, command substitution, pipelines, and compound statements (`&&`, `||`, `;`) are handled conservatively: some forms may prompt even when safe, and some complex forms may not be detected.
- **Git commands with `-C` are supported** but dirty-worktree checks apply to the target directory.

## License

MIT
