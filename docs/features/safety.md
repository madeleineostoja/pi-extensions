# Safety

Pipkin keeps three different kinds of watch while an agent works: Sandbox defines where work may happen, Edit Approval keeps ordinary source changes visible, and Shell Guard pauses risky command-line actions. They are loaded in that order and are designed to overlap.

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

## Edit Approval: keep source changes visible

Edit Approval starts on in fresh interactive sessions and intercepts Pi's built-in `edit` and `write` tools. A proposal can be accepted once, accepted for the rest of the session, or blocked with steering feedback.

Toggle it with:

```text
/readonly
/readonly on
/readonly off
```

`Ctrl+R` is the default shortcut, and the footer shows `readonly` or `editing`.

State survives reload and resume but resets to on for startup, new sessions, and forks. There is no configuration file or per-path exemption. Shell redirects and other writes performed through `bash` do not pass through this approval hook.

Print, RPC, and other non-interactive modes cannot display the prompt, so Edit Approval disables itself and emits a one-time status message.

## Shell Guard: pause before destructive commands

Shell Guard watches built-in `bash` calls for high-risk actions. A prompt can allow once, allow that risk category for the session, allow everything for the session, or block with feedback.

It covers high-signal cases including:

- untracked or dirty file removal and destructive `find` / `xargs` forms;
- Git loss, force pushes, remote ref deletion, stash loss, and aggressive cleanup;
- overwrite and truncation through redirects, `dd`, `truncate`, `sed -i`, `mv`, or `cp`;
- recursive permission damage and destructive sync;
- inline interpreter deletion escapes and remote scripts piped to a shell;
- container, volume, and image cleanup;
- global or system package mutations;
- GitHub CLI mutations;
- Terraform, OpenTofu, Pulumi, and high-signal destructive AWS operations;
- package publishing and production deploy commands.

Shell Guard is deliberately heuristic. It allows deletion of clean tracked files because Git can restore them and narrowly scoped disposable temp cleanup. Shell variables, globs, substitutions, pipelines, and compound syntax can produce false positives or evade detection. It does not cover every provider CLI, scan secrets, enforce path boundaries, or gate normal `edit` and `write` calls.

Like Edit Approval, it disables itself with a status message when no interactive prompt can be shown.
