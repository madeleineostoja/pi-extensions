# Repository Guidelines

## Product and structure

- Pipkin is one root npm package and one complete ordered `package.json#pi.extensions` bundle. Features are runtime owners, not independently distributed products; filtered entrypoint subsets are unsupported.
- Feature source and adjacent tests live in `src/extensions/<feature>/`. Each feature has a Pi-only `index.ts` registration root containing only dependency construction, registration, lifecycle/event hookup, and simple wiring.
- Business behavior and substantial handlers belong in responsibility-named feature modules. Feature tests import those owners, never an `index.ts`; `test/bundle/` owns entrypoint loading and registration provenance.
- Keep tests beside their behavior owner. Add a feature subfolder only for an established cohesive cluster; do not impose universal `internal/`, `src/`, `api/`, or wrapper layers.
- Shared generic modules and adjacent tests live in `src/lib/`. It is a bottom layer with no barrel.
- Bundle integration tests live in `test/bundle/`. User-facing documentation is concept-oriented under `docs/` and `docs/features/`.

## Scope

- This is for personal use by one user. When carrying out solution design you do not need to account for general user adoption, configurability, maintaining backwards compatibility, etc

## Imports and ownership

- Use relative imports within a feature.
- Import concrete generic helpers through `#lib/*`, for example `#lib/file-lease`.
- `#sandbox/runtime` lets Subagents snapshot Sandbox session-mode inheritance. `#subagents/runtime` lets Implement consume the managed agent runtime. Production code must not import another feature's `index.ts` or an unlisted extension internal.
- Direct capability coupling is allowed only when the producer owns the capability, the dependency is narrow and typed, the graph is acyclic, and the import neither registers an extension nor assumes mutable module-singleton identity.
- Add a new cross-feature mapping only after there is a real consumer. Define the narrow source-owned capability, add its `package.json#imports` mapping, cover Pi Jiti/Vitest/TypeScript resolution, document the dependency here and in `docs/architecture.md`, and keep the producer registration root private.
- Keep feature-specific code with its owner. Add a `src/lib` module only when at least two features need it.

## Lifecycle

- Pi loads entrypoints through separate Jiti instances. Share pure helpers and explicit capability modules, not mutable module singletons.
- Start long-lived resources at `session_start` or on demand. Dispose them idempotently at `session_shutdown`.
- Explicitly remove direct `pi.events` listeners during disposal. Stateful cross-entrypoint coordination needs an explicit host identity; the Subagents coordinator and Sandbox child-mode handoff are event-bus-keyed exceptions.

## Commands

Use `npm` from the repository root.

- Install: `npm install`
- Typecheck: `npm run check`
- Lint: `npm run lint`
- Format: `npm run format`
- Check formatting: `npm run format:check`
- Tests: `npm run test`

Vitest projects run adjacent feature/library tests and the root bundle contract. Keep Implement's serialized project intact; do not flatten all tests into one unisolated realm.

## Development workflow

- To add a feature, create `src/extensions/<feature>/index.ts`, add it in its intentional position to `package.json#pi.extensions`, add adjacent behavior tests, extend `test/bundle/` if public registrations or ordering change, and update the relevant concept guide plus the root README.
- Root registration order is a runtime contract. Sandbox and Readonly lead the bundle; Subagents precedes Implement.
- Prefer root-level validation before handoff. For TypeScript changes, run the narrowest relevant test and `npm run check`; run bundle tests when manifest entries, registrations, internal imports, or lifecycle ordering change.
- If changing Pi extension APIs or TUI integrations, verify against the local Pi docs referenced in the harness instructions rather than relying on memory.
