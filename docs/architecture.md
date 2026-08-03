# Architecture

Pipkin is one product with several runtime owners. The split entrypoints are there to make registration, lifecycle, ordering, and failure boundaries explicit—not to turn each feature into a separately supported package.

## The ordered bundle

The root manifest loads the complete bundle in this order:

1. Sandbox
2. Readonly
3. Context
4. UI
5. Personality
6. LSP
7. Subagents
8. Implement
9. Reference
10. Papercuts
11. BTW

Order is a runtime contract. Sandbox then Readonly form the safety prefix: Sandbox owns model Bash and direct workspace-write containment; Readonly retains the independent edit/write workflow. Subagents precedes Implement because Implement consumes its managed runtime.

The bundle integration suite loads the actual manifest through Pi's loader. It checks inventory, public registration ownership, source provenance, internal imports, startup/reload behavior, and safety ordering rather than recreating extension discovery in test code.

## Source ownership

Each feature owns a Pi-only registration root at `src/extensions/<feature>/index.ts`. It only constructs dependencies, performs Pi registration, attaches lifecycle/event handlers, and provides simple wiring. Business behavior and substantial handlers live in responsibility-named feature modules. Feature code uses relative imports internally and does not import another feature's registration root.

Feature subfolders represent established cohesive clusters rather than a universal template. Implement currently has only `scheduler/` and `recovery/` clusters; features do not gain generic `internal/`, `src/`, `api/`, or wrapper layers for symmetry.

Generic modules shared by at least two features live in `src/lib/`. There is no barrel: consumers import the concrete capability through `#lib/*`, which keeps dependencies visible.

`#sandbox/runtime` is a Sandbox-owned capability consumed by Subagents to snapshot the invoking session's Sandbox mode for a child. `#sandbox/bash` is a separate narrow Sandbox-owned execution capability consumed by Context's `bash_outcome`: it invokes the current host's ordinary Bash path but exposes neither a tool definition nor mutable Sandbox state. `#subagents/runtime` is consumed by Implement for the managed runtime. `#ui/activity` is a UI-owned event protocol consumed by Subagents and Implement; it binds each publisher source and leaves records, generations, timers, and widgets with the UI registration. `#ui/status` is a UI-owned stateless capability consumed by footer-status producers: it validates and immediately publishes through the producer's current UI without retaining producer state, importing a producer, or registering the UI extension. Shared chrome and metric presentation modules remain concrete `#lib/ui/*` imports. Neither consumer imports or registers the producer's extension root. A new mapping needs a real consumer, a narrow producer-owned type, an acyclic graph, package-import declaration, loader and TypeScript coverage, and an update to this document and repository guidance.

UI owns generic presentation only: its Activity protocol projects bounded source-owned records without transcript content, commands, cwd, raw output, hidden runtime objects, or cost/token telemetry; its status capability is stateless and producer-owned. Personality owns voice and identity, including the synchronous fresh-session Welcome header. UI never imports a producer implementation or registration root.

## Separate loaders, explicit coordination

Pi loads entrypoints through separate Jiti instances. Code may share pure helpers and typed protocols, but it must not rely on mutable module-singleton identity crossing those loader graphs.

Subagents' coordinator and Sandbox's child-mode handoff are explicit exceptions: both are keyed by Pi's event bus, which gives them stable host identity across runtime reload boundaries. The Bash execution capability uses the same explicit host identity with a generation-scoped binding: Sandbox installs the final executor only after constructing the session runtime and revokes it before state reset and process disposal. Each managed child receives a distinct event bus, so its extension lifecycle and runtime remain isolated from its parent. Sandbox records the parent's current mode against that child bus before construction and consumes it at child startup; this is a spawn-time snapshot, not live synchronization.

## Files shared by concurrent features

`src/lib/file-lease.ts` provides OS-backed leases over persistent regular-file anchors. A caller keeps the returned lease capability and releases it idempotently. Probing is diagnostic only; it never grants permission to mutate. The native adapter fails closed when it cannot provide the contract.

`src/lib/git.ts` serializes atomic updates to a repository's common `.git/info/exclude` under its own lease. Checkout-local features call `ensureGitInfoExclude()` instead of editing the file directly or inventing another lock protocol. This coordinates linked worktrees without touching committed `.gitignore`.

## Lifecycle

Long-lived resources start at `session_start` or on demand and dispose idempotently at `session_shutdown`. Features that subscribe directly to `pi.events` remove those listeners during disposal. Sandbox host bindings and pending child handoffs are likewise disposed idempotently.

State belongs to the narrowest durable owner:

- transient UI and agent activity belongs to the session;
- Implement state belongs to a checkout, while Papercuts belongs to its canonical primary worktree;
- policy that varies by repository belongs under that worktree's `.pi/pipkin/`;
- personal model routing and logs belong under Pi's agent directory.

See [Configuration and state](configuration.md) for concrete paths.

## Testing boundaries

Feature and generic-library tests stay adjacent to their behavior owner and never import an entrypoint. Root Vitest projects isolate suites and preserve Implement's serialized execution policy. `test/bundle/` is the integration contract for the assembled product and owns entrypoint loading and registration provenance; it catches failures that isolated imports cannot: loader resolution, bundle inventory, lifecycle order, and unsupported package-era topology.
