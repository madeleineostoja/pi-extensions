# pi-sandbox

Keep Pi agents inside the boundaries you set.

`pi-sandbox` limits what an agent can read, write, execute, and reach on the network. It is designed for day-to-day agent work: let the agent inspect and modify the current project, allow the package registries you use, and keep secrets and unrelated parts of your machine out of reach.

It uses two layers:

- an in-process gate for Pi's filesystem tools (`read`, `write`, `edit`, `ls`, `find`, `grep`)
- [`nono`](https://github.com/always-further/nono) for shell commands and other subprocess execution

## Quick start

If this package is installed through `pi install`, Pi loads the extension automatically. Start Pi in a project and check the current state:

```text
/sandbox status
```

Add project-specific policy in `.pi/sandbox.json`:

```json
{
  "fs": {
    "allowRead": [
      "<cwd>",
      "/usr",
      "/etc",
      "/opt",
      "/Library/Developer",
      "/private/etc"
    ],
    "allowWrite": ["<cwd>"],
    "denyPatterns": ["<cwd>/**/.env", "<cwd>/**/.env.*", "~/.ssh/**"]
  },
  "network": {
    "mode": "non-interactive-only",
    "allow": ["github.com", "*.github.com", "registry.npmjs.org"]
  }
}
```

Reload without restarting Pi:

```text
/sandbox reload
```

Ask why something would be allowed or blocked:

```text
/sandbox why .env
/sandbox why api.github.com
```

## What is protected?

### Filesystem tools

Pi's built-in filesystem tools are checked before they run:

| Tool                         | Required access |
| ---------------------------- | --------------- |
| `read`, `ls`, `find`, `grep` | read            |
| `write`                      | write           |
| `edit`                       | read and write  |

A path must be under the relevant allowlist and must not match a deny pattern.

### Shell commands and subprocesses

Agent `bash`, user `!` / `!!` commands, and extension subprocesses that go through `pi.exec` run under `nono` when the binary is available. The generated `nono` policy mirrors the configured filesystem and network rules.

If `nono` is not available, subprocess execution is blocked by default. Set `degraded.allowExec: true` only if you are comfortable running shell commands without kernel-level confinement.

### Network access

Network filtering applies to sandboxed subprocesses. It does not inspect trusted extension code making JavaScript-side `fetch()` or HTTP calls inside the Pi process.

`network.mode` controls when the network allowlist is passed to `nono`:

| Mode                   | Behaviour                                              |
| ---------------------- | ------------------------------------------------------ |
| `non-interactive-only` | enforce the allowlist in non-interactive sessions only |
| `always`               | enforce the allowlist in every session                 |
| `off`                  | do not filter subprocess network access                |

Allowed hosts are exact names (`api.github.com`) or wildcard subdomains (`*.github.com`). Wildcards do not match the apex domain, so allow both `github.com` and `*.github.com` if you need both.

## Day-to-day commands

| Command                                     | Effect                                           |
| ------------------------------------------- | ------------------------------------------------ |
| `/sandbox`                                  | Show the full policy summary                     |
| `/sandbox status`                           | Show compact status                              |
| `/sandbox why <path or host>`               | Explain an allow/block decision                  |
| `/sandbox allow host <host>`                | Allow a host for this session                    |
| `/sandbox allow host --persist <host>`      | Add a host to the project config                 |
| `/sandbox allow host --persist=user <host>` | Add a host to the user config                    |
| `/sandbox allow read <path>`                | Allow read access to a path for this session     |
| `/sandbox allow write <path>`               | Allow write access to a path for this session    |
| `/sandbox revoke host <host>`               | Remove a session host grant                      |
| `/sandbox revoke host --persist <host>`     | Remove a host from persisted config              |
| `/sandbox revoke read <path>`               | Remove a session read grant                      |
| `/sandbox revoke write <path>`              | Remove a session write grant                     |
| `/sandbox network off`                      | Disable network filtering for this session       |
| `/sandbox network on`                       | Re-enable network filtering from config          |
| `/sandbox off`                              | Disable all sandbox enforcement for this session |
| `/sandbox on`                               | Re-enable sandbox enforcement                    |
| `/sandbox reload`                           | Re-read config files                             |

Session changes are temporary. Persisted host changes are written to `.pi/sandbox.json` or `~/.pi/agent/extensions/pi-sandbox/config.json`.

In TUI sessions, in-process filesystem tools prompt on read/write allowlist misses. Deny-pattern matches never prompt. Prompt grants can allow the path once, allow the path for this session, or allow the parent directory for this session; session grants have the same effect as the matching `/sandbox allow read|write <path>` command.

## Configuration

Policy is loaded in this order:

1. built-in defaults
2. `~/.pi/agent/extensions/pi-sandbox/config.json`
3. `<cwd>/.pi/sandbox.json`

Project config overrides user config. You only need to specify fields you want to change.

### Full shape

```json
{
  "enabled": true,
  "fs": {
    "allowRead": [
      "<cwd>",
      "/usr",
      "/etc",
      "/opt",
      "/Library/Developer",
      "/private/etc"
    ],
    "allowWrite": ["<cwd>", "~/.cache/pi", "~/.pi/agent/logs"],
    "denyPatterns": ["<cwd>/**/.env", "~/.ssh/**"]
  },
  "network": {
    "mode": "non-interactive-only",
    "allow": ["github.com", "*.github.com"]
  },
  "audit": {
    "log": true,
    "logFile": "~/.pi/agent/logs/sandbox-audit.jsonl"
  },
  "enforcement": {
    "requireKernelSandbox": false
  },
  "degraded": {
    "allowExec": false
  }
}
```

### Paths

Path fields support:

- `<cwd>` for the current Pi working directory
- `~` for your home directory
- `$VAR` / `$VAR_NAME` for environment variables

Arrays are replaced, not merged. For example, if project config sets `network.allow`, it replaces the default host list.

### Important options

- `enabled: false` disables the sandbox from config.
- `fs.allowRead` controls where agents can inspect files. The OS temp directory is always allowed.
- `fs.allowWrite` controls where agents can write or edit files. The OS temp directory is always allowed.
- `fs.denyPatterns` wins over allowlists and is a good place for secrets.
- `network.allow` is the subprocess network allowlist.
- `audit.log` writes JSONL audit entries to `audit.logFile`.
- `enforcement.requireKernelSandbox: true` refuses to start the extension unless `nono` is available.
- `degraded.allowExec: true` allows shell/subprocess execution when `nono` is unavailable.

## `nono` binary support

The packaged `nono` binary is downloaded at install time on:

- macOS arm64 and x86_64
- Linux glibc arm64 and x86_64

Windows, Alpine/musl Linux, distroless images, and BSDs do not currently receive a packaged binary. On those platforms, pi-sandbox falls back to any `nono` on `$PATH`; otherwise it runs with in-process filesystem protection only and blocks subprocess execution unless `degraded.allowExec` is enabled.

To skip the install-time download and use your own `nono`:

```sh
PI_SANDBOX_SKIP_DOWNLOAD=1 npm install
```

At runtime, the status bar shows `sandbox (degraded)` when Pi is running without the kernel sandbox.

## Audit events

Sandbox decisions and policy changes are emitted as `sandbox:audit`. Policy changes are also emitted as `sandbox:policy-changed`. Other extensions can listen to these events for logging or prompts; pi-sandbox itself does not accept grants from events.

Audit logs are JSONL when enabled:

```json
{ "ts": 1700000000000, "kind": "fs", "decision": "blocked", "tool": "read", "path": "/repo/.env", "rule": "denyPattern" }
{ "ts": 1700000000001, "kind": "exec", "decision": "allowed", "tool": "bash" }
{ "ts": 1700000000002, "kind": "policy-change", "decision": "granted", "scope": "session", "source": "command", "host": "api.example.com" }
```

## Limitations

- Extensions are trusted code. JavaScript-side network calls from extension code are not sandboxed.
- The in-process filesystem gate is defence in depth and has the usual time-of-check/time-of-use race. Kernel confinement is authoritative for subprocesses.
- On Linux, `nono`/Landlock is allowlist-oriented, so deny glob patterns are enforced by the in-process gate.
- On macOS, deny patterns with a literal prefix can be pushed into Seatbelt for subprocesses; unanchored glob-only patterns are in-process only.

## License

MIT
