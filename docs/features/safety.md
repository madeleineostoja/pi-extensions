# Safety

Pipkin keeps three different kinds of watch while an agent works: Sandbox defines where work may happen, Edit Approval checkpoints resolved tools named `edit` and `write`, and Shell Guard pauses recognized risky built-in `bash` actions. They are loaded in that order and are designed to overlap.

They are useful guardrails, not a claim that arbitrary local code is safe.

## Sandbox: set the working boundary

Sandbox checks Pi's filesystem tools in process and places subprocesses under [`nono`](https://github.com/always-further/nono) when a compatible binary is available.

| Pi tool                      | Required access |
| ---------------------------- | --------------- |
| `read`, `ls`, `find`, `grep` | read            |
| `write`                      | write           |
| `edit`                       | read and write  |

A path must be inside the relevant allowlist and must not match a deny pattern. The gate covers the built-in filesystem tools; `nono` applies corresponding filesystem and network policy to agent `bash`, user `!` / `!!`, and extension subprocesses launched through `pi.exec`.

If `nono` is unavailable, subprocess execution is blocked unless `degraded.allowExec` is explicitly enabled. In-process filesystem protection remains active.

### Start with `/sandbox`

Open the menu to inspect current status and policy, explain a decision, grant or revoke access, toggle enforcement for this session, or reload configuration:

```text
/sandbox
```

Inline forms are useful when you already know the action:

```text
/sandbox status
/sandbox summary
/sandbox reload
/sandbox why .env
/sandbox why api.github.com
/sandbox allow host api.example.com
/sandbox allow host --persist api.example.com
/sandbox allow host --persist=user api.example.com
/sandbox allow read ../shared
/sandbox allow write ./generated
/sandbox revoke host api.example.com
/sandbox revoke host --persist api.example.com
/sandbox revoke read ../shared
/sandbox revoke write ./generated
/sandbox network on|off
/sandbox on|off
```

Filesystem grants are session-only. A bare `--persist` writes host changes to `<cwd>/.pi/pipkin/sandbox.json`; `--persist=user` writes additions to the central `sandbox` section. Persistent revoke targets project policy. In a TUI, filesystem allowlist misses can offer one-time, session, or parent-directory access; deny-pattern matches never prompt.

### Policy

Sandbox merges built-in defaults, agent-level configuration, then checkout policy:

```text
<agent-dir>/pipkin/config.json#sandbox
<cwd>/.pi/pipkin/sandbox.json
```

Later values override earlier ones and arrays replace rather than merge.

```json
{
  "enabled": true,
  "fs": {
    "allowRead": ["<cwd>", "/usr", "/etc", "/opt"],
    "allowWrite": ["<cwd>", "~/.cache/pi", "<agent-dir>/pipkin/logs"],
    "denyPatterns": ["<cwd>/**/.env", "<cwd>/**/.env.*", "~/.ssh/**"]
  },
  "network": {
    "mode": "non-interactive-only",
    "allow": ["github.com", "*.github.com", "registry.npmjs.org"]
  },
  "audit": {
    "log": true,
    "logFile": "<agent-dir>/pipkin/logs/sandbox-audit.jsonl"
  },
  "enforcement": { "requireKernelSandbox": false },
  "degraded": { "allowExec": false }
}
```

Path fields support `<cwd>`, `~`, and environment variables. The OS temporary directory is always allowed. Built-in defaults also allow common system read paths and package hosts while denying common credentials and private-key patterns; `/sandbox` shows the resolved policy.

`network.mode` has three values:

| Mode                   | Subprocess network behavior                             |
| ---------------------- | ------------------------------------------------------- |
| `non-interactive-only` | Enforce the allowlist only outside interactive sessions |
| `always`               | Enforce it in every session                             |
| `off`                  | Do not filter subprocess network access                 |

Hosts are exact names or wildcard subdomains. `*.github.com` does not include `github.com`, so allow both when both are needed.

Set `enforcement.requireKernelSandbox: true` to refuse Sandbox startup without `nono`. Set `degraded.allowExec: true` only when unconstrained subprocess execution is acceptable.

### `nono` availability

Pipkin downloads a verified packaged binary at installation time for macOS and glibc Linux on arm64 and x64. Windows, Alpine/musl, distroless Linux, BSD, and other architectures use a compatible `nono` already on `PATH` or fall back to in-process filesystem protection with subprocesses blocked.

Skip the managed download with:

```sh
PIPKIN_SANDBOX_SKIP_DOWNLOAD=1 npm install
```

### Audit and limits

When enabled, decisions are written as JSONL and emitted as `pipkin.sandbox.audit`; policy changes also emit `pipkin.sandbox.policy-changed`.

Sandbox is defense in depth:

- extensions are trusted code, and their direct JavaScript network requests are not confined;
- language servers are trusted subprocesses launched outside Sandbox;
- the in-process path gate has time-of-check/time-of-use limits;
- Linux Landlock is allowlist-oriented, so deny globs remain in process;
- on macOS, only deny patterns with a useful literal prefix can be pushed into Seatbelt.

## Edit/write Approval

Edit/write Approval prompts only for resolved tools named `edit` and `write`. It is not a universal mutation gate: differently named tools remain outside this boundary. Built-in tools get a bounded local preview when Pi identifies their backend as built-in; same-name overrides and missing provenance stay gated but show their bounded input with an explicit unknown-backend warning.

`/readonly` and `Ctrl+R` toggle approval for the live extension runtime. Accepting for the session affects only that instance; reload, resume, new sessions, and forks instantiate a fresh enabled gate. TUI and RPC share the same prompt. Print and JSON calls pass without a prompt, notice, or mode change.

## Shell Guard: best-effort destructive-shell confirmation

Shell Guard inspects resolved built-in `bash` invocations that Pi identifies with built-in provenance and makes one confirmation request containing every recognized risk. It supports simple separators, path-qualified executables, supported `sudo`/`doas`/`env`/`command` options, and one literal `sh -c` or `bash -c` level. Dynamic shell grammar, expansions, substitutions, globs, remote tails, `find -exec`, and xargs tails are not interpreted; exact delimiter-bounded destructive markers produce explicit uncertain warnings instead.

The prompt can allow the displayed invocation once, allow all shell risks for the current runtime, or block with feedback. Print and JSON calls pass without state changes or notices. Recoverable clean tracked content and canonical OS-temp descendants outside the working tree may be omitted only when filesystem and Git evidence proves the effect safe. Dirty, untracked, ignored, missing, ambiguous, and inspection-failed targets remain promptable.

## Ordering and limits

Pipkin loads Sandbox, then Edit/write Approval, then Shell Guard. Sandbox runs first so a rejected filesystem call does not reach later approval prompts; the two approval gates see the chained input available at their handler position. Pi has no final read-only handler phase: a third-party extension loaded after Shell Guard can still mutate input. These are useful best-effort guardrails, not security boundaries, and they do not guarantee final approved bytes or discover effects absent from Pi's tool metadata.
