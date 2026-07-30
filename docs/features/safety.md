# Safety

Guard is Pipkin's sole owner of Bash, filesystem reachability, protected explicit reads, and semantic Bash confirmation. Edit Approval remains a separate confirmation owner for `edit` and `write`.

## Guard modes

On supported macOS arm64 and x64 hosts, Guard runs agent Bash and trusted user `!` / `!!` Bash through managed Nono when its health probe succeeds. Nono receives a capability manifest with explicit file or directory grants and **unrestricted networking**. It confines filesystem reachability; it does not prevent network exfiltration.

`guard` means the Nono boundary is active. `guard: tools-only` means Nono is unhealthy: agent Bash is blocked, while trusted `!` and `!!` commands run locally with one bounded warning. `guard: local` means either an unsupported platform or an explicitly disabled supported-Mac boundary. Local mode makes no confinement claim, but semantic confirmation and protected explicit-read checks still apply. Run `npm install` (or `npm run postinstall`) from the Pipkin root and reload or restart Pi to recover managed Nono; Guard does not install or repair it at runtime.

Unsupported hosts never use Nono. Their UI-backed agent Bash still receives semantic confirmation, and protected explicit reads remain guarded.

## Filesystem capabilities

On a supported Mac, Guard begins with the canonical session cwd, ordinary temporary/cache roots, required system and device roots, and narrow read-only Pi introspection roots. The current session file is an exact read grant. Existing `<agent-dir>/pipkin`, `bin`, `extensions`, `skills`, `prompts`, and `themes` roots are read-only introspection grants. Guard never grants the agent root, `auth.json`, or sibling sessions by default.

Use `/guard` to add an existing canonical path for this session. A file grant is exact; a directory grant covers that directory and its descendants. Read and write are distinct. Grants are memory-only, apply to later direct-tool decisions and later Nono manifests, and are never promoted to a parent, persisted, inherited, inferred from command text, or created after a failed Bash command. Failed Bash commands are never retried.

Guard protects explicit reads of workspace `.env` files, project private-key names/extensions, and designated home credential files. Outside and protected effects are collected into one direct-tool prompt. Directory `grep` and Bash can still read protected content inside their filesystem grants; Guard is not a per-file Bash secret filter. File-targeted `grep` and explicit `read` remain protected.

## Bash confirmation

Before agent Bash starts, Guard assesses the final command and shows one ordered prompt for every recognized risk: **Allow once**, **Allow all this session**, or **Block**. Allowing all suppresses only later semantic prompts for that session; it changes neither Nono capabilities, filesystem/protected approvals, nor Edit Approval. No-UI calls pass semantic prompting without waiting, but supported-Mac workers remain Nono/direct constrained and protected direct reads stay closed without approval.

Trusted `!` and `!!` commands share the same live Nono capabilities and grants when healthy, while preserving Pi's context behavior. They do not receive model-origin semantic prompts.

## Scope limits

Guard mediates Pi's Bash definition and selected direct filesystem tools. It does not mediate extension JavaScript, provider traffic, Web Fetch, direct RPC `{type:"bash"}`, or subprocesses owned by other extensions. Use an outer VM, container, or restricted environment when network isolation or broader process isolation is required.

## Edit Approval

Edit Approval keeps the established `/readonly` and `Ctrl+R` workflow for resolved `edit` and `write` calls. It is independent from Guard: accepting an edit does not grant filesystem reachability or Bash approval, and a Guard grant does not approve an edit.
