# Safety

Guard is Pipkin's sole owner of Bash, filesystem reachability, protected explicit reads, and semantic Bash confirmation. Readonly remains a separate confirmation owner for `edit` and `write`.

## Guard modes

On supported macOS arm64 and x64 hosts, Guard runs agent Bash and trusted user `!` / `!!` Bash through managed Nono when its health probe succeeds. Nono receives a fixed capability manifest with explicit file or directory grants and **unrestricted networking**. It confines filesystem reachability; it does not prevent network exfiltration.

`guard` means the Nono sandbox is active. `guard: tools-only` means Nono is unhealthy: agent Bash is blocked, while trusted `!` and `!!` commands run locally with one bounded warning. `guard: local` means either an unsupported platform or a supported-Mac session with the sandbox switched off. Local mode makes no confinement claim, but semantic confirmation and protected explicit-read checks still apply. Run `npm install` (or `npm run postinstall`) from the Pipkin root and reload or restart Pi to recover managed Nono; Guard does not install or repair it at runtime.

Use `/guard` to toggle the current **Sandbox on/off** and **Semantic guard on/off** states. Both reset to on when a new session starts. Unsupported hosts never use Nono; their UI-backed agent Bash still receives semantic confirmation, and protected explicit reads remain guarded.

## Filesystem capabilities

On a supported Mac, Guard builds a fixed sandbox from the canonical session cwd, ordinary temporary/cache roots, required system and device roots, and narrow read-only Pi introspection roots. Existing `<agent-dir>/pipkin`, `bin`, `extensions`, `skills`, `prompts`, and `themes` roots are read-only introspection grants. Guard never grants the agent root, `auth.json`, or session files by default.

Direct filesystem access outside that sandbox offers **Allow once** or **Block** in the interactive TUI. An approval applies only to the current tool call; it is not remembered and does not expand later Nono manifests. Bash cannot reach an outside path unless it belongs to the fixed sandbox or the sandbox is switched off. Failed Bash commands are never retried.

Guard protects explicit reads of workspace `.env` files, project private-key names/extensions, and designated home credential files. Protected reads also offer only **Allow once** or **Block** and prompt again on later access. Directory `grep` and Bash can still read protected content inside their fixed filesystem capabilities; Guard is not a per-file Bash secret filter. File-targeted `grep` and explicit `read` remain protected.

## Bash confirmation

Before agent Bash starts, Guard assesses the final command and shows one ordered prompt for likely data loss or destructive external actions: **Allow once**, **Allow all this session**, or **Block**. Routine commands, including clean Git-tracked file moves and removals, do not prompt. Allowing all switches the semantic guard off for the rest of that session; it changes neither the sandbox nor Readonly. No-UI calls pass semantic prompting without waiting, but supported-Mac workers remain sandboxed and protected direct reads stay closed without one-shot approval.

Trusted `!` and `!!` commands share the same fixed Nono sandbox when healthy, while preserving Pi's context behavior. They do not receive model-origin semantic prompts.

## Scope limits

Guard mediates Pi's Bash definition and selected direct filesystem tools. It does not mediate extension JavaScript, provider traffic, Web Fetch, direct RPC `{type:"bash"}`, or subprocesses owned by other extensions. Use an outer VM, container, or restricted environment when network isolation or broader process isolation is required.

## Readonly

Readonly keeps the established `/readonly` and `Ctrl+R` workflow for resolved `edit` and `write` calls. It is independent from Guard: accepting an edit does not expand sandbox reachability or approve Bash, and a one-shot Guard approval does not approve a later edit.
