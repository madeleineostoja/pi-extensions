# Development

Pipkin is developed and released as one root npm package. Run commands from the repository root with npm.

| Purpose                 | Command                                    |
| ----------------------- | ------------------------------------------ |
| Install dependencies    | `npm install`                              |
| Typecheck               | `npm run check`                            |
| Lint                    | `npm run lint`                             |
| Check formatting        | `npm run format:check`                     |
| Apply formatting        | `npm run format`                           |
| Run all tests           | `npm run test`                             |
| Test one feature path   | `npm run test -- src/extensions/<feature>` |
| Test one Vitest project | `npm run test -- --project <project>`      |

## Test the boundary you changed

`npm run test` runs explicit Vitest projects for adjacent feature tests, shared-library tests, Implement's serialized suites, and the bundle contract under `test/bundle/`.

For a focused change:

1. Run the nearest adjacent test file, path, or project.
2. Run `npm run check` for TypeScript changes.
3. Run the bundle project when changing entrypoints, registrations, internal imports, lifecycle order, or the root manifest.
4. Finish with the root checks proportionate to the change.

```sh
npm run test -- --project bundle
```

The bundle suite uses Pi's installed loader against `package.json#pi.extensions`. Do not replace it with direct file imports: loader identity and ordered registration are product contracts.

Feature tests import responsibility-named behavior modules, never `index.ts`. Keep tests beside their owner and preserve their Vitest filename suffix and project assignment when moving them.

## Add or change a feature

A new feature requires:

1. a thin Pi registration root at `src/extensions/<feature>/index.ts`;
2. intentional placement in `package.json#pi.extensions`;
3. adjacent behavior and behavior tests in responsibility-named modules;
4. updated bundle expectations for public registrations or ordering; and
5. an updated concept guide and README summary.

Add a feature subfolder only for an established cohesive cluster. Keep feature-specific code with its owner, move generic code to `src/lib/` only after two features need it, and use an explicit narrow mapping for cross-feature imports. Production code must not import another feature's `index.ts` or an undeclared internal path.

Read [Architecture](architecture.md) and repository `AGENTS.md` before changing lifecycle, shared state, extension APIs, or bundle order.
