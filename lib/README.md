# @pi-extensions/lib

Shared runtime helpers for the pi-extensions workspace. The package exports an OS-backed file lease and a serialized Git `info/exclude` updater used by extensions that coordinate checkout-local state.

## File leases

`acquireFileLease`, `tryAcquireFileLease`, and `probeFileLease` operate on a persistent regular-file anchor.

```ts
import { acquireFileLease } from "@pi-extensions/lib";

const lease = await acquireFileLease("/checkout/.pi/example.lock", {
  timeoutMs: 10_000,
});
try {
  // Perform the protected mutation.
} finally {
  await lease.release();
}
```

- `tryAcquireFileLease(anchor)` acquires immediately or returns `undefined` when another holder owns the lease.
- `acquireFileLease(anchor, { timeoutMs, signal? })` retries until the bound expires or the signal aborts.
- `probeFileLease(anchor)` reports `"free"` or `"held"` for diagnostics only. It never authorizes mutation.
- `release()` is idempotent and owns both unlock and descriptor close. Keep the returned lease capability; do not infer ownership from a path, PID, timestamp, or sidecar file.

The adapter opens the anchor without truncating, renaming, replacing, or deleting it. Kernel descriptor closure releases a live lease when its process exits. Supported platforms are macOS and Linux on ARM64 and x64. Lease operations fail closed with an actionable error when the native addon cannot load or the platform is unsupported; importing unrelated shared helpers remains safe.

Create parent directories before acquiring a lease. Keep the anchor after release and never use a probe result as permission to write.

## Git `info/exclude`

`ensureGitInfoExclude(cwd, patterns)` resolves the repository's common Git directory, then serializes an atomic read-modify-write of `info/exclude` under its own persistent common-directory lease.

```ts
import { ensureGitInfoExclude } from "@pi-extensions/lib";

await ensureGitInfoExclude(process.cwd(), "/.pi/example/");
```

The helper accepts one pattern or a non-empty array of single-line patterns. It preserves unrelated entries, normalizes requested entries to one occurrence, and safely coordinates linked checkouts and extensions that share Git metadata. Call it instead of directly editing `info/exclude`; callers must not add their own lock-file deletion, stale-owner recovery, or unguarded read-modify-write protocol.
