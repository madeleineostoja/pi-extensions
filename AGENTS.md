# Repository Guidelines

## Structure

- Root `package.json` defines the single Pipkin package and the complete ordered `pi.extensions` bundle.
- Feature source and adjacent tests live in `src/extensions/<feature>/`; every feature has an `index.ts` Pi registration root.
- Shared generic modules and adjacent tests live in `src/lib/`. It has no barrel.
- User-facing feature documentation lives in `docs/features/`.

## Internal imports

- Use relative imports within a feature.
- Import concrete generic helpers through `#lib/*`, for example `#lib/file-lease`.
- `#subagents/runtime` is the only cross-feature capability import. Production code must not import another feature's `index.ts`.
- Keep feature-specific code with its owner. Add a generic module only when at least two features need it.

## Functional framing

This is one personal Pi harness. The complete registered entrypoint bundle is the supported composition; feature modules are runtime owners, not independently distributed packages.

## Commands

Use `npm` from the repository root.

- Install: `npm install`
- Typecheck: `npm run check`
- Lint: `npm run lint`
- Format: `npm run format`
- Check formatting: `npm run format:check`
- Tests: `npm run test`

## Development notes

- To add a feature, create `src/extensions/<feature>/index.ts`, add it in the intended order to `package.json#pi.extensions`, add adjacent behavior tests, and document it in `docs/features/` and the root README.
- Prefer root-level validation before handing off changes; at minimum run the narrowest relevant test plus `npm run check` for TypeScript changes.
- If changing Pi extension APIs or TUI integrations, verify against the local Pi docs referenced in the harness instructions rather than relying on memory.
