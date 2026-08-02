# Safety

Sandbox is Pipkin's repository-write boundary for model Bash and direct `write` and `edit` calls. Readonly remains a separate confirmation owner for `edit` and `write`.

## Sandbox

On macOS, Sandbox starts enabled for main sessions. Child sessions resolve their own policy from their runtime cwd and snapshot their parent's current Sandbox mode when spawned. Model Bash runs under macOS Seatbelt through `/usr/bin/sandbox-exec`; its descendants can write only the canonical repository workspace, required Git administration state, canonical temporary roots, and reviewed npm/pnpm cache roots. Direct `write` and `edit` calls are separately checked against the canonical workspace and cannot escape through ordinary traversal or symlinks.

`/sandbox` opens a compact panel showing the current state, canonical workspace, and extra writable roots. `/sandbox on` and `/sandbox off` change future model Bash and direct-tool calls in the current session; `/sandbox off` also affects subsequently spawned Pipkin subagents. The footer shows `sandbox` when enabled and `sandbox off` after an explicit disable. Existing child sessions and already-running sandboxed descendants are unaffected by later toggles.

Linux reports `sandbox unavailable` and uses ordinary local model Bash without direct-tool gating. A macOS policy-initialization failure also reports unavailable, but keeps model Bash and direct mutations blocked until `/sandbox off` is chosen explicitly; reload the session to retry initialization. User `!` and `!!` Bash remains ordinary user shell execution on every platform.

Sandbox permits broad filesystem reads, unrestricted networking, repository destruction, and shared Git-state changes. It does not protect secrets or prevent data from reaching providers or network services. It does not constrain extension JavaScript, extension-owned processes, provider traffic, Web Fetch, custom tools, language servers, remote mutations, or inherited credentials. Hostile or unattended work needs an external boundary such as a devcontainer, VM, or remote sandbox.

## Readonly

Readonly keeps the established `/readonly` and `Ctrl+R` workflow for resolved `edit` and `write` calls. It is independent from Sandbox: accepting an edit does not expand Sandbox reachability, and turning Sandbox off does not disable Readonly.
