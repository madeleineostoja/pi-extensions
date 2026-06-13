# Repository Guidelines

## Monorepo structure

- Root `package.json` defines npm workspaces for `packages/*` and `lib`, plus the `pi.extensions` entrypoint list used by Pi.
- `packages/pi-*` are individual Pi extension packages. Most code lives under each package's `src/`; package READMEs document user-facing behaviour.
- `lib/` is the shared workspace package published internally as `@pi-extensions/lib`.
- Tests sit next to implementation as `*.test.ts`.

## Shared library

- Import shared helpers as `@pi-extensions/lib`; do not reach into `lib/src` via relative paths from packages.
- Put cross-extension utilities in `lib/src` and export them from `lib/src/index.ts`.
- Keep package-specific logic inside the owning `packages/pi-*` workspace unless at least two packages need it.

## Common commands

Use `npm` for all installs and scripts in this repo. Run from the repository root unless targeting a workspace.

- Install: `npm install`
- Typecheck: `npm run check`
- Lint: `npm run lint`
- Format: `npm run format`
- Tests: `npm run test`
- Target a workspace script: `npm -w <workspace-name> run <script>` (for example, `npm -w pi-implement test`)

## Development notes

- When adding a new extension package, add its workspace package under `packages/`, expose its `src/index.ts`, document it in the package README and root README, and register it in root `package.json` under `pi.extensions`.
- Prefer root-level validation before handing off changes; at minimum run the narrowest relevant test plus `npm run check` for TypeScript changes.
- If changing Pi extension APIs or TUI integrations, verify against the local Pi docs referenced in the harness instructions rather than relying on memory.
