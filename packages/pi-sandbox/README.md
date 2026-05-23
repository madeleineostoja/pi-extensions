# Pi Sandbox

Filesystem and network policy enforcement for Pi agents.

## Platform support

The `nono` sandboxing binary is available for:

- **macOS arm64** (Apple Silicon)
- **macOS x86_64**
- **Linux glibc arm64**
- **Linux glibc x86_64**

On **Windows**, **Alpine Linux** (musl), **distroless**, and **BSDs**, `nono` is not available. The sandbox will run in in-process-only mode with a one-time warning.

### Binary status

At install time, `postinstall.js` writes `bin/.install-status.json`. At runtime, `getBinaryStatus()` reads this marker and cross-checks it against the binary on disk. The `reason` field of an `install-failed` status (and the matching field in the status marker) uses one of the following tags:

| Tag                        | Meaning                                                                                                                                                          |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `platform-unsupported`     | The current platform/arch combination has no pre-built `nono` binary. The `BinaryStatus` kind is `"platform-unsupported"` (not `"install-failed"`) in this case. |
| `sha256-fetch-failed`      | The `SHA256SUMS.txt` file could not be fetched from GitHub Releases, or the expected tarball entry was missing from it.                                          |
| `sha256-mismatch`          | The downloaded tarball's SHA-256 hash did not match the value from `SHA256SUMS.txt`.                                                                             |
| `binary-fetch-failed`      | The tarball download, extraction, or copy step failed.                                                                                                           |
| `sha256sums-hash-mismatch` | The SHA-256 hash of `SHA256SUMS.txt` itself did not match the expected value pinned in `package.json` (`nonoSha256SumsHash`).                                    |
| `download-skipped`         | `PI_SANDBOX_SKIP_DOWNLOAD=1` was set at install time. The runtime will fall back to a `nono` found on `$PATH`.                                                   |
| `marker-missing`           | No `bin/.install-status.json` was found (e.g. the package was installed before this feature, or the marker was deleted).                                         |
| `binary-missing-after-ok`  | The marker says the install succeeded, but the binary is no longer present (state drift).                                                                        |

### `enforcement.requireKernelSandbox`

When set to `true` in the policy config, `sandboxExtension` will refuse to start if the `nono` kernel sandbox binary is unavailable (i.e. `getBinaryStatus()` returns anything other than `{ kind: "ok" }`). An error notification is emitted and no `tool_call` or `user_bash` handler is registered, leaving the Pi instance untouched.

This is useful in high-security environments where running without kernel-level confinement is unacceptable. Default is `false`.

```jsonc
// ~/.pi/agent/sandbox.json  or  <cwd>/.pi/sandbox.json
{
  "enforcement": {
    "requireKernelSandbox": true,
  },
}
```

To recover after a failed install: `npm rebuild @earendil-works/pi-sandbox`. To acknowledge degraded mode instead: set `requireKernelSandbox` to `false`.

### Skipping the postinstall download

If you already have `nono` installed (via `brew install always-further/tap/nono`, `apt`, `nix`, `cargo`, etc.) and want to skip the postinstall download:

```sh
PI_SANDBOX_SKIP_DOWNLOAD=1 npm install
```

The runtime resolver will find your system `nono` via `$PATH`.

## Composition

pi-sandbox is a hard-enforcement layer. It blocks irreversibly. Policy mutation paths are: config files, `/sandbox` slash commands, and the `pi` lifecycle (extension init/reload). No in-loop agent action can relax it.

```
Agent tool call / user ! command
      │
      ▼
┌─────────────────────┐
│ sandbox entry gate  │  (in-process FS + user_bash)
│ block FS / wrap cmd │
└────────┬────────────┘
         │ allowed
         ▼
   tool/command executes
         │
         ▼
┌─────────────────────┐
│  nono kernel proxy  │  (subprocess spawns only)
│  host-allowlist /   │
│  path enforcement   │
└─────────────────────┘
         │ blocked → SIGKILL
```

**Event flow.** Sandbox emits `sandbox:audit` (and `sandbox:policy-changed` for policy mutations) on its `events` target. Any telemetry consumer may **listen** to these events for logging or escalation prompts. Listeners are purely read-only observers.

**pi-sandbox does not subscribe to `sandbox:*` events or any events from other extensions. Granting must go through slash commands or config files.**

## Event Schema Reference

