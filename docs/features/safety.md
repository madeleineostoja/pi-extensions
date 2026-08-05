# Safety

Pipkin has two independent controls:

- **Sandbox** limits where model Bash and direct `write`/`edit` calls may write.
- **Readonly** asks for confirmation before resolved `edit` and `write` calls.

Neither is hostile-code isolation. Pipkin extensions still run with the Pi process's permissions.

## Platform behavior

| Platform or state                        | Model Bash and direct writes                                                                                                |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Enabled macOS main session               | Seatbelt-confined Bash and canonical-workspace checks for direct `write`/`edit`                                             |
| Enabled macOS repository-read-only child | Repository workspace/worktree, worktree Git, and common Git writes denied; intended temporary/cache writes remain available |
| Linux                                    | `sandbox unavailable`; ordinary local Bash and instruction-only repository preservation                                     |
| macOS initialization failure             | Sandbox reports unavailable and blocks model Bash/direct mutation until the operator explicitly chooses `/sandbox off`      |

Sandbox starts enabled for macOS main sessions. Child sessions resolve policy from their runtime cwd and snapshot their parent's current enabled state and requested write mode when spawned. Later toggles do not change existing children or already-running descendants.

## Sandbox controls

| Command        | Effect                                                                                             |
| -------------- | -------------------------------------------------------------------------------------------------- |
| `/sandbox`     | Open Mode, confirmed-denial, and policy controls; inspect bounded write denials and labeled detail |
| `/sandbox on`  | Enable protection for later model Bash/direct-tool calls in the current session                    |
| `/sandbox off` | Disable protection for later calls and children spawned afterward                                  |

The footer shows `sandbox` while enabled, `sandbox off` after explicit disable, and a warning with the active-runtime denial count after confirmed direct-tool or kernel Bash write denial. `/sandbox` lists recent denials newest first; its policy page reports effective authority, so repository-read-only children list only their writable temporary/cache roots.

On macOS, model Bash runs through `/usr/bin/sandbox-exec`. Workspace-write mode admits the canonical repository workspace, required Git administration, canonical temporary roots, and reviewed npm, pnpm, and GitHub CLI cache/state roots. Direct `write` and `edit` calls are separately checked against the canonical workspace and cannot escape through ordinary traversal or symlinks.

Repository-read-only mode adds final denies for the workspace/worktree and Git authorities after writable-root allows. It is defense in depth for trusted inspection agents, not a general filesystem sandbox.

`bash_outcome` uses the same Sandbox-owned Bash path as ordinary model Bash. Processes uses that path for current-host managed foreground commands. User `!` and `!!` shell execution remains ordinary user-controlled Bash on every platform.

## Child-session snapshots

| Child role                                                     | Requested mode on enabled macOS |
| -------------------------------------------------------------- | ------------------------------- |
| Explore, Review, nested Explore                                | Repository read-only            |
| Implement planner and reviewers                                | Repository read-only            |
| Implement implementation, revision, reconciliation, and repair | Workspace write                 |

Public subagents share the invoking working tree. Implement workers instead receive owned disposable worktrees. Turning Sandbox off affects only children created afterward.

## Managed-process safety

Managed commands must remain foreground and non-interactive. Do not use `&`, `nohup`, daemonization, terminal attachment, or input.

Start a process only when useful independent work can continue. Wait once for completion or a case-sensitive readiness literal instead of polling; a wait timeout leaves the process running. Inspect bounded output when it affects the next decision, retain a point-in-time outcome when status is enough, and stop unneeded work explicitly. `/processes` provides current-session inspection and confirmed stop controls; it does not expose arbitrary PID management.

Each runtime permits at most eight active processes, retains at most 32 records and 1 MiB of output per record, and closes with the session.

## Trust boundary and non-goals

Workspace-write Sandbox mode still permits broad reads, unrestricted networking, repository destruction, and shared Git-state changes within admitted roots. Sandbox does not confine:

- extension JavaScript or extension-owned processes;
- provider traffic or Web Fetch;
- language servers or custom tools;
- remote mutations or inherited credentials;
- hostile repository code.

Web Fetch separately validates public targets, but browser resolution after host validation leaves a DNS-rebinding window. Its requests and temporary artifacts are outside Sandbox and Readonly mediation.

Use a devcontainer, VM, remote sandbox, or equivalent external boundary for hostile or unattended work.

## Readonly

Readonly controls only resolved `edit` and `write` calls. Pi shows its native edit/write preview first; Readonly then asks only for the action and target, with `Allow`, `Allow for session`, or `Steer`.

| Control         | Effect                                          |
| --------------- | ----------------------------------------------- |
| `/readonly`     | Inspect or toggle the current confirmation mode |
| `/readonly on`  | Require confirmation                            |
| `/readonly off` | Disable confirmation                            |
| `Ctrl+R`        | Toggle the same workflow                        |

Readonly and Sandbox remain independent: approving an edit does not expand Sandbox reachability, and disabling Sandbox does not disable Readonly. Where Pi cannot show an interactive prompt, Readonly steps aside.
