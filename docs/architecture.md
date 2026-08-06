# Architecture

Pipkin is one product with several runtime owners. Split entrypoints make registration, lifecycle, ordering, and failure boundaries explicit; they are not separately supported packages.

## Ordered bundle

The root manifest loads one complete bundle:

1. Sandbox
2. Readonly
3. Context
4. UI
5. Personality
6. Guidance
7. LSP
8. Processes
9. Subagents
10. Implement
11. Reference
12. Web Fetch
13. Papercuts
14. BTW

Order is a runtime contract. Sandbox and Readonly form the safety prefix. Processes follows LSP and precedes Subagents; Subagents precedes Implement because Implement consumes its managed runtime. Web Fetch follows Reference while retaining separate ownership of direct public-URL retrieval.

The bundle integration suite loads the actual manifest through Pi's loader and verifies inventory, public registration ownership, source provenance, startup and reload behavior, internal imports, and safety ordering.

## Source ownership

Each feature owns a Pi-only registration root at `src/extensions/<feature>/index.ts`. It constructs dependencies, registers with Pi, attaches lifecycle or event handlers, and performs simple wiring. Business behavior and substantial handlers live in responsibility-named modules beside their tests.

Feature subfolders represent cohesive clusters, not a universal template. Implement currently has a `scheduler/` cluster; features do not gain generic `internal/`, `src/`, `api/`, or wrapper layers for symmetry.

Generic modules used by at least two features live in `src/lib/`. There is no barrel: consumers import concrete capabilities through `#lib/*`.

## Cross-feature capabilities

Cross-feature coupling is explicit, narrow, typed, and producer-owned.

| Capability                  | Owner          | Consumers                       | Purpose                                                                               |
| --------------------------- | -------------- | ------------------------------- | ------------------------------------------------------------------------------------- |
| `#sandbox/runtime`          | Sandbox        | Subagents                       | Snapshot Sandbox state and requested child write mode at child creation               |
| `#sandbox/bash`             | Sandbox        | Context, Processes              | Run ordinary Bash or start a managed execution lease without exposing Sandbox state   |
| `#context/retained-result`  | Context        | Processes                       | Encode and decode side-effect-free recallable result envelopes                        |
| `#subagents/runtime`        | Subagents      | Implement                       | Run trusted managed agents                                                            |
| `#subagents/completion`     | Subagents      | Implement                       | Share the stateless managed-completion final-action protocol                          |
| `#personality/session-name` | Personality    | Implement                       | Generate session names and carry the event-bus-keyed Implement naming-ownership claim |
| `#ui/activity`              | UI             | Processes, Subagents, Implement | Publish bounded source-qualified live activity                                        |
| `#ui/status`                | UI             | Status producers                | Publish immediate footer status without transferring producer ownership               |
| `#lib/ui/*`                 | Shared library | UI consumers                    | Reuse concrete presentation helpers                                                   |

Consumers never import another feature's registration root. A new mapping requires a real consumer, an acyclic dependency, a narrow producer-owned type, a `package.json#imports` declaration, Pi Jiti/Vitest/TypeScript resolution coverage, and updates to this guide and `AGENTS.md`.

Guidance owns persistent summaries for Pipkin's public tools, cross-tool strategy, and the external-content instruction boundary. Feature descriptions and schemas retain capability details; result owners retain recovery instructions. Its catalogue is static test data, not a registration API.

UI owns generic presentation, not producer state, cleanup, or terminal delivery. Activity is a bounded live-work projection: producers publish only queued, running, or waiting records and remove them immediately at settlement. It omits prompts, commands, cwd, raw output, hidden runtime objects, provider payloads, cost, and aggregate token telemetry; Subagents may project current context usage and one bounded latest-assistant preview. Personality owns voice and identity, including the asynchronous-context fresh-session welcome and naming generation; Implement owns active-run lifecycle and applies its authoritative name.

## Separate loaders and explicit coordination

Pi loads entrypoints through separate Jiti instances. Shared pure helpers and typed protocols are safe; mutable module-singleton identity across loader graphs is not.

Stateful cross-entrypoint coordination uses an explicit host identity:

- Subagents' coordinator, Sandbox's child-mode handoff, and Personality's Implement naming-ownership claim are keyed by Pi's event bus.
- Sandbox installs its Bash executor only after constructing the session runtime and revokes it during shutdown.
- Each child receives a distinct event bus and isolated Processes runtime.
- Child Sandbox policy is a spawn-time snapshot, not live synchronization.

On enabled macOS sessions, repository-read-only children deny writes to their workspace or worktree, worktree Git directory, and common Git directory after dynamic Seatbelt allows. Linux has no kernel enforcement. This is trusted-agent accidental-write protection, not hostile-code isolation.

## Shared concurrent files

`src/lib/file-lease.ts` provides OS-backed leases over persistent regular-file anchors. Probing is diagnostic only and never grants mutation authority; the native adapter fails closed when it cannot provide the contract.

`src/lib/git.ts` serializes updates to the repository's common `.git/info/exclude`. Checkout-local features call `ensureGitInfoExclude()` instead of editing the file directly or inventing another lock.

## Lifecycle and state

Long-lived resources start at `session_start` or on demand and dispose idempotently at `session_shutdown`. Features remove direct `pi.events` listeners during disposal. Sandbox bindings and pending child handoffs are also disposed idempotently.

State belongs to the narrowest durable owner:

- UI and agent activity belongs to the session;
- Implement state belongs to a checkout;
- Papercuts belongs to the canonical primary worktree;
- repository policy belongs under `.pi/pipkin/`;
- personal model routing, Reference credentials, and logs belong under Pi's agent directory.

See [Configuration and state](configuration.md) for concrete paths.

## Testing boundaries

Feature and shared-library tests stay beside their behavior owners and never import an entrypoint. Root Vitest projects isolate suites and preserve Implement's serialized execution policy.

`test/bundle/` owns the assembled-product contract. It catches failures isolated imports cannot: Pi loader resolution, extension inventory, registration provenance, lifecycle order, and unsupported package topology.
