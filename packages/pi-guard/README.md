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

- Local file removal (`rm`, `rmdir`, `unlink`, `shred`, `find ... -delete`, `xargs rm`, remote `ssh "rm ..."`)
- Git local-loss operations (`git clean`, `git reset --hard`, force push, remote ref deletion, stash drop, branch deletion, forced checkout/switch, reflog/GC prune)
- Shell overwrite/truncate bypasses (`> file`, `: > file`, `truncate -s 0`, `dd`, `sed -i`, `mv`/`cp` overwrite, `install` overwrite)
- Permissions damage (`chmod -R`, `chmod 777`, `chown -R`)
- Sync overwrite/delete (`rsync --delete`, `rsync --delete-excluded`)
- Inline interpreter escape hatches (`python -c`, `node -e`, `ruby -e`, `perl -e` containing filesystem deletion APIs)
- Remote script execution (`curl ... | sh`, `wget -O- ... | bash`, `bash <(curl ...)`, `eval "$(curl ...)"`)
- Container cleanup/data-loss commands (`docker system prune`, `docker volume rm/prune`, `docker compose down -v`, Podman equivalents)
- Global/system package manager mutations (`npm install -g`, `pnpm add -g`, `brew install`, `apt remove`, etc.)
- GitHub CLI mutations (`gh pr merge`, `gh repo delete`, `gh api -X DELETE`, GraphQL mutations, secrets/variables/release/workflow changes)
- Infrastructure/cloud mutations (`terraform destroy`, risky `terraform apply`, OpenTofu/Pulumi destructive commands, destructive AWS CLI operations)
- Publish/deploy commands (`npm publish`, `gem push`, `docker push`, `vercel --prod`, `wrangler deploy/delete`)

## Limitations

- **No edit/write gating.** Normal `edit` and `write` tool calls are handled by `pi-readonly`.
- **No sandbox or outside-cwd policy.** Filesystem boundaries are handled by `pi-sandbox`.
- **Limited production-infrastructure rules.** Guard covers Terraform/OpenTofu/Pulumi and high-signal destructive AWS CLI operations, but it intentionally does not cover Kubernetes or every cloud/provider CLI.
- **No secrets scanning.** Protected-file policies are out of scope.
- **Non-interactive sessions run without guard.** In print mode, RPC mode, and other non-interactive contexts there is no UI to present the approval modal. Guard is automatically disabled at session start and a one-time status message is added to the response log.
- **Git-aware recoverability.** Deleting clean tracked files is allowed because Git can restore them. Deleting untracked files or dirty tracked files prompts.
- **Disposable temp cleanup.** Narrow destructive operations on cwd-local `tmp` plus specific children of known temp roots (`os.tmpdir()`, `$TMPDIR`, `$TMP`, `$TEMP`, `$TEMPDIR`, `/tmp`, `/var/tmp`, `/private/tmp`) are allowed, including obvious `mktemp` cleanup. Deleting system temp roots themselves, globbing under temp roots, or touching non-`tmp` paths inside the current worktree still prompts.
- **Best-effort parsing.** Commands with shell variables, globs, command substitution, pipelines, and compound statements (`&&`, `||`, `;`) are handled conservatively: some forms may prompt even when safe, and some complex forms may not be detected.
- **Git commands with `-C` are supported** but dirty-worktree checks apply to the target directory.

## License

MIT