All events are emitted on the `events` target passed to `recordAudit`. Consumer extensions subscribe using Pi's event API.

### `sandbox:audit`

Emitted for every audited tool call or policy change. The payload is a `SandboxAuditEvent`:

| Field        | Type                                               | Description                                                                                      |
| ------------ | -------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `ts`         | `number`                                           | Unix timestamp (ms)                                                                              |
| `kind`       | `"fs" \| "network" \| "exec" \| "policy-change"`   | Category of the audited action                                                                   |
| `decision`   | `"allowed" \| "blocked" \| "granted" \| "revoked"` | Enforcement outcome                                                                              |
| `rule`       | `string?`                                          | Rule that triggered the decision (e.g. `"denyPattern"`, `"allowList:read"`, `"allowList:write"`) |
| `tool`       | `string?`                                          | Pi tool name (e.g. `"read"`, `"bash"`)                                                           |
| `toolCallId` | `string?`                                          | Pi tool-call correlation ID                                                                      |
| `path`       | `string?`                                          | Filesystem path (for `kind: "fs"`)                                                               |
| `host`       | `string?`                                          | Hostname (for `kind: "network"`)                                                                 |
| `scope`      | `"session" \| "persisted"?`                        | Policy mutation scope (for `kind: "policy-change"`)                                              |
| `source`     | `"config" \| "command" \| \`ext:${string}\`?`      | What triggered a policy change                                                                   |

**Examples by `kind × decision`:**

```jsonc
// kind=fs, decision=allowed
{ "ts": 1700000000000, "kind": "fs", "decision": "allowed", "tool": "read", "path": "/home/user/project/src/index.ts" }

// kind=fs, decision=blocked
{ "ts": 1700000000001, "kind": "fs", "decision": "blocked", "tool": "read", "path": "/etc/passwd", "rule": "allowList:read" }

// kind=network, decision=allowed
{ "ts": 1700000000002, "kind": "network", "decision": "allowed", "host": "api.github.com" }

// kind=network, decision=blocked
{ "ts": 1700000000003, "kind": "network", "decision": "blocked", "host": "evil.example.com" }

// kind=exec, decision=allowed
{ "ts": 1700000000004, "kind": "exec", "decision": "allowed", "tool": "bash" }

// kind=exec, decision=blocked
{ "ts": 1700000000005, "kind": "exec", "decision": "blocked", "tool": "bash" }

// kind=policy-change, decision=granted
{ "ts": 1700000000006, "kind": "policy-change", "decision": "granted", "scope": "session", "source": "command" }

// kind=policy-change, decision=revoked
{ "ts": 1700000000007, "kind": "policy-change", "decision": "revoked", "scope": "persisted", "source": "command" }
```

### `sandbox:policy-changed`

Emitted in addition to `sandbox:audit` whenever `kind === "policy-change"`. The payload is a `SandboxPolicyChangedEvent`:

| Field    | Type                                          | Description                                           |
| -------- | --------------------------------------------- | ----------------------------------------------------- |
| `ts`     | `number`                                      | Unix timestamp (ms)                                   |
| `scope`  | `"session" \| "persisted"?`                   | Whether the change is session-only or written to disk |
| `source` | `"config" \| "command" \| \`ext:${string}\`?` | What triggered the change                             |

```jsonc
// scope=session, source=command  (e.g. /sandbox allow api.example.com)
{ "ts": 1700000000008, "scope": "session", "source": "command" }

// scope=persisted, source=command  (e.g. /sandbox allow --persist api.example.com)
{ "ts": 1700000000009, "scope": "persisted", "source": "command" }
```

### TypeScript types

Both event types are exported from the package entrypoint for type-safe consumers:

```ts
import type {
  SandboxAuditEvent,
  SandboxPolicyChangedEvent,
} from "@earendil-works/pi-sandbox";
```

## Threat model

The in-process tool gate intercepts Pi's built-in filesystem tools (`read`, `write`, `edit`, `ls`, `find`, `grep`). User-typed `!cmd` and `!!cmd` shell pass-through commands are routed through the same `nono` subprocess confinement as bash execution. Two deliberate limitations are worth noting:

**In-process `fetch()` / HTTP calls from extension code are not enforced by the in-process gate.** Extensions are treated as trusted code.

