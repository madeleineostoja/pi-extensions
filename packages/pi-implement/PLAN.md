# Relocate pi-implement runtime state out of the repo working tree

## Context

pi-implement currently writes all of its runtime state into the repo working
tree at `<repoRoot>/.pi/implement/` — run metadata, the plan snapshot, an
events log, per-task JSON, the run lock, and the per-task git **worktrees**.
Because these files live inside the working tree, the extension carries
git-exclusion machinery (custom pathspecs and path-prefix filters) so that its
own files don't pollute `git status`, staging, or the strategy prompt's view of
the repo. Users are also expected to gitignore `.pi/`.

Pi itself stores per-project runtime state (sessions) **outside** the repo,
under the agent home directory, encoding the working directory into the path:
`~/.pi/agent/sessions/--<encoded-cwd>--/<id>.jsonl` (see Pi's session-format
doc). Discoverability of those opaque paths is handled by commands (e.g.
`/resume`), not by the files being in the repo.

This work moves pi-implement's runtime state to match that convention: anchor
everything under the agent home dir, cwd-encoded, so nothing lives in the
working tree. That lets us **delete** the git-exclusion machinery entirely
(nothing to exclude once the files are gone from the tree), and removes the need
for users to gitignore anything. Because the per-task worktrees move out of the
repo too, the documented "blocked/stopped → inspect the worktree → fix → rerun"
recovery workflow loses its previously-obvious in-repo path, so we add an
`/implement inspect` command to surface the now-external paths.

Cross-session resume is explicitly **out of scope** (see Decisions): the
relocation preserves today's exact behavior and file shapes; only the base
directory changes.

## Acceptance Criteria

- [ ] All runtime state that previously lived under `<repoRoot>/.pi/implement/`
  is written under an agent-home-anchored, cwd-encoded base directory instead
  (see Decisions for the exact scheme). Verify: start a run in a test repo, then
  confirm `<repoRoot>/.pi/implement/` is **not** created and the equivalent
  files exist under the new base dir. A unit test on the path-derivation
  function asserts the new base path shape for a sample repo root.
- [ ] The file layout *within* the base dir is unchanged: `runs/<runId>/run.json`,
  `runs/<runId>/events.jsonl`, `runs/<runId>/plan.snapshot.md`,
  `runs/<runId>/tasks/`, `worktrees/<runId>/`, `locks/run.lock`. Verify: existing
  state tests pass after being updated only for the base-path change.
- [ ] Per-task git worktrees are created under the new external base dir and a
  parallel run completes successfully end to end. Verify: run an existing
  parallel-mode integration/unit test (or the documented manual parallel run)
  and confirm worktrees are added at the external path and integrated back.
- [ ] The git-exclusion machinery tied to the in-tree location is removed:
  no remaining references to the literal `.pi/implement` pathspec exclude
  (`:(top,literal,exclude).pi/implement`) or to `startsWith(".pi/implement/")`
  / `startsWith(".pi/")` path filtering in `git.ts` or `strategy.ts`. Verify:
  `rg -n "\.pi/implement|startsWith\(\"\.pi" packages/pi-implement/src` returns
  no matches in non-test source; the package's tests still pass.
- [ ] `git status` of the test repo during and after a run shows no
  pi-implement files (because they are external). Verify: during a paused/blocked
  run, `git -C <repoRoot> status --porcelain` shows only the user's intended
  changes (e.g. plan checkbox edits), with no `.pi/` entries.
- [ ] `/implement cleanup` still removes leftover git worktrees and
  `pi-implement/<runId>/*` branches registered in the real repo, and removes the
  external run directories. Verify: after a stopped/blocked run, run
  `/implement cleanup` and confirm `git worktree list` no longer lists the run's
  worktrees, `git branch --list 'pi-implement/<runId>/*'` is empty, and the
  external `runs/<runId>` / `worktrees/<runId>` dirs are gone.
- [ ] A new `/implement inspect` subcommand prints the external locations for the
  current or most-recent run: the run directory, the worktrees directory, and
  one line per task showing task id, status, and worktree path. Verify: trigger
  a blocked/stopped run, run `/implement inspect`, and confirm the printed paths
  exist on disk and point at the run's external state; with no run present it
  reports that there is nothing to inspect.
- [ ] `/implement inspect` is accepted by the command parser as a known
  subcommand (not treated as a plan path or an error). Verify: a parser unit test
  asserts `parseCommand("inspect")` yields `{ kind: "subcommand", name: "inspect" }`.
