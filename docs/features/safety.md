# Safety

Pipkin Guard establishes a fixed filesystem boundary for supported macOS arm64 and x64 hosts. It is a guardrail for Pi filesystem tools and managed Bash, not a claim that arbitrary local code is safe.

## Managed Nono

The root package installs reviewed Nono 0.69.0 releases for supported Macs at:

```text
<agent-dir>/pipkin/guard/nono/0.69.0/<target>/pipkin-nono
```

Guard resolves `PIPKIN_NONO_PATH` when it is set; otherwise it uses only that managed executable. It never searches `PATH`. To skip root-install download deterministically, set `PIPKIN_SKIP_NONO_DOWNLOAD`. The reviewed archive table is the single source for the release version, host selection, URLs, and digests used by both installation and runtime probing.

If Nono is unavailable, rejects Guard's unrestricted manifest, or fails its filesystem-confinement probe, run `npm install` (or `npm run postinstall`) from the Pipkin root and reload or restart Pi. Guard does not install or repair Nono while Pi is running.

## Fixed filesystem capabilities

On a supported Mac, Guard starts from the canonical session working directory, ordinary macOS temporary roots, eligible caller cache roots, required system/device/Nix/Node/Pi read roots, narrow agent introspection directories, and the current session file. Optional roots that do not exist are omitted. Guard does not grant the agent directory, `auth.json`, historical sessions, or a home directory by default.

Nono receives manifest version `0.1.0`, explicit filesystem grants, and unrestricted network mode. It confines filesystem access but does not filter Bash network egress. There are no profiles, deny entries, host rules, or persistent policy files.

Explicit reads of workspace `.env` files, project private-key names/extensions, and the designated home credential paths are protected separately from filesystem reachability. Future Guard interactions can approve exact canonical files or directory subtrees for the live session only. Guard does not pre-enumerate directory `grep` searches, so a reachable directory search may return protected content; file-targeted `grep` remains protected.

## Shell Guard

Shell Guard retains semantic confirmation for risky built-in Bash commands. It identifies the destructive effects in one command and asks whether to **Allow once**, **Allow all this session**, or **Block**. Session-wide approval resets for every new, resumed, forked, and reloaded session. Without an interactive UI, Shell Guard leaves Bash calls unchanged.

## Readonly

Readonly prompts only for resolved tools named `edit` and `write`. It is not a universal mutation gate: differently named tools remain outside this boundary. Built-in tools get a bounded local preview when Pi identifies their backend as built-in; same-name overrides and missing provenance stay gated but show their bounded input with an explicit unknown-backend warning.

`/readonly` and `Ctrl+R` toggle approval for the live extension runtime. Accepting for the session affects only that instance; reload, resume, new sessions, and forks instantiate a fresh enabled gate. TUI and RPC share the same prompt. Print and JSON calls pass without a prompt, notice, or mode change.
