# Development

Pipkin is developed and released as one root npm package. Run commands from the repository root with npm:

```sh
npm install
npm run check
npm run lint
npm run format:check
npm run test
```

Use `npm run format` to apply Prettier formatting.

## Test the boundary you changed

`npm run test` runs explicit Vitest projects for adjacent feature tests, shared-library tests, Implement's serialized suites, and the bundle contract under `test/bundle/`.

For a focused change:

1. run the closest adjacent test project or file;
2. run `npm run check` for TypeScript changes;
3. run the bundle project when registrations, internal imports, lifecycle order, or the root manifest changed;
4. finish with the root checks appropriate to the change.

```sh
npx vitest run --project bundle
```

The bundle suite uses Pi's installed loader against `package.json#pi.extensions`. Do not replace it with a test that only imports files directly; loader identity and ordered registration are part of the product contract.

## Add or change a feature

A new feature requires all of the following:

1. create `src/extensions/<feature>/index.ts` as its Pi registration root;
2. place it intentionally in the ordered `package.json#pi.extensions` list;
3. keep feature code and behavior tests adjacent;
4. update bundle expectations when public registrations or ordering change;
5. update the relevant concept guide and the root README.

Keep feature-specific code with its owner. Move a helper to `src/lib/` only once at least two features need the generic capability. Cross-feature imports need an explicit narrow mapping; production code must not import another feature's `index.ts` or an undeclared internal path.

Read [Architecture](architecture.md) and the repository `AGENTS.md` before changing lifecycle, shared state, extension APIs, or bundle order.