- [ ] README is updated: the Recovery section points users at `/implement inspect`
  to locate the worktree instead of assuming an in-repo `.pi/implement` path, and
  any instruction to gitignore `.pi/` is removed. Verify: README Recovery section
  mentions `/implement inspect` and contains no guidance to gitignore pi-implement
  state.

## Out of Scope

- Cross-session resume / rehydrating a run from disk on session start. Behavior
  stays as today: in-memory `active` state is authoritative for a live run, and
  on-disk state exists only for cleanup/audit and (new) inspection.
- Using Pi's `appendCustomEntry` / `CustomEntry` session-persistence mechanism.
- A configurable runtime directory (`runtimeDir` config option). The location is
  fixed to the agent-home-anchored scheme below.
- Migrating any pre-existing `<repoRoot>/.pi/implement/` state from prior runs to
  the new location. Old leftover dirs are simply abandoned; users can delete them
  manually. (Cleanup of old in-repo dirs is not handled.)
- An `--open`/`$EDITOR` flag or copy-paste `cd` helper on `/implement inspect`;
  it only prints paths.

## Decisions

- **Base directory scheme.** Anchor under the agent home dir returned by
  `getAgentDir()` (the same value already imported in `command.ts` and used for
  config), in a `pi-implement` namespace, with the absolute repo root encoded
  into a single path segment, mirroring Pi's session convention
  (`sessions/--<encoded-cwd>--/`). Concretely:
  `join(getAgentDir(), "pi-implement", "--<encoded-repoRoot>--")` as the
  `baseDir`, with `runs/`, `worktrees/`, `locks/` underneath exactly as today.
  Encoding: replace path separators (`/`, and on Windows `\` and `:`) with `-`,
  matching Pi's `/`→`-` scheme. Anchoring on the **repo root** (not raw cwd)
  guarantees one base dir per repo regardless of which subdirectory the command
  is invoked from, which also keeps `/implement cleanup`'s "scan all runs for
  this repo" semantics intact.
- **Why no split / no session persistence.** Resume is out of scope, so the only
  consumers of on-disk state are within-process orchestration, `/implement
  cleanup`, and the new `/implement inspect`. Writing milestone state into the
  session JSONL would couple run state to session identity and interleave
  bookkeeping into the user's conversation for zero functional gain, while still
  requiring external files for worktrees and churny per-task JSON. Therefore all
  state moves as-is to the external base dir; the session is not touched.
- **Why exclusion machinery can be deleted, not just bypassed.** The pathspec
  excludes and `startsWith(".pi/implement/")` / `startsWith(".pi/")` filters in
  `git.ts` and `strategy.ts` exist solely to hide in-tree pi-implement files from
  git status/staging and from the strategy prompt's repo view. Once the files and
  worktrees live outside the working tree, there is nothing in-tree to exclude, so
  the filters become dead code and are removed rather than parameterized.
- **Cleanup is retained.** Moving worktrees out of the tree does not remove the
  need for cleanup: linked worktrees and `pi-implement/<runId>/*` branches are
  registered in the real `.git` regardless of the worktree directory's physical
  location, so they still require `git worktree remove` / `branch -D` /
  `worktree prune`. Only the directory-removal target changes to the external path.

## Implementation Notes

Primary integration points (paths relative to `packages/pi-implement/`):

- `src/state.ts`
  - `getStatePaths(repoRoot, runId)` (~line 100): currently
    `const baseDir = join(repoRoot, ".pi", "implement")`. This is the single
    source of truth for the base dir — change it to the agent-home-anchored,
    cwd-encoded scheme (Decisions). The rest of the returned `StatePaths`
    (`runDir`, `worktreesDir`, `lockFile`, etc.) is derived from `baseDir` and
    needs no structural change. Add the repo-root encoding helper here.
  - `listRunIds(repoRoot)` (~line 372): currently
    `join(repoRoot, ".pi", "implement", "runs")`. Re-derive the runs dir from the
    same base-dir logic (e.g. reuse `getStatePaths(repoRoot, "_").baseDir` or a
    shared `getBaseDir(repoRoot)` helper) so it points at the external location.
  - The internal cleanup loop (~line 355) and `cleanupRun` already operate on
    `StatePaths`/`getStatePaths` output, so they follow automatically.
- `src/git.ts`
  - `isCleanExcept` (~line 72): remove the `":(top,literal,exclude).pi/implement"`
    entry.
  - `stageAllExcept` (~line 87): remove the
    `!path.startsWith(".pi/implement/")` filter clause.
  - `protectedPathspecs` (~line 239): remove the trailing
    `":(top,literal,exclude).pi/implement"`.
  - Worktree creation (`addWorktree` ~line 208, `forWorktree` ~line 220) takes an
    explicit worktree path from the caller (`StatePaths.worktreesDir`), so it
    needs no change beyond receiving the new external path. Confirm
    `git worktree add <externalPath> <branch>` works with an absolute path
    outside the repo (it does).
- `src/strategy.ts`
  - `getFileTreeSummary` (~line 551): remove the
    `.filter((p) => !p.startsWith(".pi/implement/"))`.
  - `getFilteredGitStatus` (~line 611): remove the
    `":(top,literal,exclude).pi/implement"` pathspec and the
    `startsWith(".pi/implement/")` / `startsWith(".pi/")` filter branches.
  - Prompt text (~line 499): the "excluding .pi/implement/** and plan artifacts"
    wording should drop the `.pi/implement` mention (plan-artifact exclusion, if
    still present, stays).
- `src/parser.ts`
  - Subcommand union type (~line 10) and the whitelist (~lines 78–84) and usage
    string (~line 116): add `"inspect"` alongside `status | stop | cleanup |
    config | agents`.
- `src/command.ts`
  - Subcommand dispatch (~line 120 onward, following the `status` / `config` /
    `stop` / `cleanup` branches): add an `inspect` branch. It should resolve the
    run to inspect (the active run if present, else the most-recent run id from
    `listRunIds(repoRoot)`), read `run.json` via `readRunJson` and the per-task
    JSON from `tasksDir`, and `ctx.ui.notify` the run dir, worktrees dir, and a
    line per task (`<id> [<status>] → <worktreePath>`). The existing status
    formatting in `src/status.ts` and the task-reading helpers in `src/state.ts`
    (`readRunJson`, per-task reads used by cleanup ~line 388
    `readTaskCleanupEntries`) are the reference for how to load this data.
  - `repoRoot` is already derived via `git.root()` in the relevant handlers
    (e.g. ~lines 241/353); reuse it as the anchor for `getStatePaths` /
    `listRunIds`.
- `README.md`
  - Recovery section (~lines 91–95): replace the "inspect the worktree" guidance
    (which assumes an in-repo path) with "run `/implement inspect` to locate the
    worktree". Remove any expectation that users gitignore `.pi/`.

Tests to update / add:

- `src/state.test.ts` (and any test asserting the `.pi/implement` base path):
  update expected base paths to the new scheme; add an assertion for the encoded
  base-dir shape given a sample repo root.
- `src/parser.test.ts` (or equivalent): add a case for `inspect`.
- `src/git.test.ts` / `src/strategy.test.ts`: update/remove assertions tied to
  the deleted `.pi/implement` exclusions.
- Add coverage for the `/implement inspect` output if the command layer is
  unit-testable in the existing harness; otherwise document the manual
  verification in the acceptance criterion above.

## Tasks

- [ ] Change the base-directory derivation in `src/state.ts`: update
  `getStatePaths` to anchor `baseDir` under `getAgentDir()` with the repo root
  cwd-encoded (Decisions), add a shared base-dir/encoding helper, and update
  `listRunIds` to use it. Update `src/state.test.ts` expectations and add the
  base-path-shape assertion.
- [ ] Remove the in-tree git-exclusion machinery in `src/git.ts`
  (`isCleanExcept`, `stageAllExcept`, `protectedPathspecs`) and `src/strategy.ts`
  (`getFileTreeSummary`, `getFilteredGitStatus`, prompt wording). Update/remove
  the corresponding test assertions.
- [ ] Verify a parallel-mode run creates worktrees at the external path and
  integrates successfully, and that `/implement cleanup` removes external run
  dirs plus the real-repo worktrees/branches. Fix any path assumptions surfaced.
- [ ] Add `inspect` to the parser: extend the subcommand union, whitelist, and
  usage string in `src/parser.ts`; add a parser test case.
- [ ] Implement the `/implement inspect` handler branch in `src/command.ts`:
  resolve active-or-latest run, read run + task state, and print run dir,
  worktrees dir, and per-task `id [status] → worktreePath`; handle the
  no-run case. Add command-layer test coverage if the harness supports it.
- [ ] Update `README.md` Recovery section to reference `/implement inspect` and
  remove any `.pi/` gitignore guidance.