**The in-process gate has a TOCTOU window.** Pi may evaluate a path between this gate's policy check and the actual filesystem operation. The kernel layer (`nono`) is the authoritative containment boundary for subprocess commands and is not subject to this race. The in-process gate is a defence-in-depth measure, not a security guarantee.

**Deny pattern enforcement varies by platform.** On macOS, deny patterns whose literal prefix can be extracted are pushed down to the Seatbelt sandbox for subprocess containment. Glob-only patterns (e.g. `**/.env` with no anchored root) are enforced exclusively by the in-process gate. On Linux, Landlock is allow-only and all deny patterns are enforced exclusively by the in-process gate.

**Sandbox confines subprocesses and Pi's in-process tools. It does not protect against JS-side network calls (`fetch()`) from extension code itself — extensions are trusted code.**

## Usage

### File-based auto-discovery (recommended)

Drop a thin wrapper file at `~/.pi/agent/extensions/sandbox.ts` (global) or `.pi/extensions/sandbox.ts` (project-local). Pi picks it up automatically on startup and on `/reload`:

```ts
// ~/.pi/agent/extensions/sandbox.ts
export { default } from "@earendil-works/pi-sandbox";
```

No other wiring is needed. `sandboxExtension` accepts the `pi` instance and an `ExtensionContext` automatically.

### Programmatic loading (embedders)

If you are embedding Pi via the SDK, pass the extension factory through `DefaultResourceLoader`:

```ts
import {
  createAgentSession,
  DefaultResourceLoader,
} from "@earendil-works/pi-coding-agent";
import sandboxExtension from "@earendil-works/pi-sandbox";

const loader = new DefaultResourceLoader({
  extensionFactories: [sandboxExtension],
});
await loader.reload();

const { session } = await createAgentSession({ resourceLoader: loader });
```

For the full extension loading API see the [Pi extensions docs](https://www.npmjs.com/package/@earendil-works/pi-coding-agent).

### Config file locations

Policy is loaded from two optional files, merged in order (project overrides user-global):

- `~/.pi/agent/sandbox.json` — user-global policy
- `<cwd>/.pi/sandbox.json` — project-local policy

### Minimal config example

```jsonc
// ~/.pi/agent/sandbox.json  or  <cwd>/.pi/sandbox.json
{
  "fs": {
    "allowRead": ["~", "<cwd>"],
    "allowWrite": ["<cwd>"],
    "denyPatterns": ["**/.env", "**/.env.*"],
  },
  "network": {
    "allow": ["api.github.com", "registry.npmjs.org"],
  },
}
```

Only the fields you specify are overridden; omitted fields keep their built-in defaults.

### Runtime control

Use the `/sandbox` slash command family to inspect and mutate policy at runtime without restarting Pi:

| Command                           | Effect                                               |
| --------------------------------- | ---------------------------------------------------- |
| `/sandbox status`                 | Show current policy summary and binary status        |
| `/sandbox allow <host>`           | Allow a host for this session                        |
| `/sandbox allow --persist <host>` | Allow a host and write it to the project config file |
| `/sandbox revoke <host>`          | Remove a session-granted host                        |
| `/sandbox off`                    | Disable sandbox enforcement for this session         |
| `/sandbox on`                     | Re-enable after `/sandbox off`                       |
| `/sandbox reload`                 | Re-read config files without restarting Pi           |
| `/sandbox why <tool> <path>`      | Explain why a tool call would be allowed or blocked  |

## Configuration

Policy is loaded from up to two JSON (or JSONC) files and merged in this order:

1. Built-in defaults (see `src/policy/defaults.ts`)
2. `~/.pi/agent/sandbox.json` — user-global overrides
3. `<cwd>/.pi/sandbox.json` — project-local overrides

Each layer only needs to specify the fields it wants to override; omitted fields retain their value from the previous layer.

### Array replacement

Arrays are **replaced**, not merged. If a project config sets `network.allow` to `["internal.corp"]`, the full default allowlist is discarded and only `"internal.corp"` is active. The same applies to `fs.allowRead`, `fs.allowWrite`, and `fs.denyPatterns`.

### Path expansion

String values in path fields support three expansion tokens, applied at load time:

- `<cwd>` — expands to the working directory passed to `loadPolicy`
- `~` — expands to the user's home directory
- `$VAR` / `$VAR_NAME` — expands to the value of the named environment variable; left unchanged if the variable is unset
