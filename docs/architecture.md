# Architecture

Pipkin is one product with several runtime owners. The split entrypoints are there to make registration, lifecycle, ordering, and failure boundaries explicit—not to turn each feature into a separately supported package.

## The ordered bundle

The root manifest loads the complete bundle in this order:

1. Guard
2. Readonly
3. Context
4. UI
5. Personality
6. LSP
7. Subagents
8. Implement
9. Papercuts
10. BTW
11. Caffeinate

Order is a runtime contract. Guard then Readonly form the safety prefix: Guard owns Bash, filesystem/protected decisions, and semantic confirmation; Readonly retains the independent edit/write workflow. Subagents precedes Implement because Implement consumes its managed runtime.

The bundle integration suite loads the actual manifest through Pi's loader. It checks inventory, public registration ownership, source provenance, internal imports, startup/reload behavior, and safety ordering rather than recreating extension discovery in test code.

## Source ownership

Each feature owns a Pi-only registration root at `src/extensions/<feature>/index.ts`. It only constructs dependencies, performs Pi registration, attaches lifecycle/event handlers, and provides simple wiring. Business behavior and substantial handlers live in responsibility-named feature modules. Feature code uses relative imports internally and does not import another feature's registration root.

Feature subfolders represent established cohesive clusters rather than a universal template. Implement currently has only `scheduler/` and `recovery/` clusters; features do not gain generic `internal/`, `src/`, `api/`, or wrapper layers for symmetry.

Generic modules shared by at least two features live in `src/lib/`. There is no barrel: consumers import the concrete capability through `#lib/*`, which keeps dependencies visible.

`#subagents/runtime` is the only declared cross-feature capability. Implement consumes Subagents' managed runtime without importing or registering its extension root. A new mapping needs a real consumer, a narrow producer-owned type, an acyclic graph, package-import declaration, loader and TypeScript coverage, and an update to this document and repository guidance.

## Separate loaders, explicit coordination

Pi loads entrypoints through separate Jiti instances. Code may share pure helpers and typed protocols, but it must not rely on mutable module-singleton identity crossing those loader graphs.

Subagents is the existing explicit exception: its coordinator is keyed by Pi's event bus, which gives it a stable host identity across runtime reload boundaries.

## Files shared by concurrent features

`src/lib/file-lease.ts` provides OS-backed leases over persistent regular-file anchors. A caller keeps the returned lease capability and releases it idempotently. Probing is diagnostic only; it never grants permission to mutate. The native adapter fails closed when it cannot provide the contract.

`src/lib/git.ts` serializes atomic updates to a repository's common `.git/info/exclude` under its own lease. Checkout-local features call `ensureGitInfoExclude()` instead of editing the file directly or inventing another lock protocol. This coordinates linked worktrees without touching committed `.gitignore`.

## Lifecycle

Long-lived resources start at `session_start` or on demand and dispose idempotently at `session_shutdown`. Features that subscribe directly to `pi.events` remove those listeners during disposal.

State belongs to the narrowest durable owner:

- transient UI and agent activity belongs to the session;
- Papercuts and Implement state belongs to a checkout;
- policy that varies by repository belongs under that checkout's `.pi/pipkin/`;
- personal model routing and logs belong under Pi's agent directory.

See [Configuration and state](configuration.md) for concrete paths.

## Testing boundaries

Feature and generic-library tests stay adjacent to their behavior owner and never import an entrypoint. Root Vitest projects isolate suites and preserve Implement's serialized execution policy. `test/bundle/` is the integration contract for the assembled product and owns entrypoint loading and registration provenance; it catches failures that isolated imports cannot: loader resolution, bundle inventory, lifecycle order, and unsupported package-era topology.
