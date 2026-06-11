# pi-implement

Autonomously implement a `/plan` markdown file, working through its unchecked tasks one at a time and making a commit per task.

Each task is handled by an implementer subagent and then judged by a reviewer subagent. Only approved work is committed, and after every task lands a final reviewer checks the whole feature against the plan. Independent tasks can run concurrently in isolated git worktrees.

## Capabilities

- **Autonomous task loop** — drives the full implement → review → commit cycle per task without human input, one commit per approved task.
- **Independent review gate** — a separate reviewer subagent judges correctness, quality, scope, and verification before anything is committed; changes-requested feedback is fed back to a bounded rework loop.
- **Whole-feature overall review** — once all tasks land, a read-only reviewer assesses the combined diff against the original plan and can require follow-up work.
- **Serial or parallel execution** — auto-selects per plan whether tasks should run one at a time or through a dependency graph. Parallel tasks run in isolated worktrees and integrate back one at a time with verification at each step.
- **Sandboxed subagents** — implementers and reviewers are confined to their worktree; the orchestrator detects and blocks (or auto-heals) any out-of-bounds change to HEAD, the candidate diff, the main checkout, or plan artifacts.
- **Built-in verification** — runs a configured verify command or auto-detected `test`/`typecheck`/`build` scripts, with an LLM integration review as a last resort. Precommit hooks are a hard gate and are never bypassed.
- **Index-style plans** — top-level tasks can link out to supporting markdown files, which are inlined into the implementer's context.
- **Durable, resumable state** — per-run state, artifacts, and worktrees are persisted under the repo; runs are lockable across sessions, auto-cleaned on success, and inspectable/recoverable on failure.
- **Live progress** — a TUI status footer and per-agent widget (tokens, tool uses, compactions) plus progress messages streamed into the session.

## Usage

```text
/implement path/to/plan.md          # pick serial or parallel automatically
/implement path/to/plan.md --serial # force serial execution
/build path/to/plan.md              # alias for /implement
/implement status
/implement stop
/implement inspect
/implement cleanup
/implement config
/implement view
```

Plan paths must not contain spaces. Use a symlink or rename if needed.

## Execution strategy

Zero or one unchecked task short-circuits to serial. Otherwise a progressive planner decides whether the remaining tasks require serial execution or can run from a dependency graph, inspecting the repository only when needed. Invalid planner output, planner failures, invalid graphs, and explicit planner serial decisions fall back to serial execution.

Passing `--serial` forces serial execution and skips the planner entirely.

Parallel execution runs independent tasks concurrently up to `maxParallel` from config, with a hard maximum of `8`.

## The per-task loop

For each unchecked task, pi-implement:

1. Builds a single-task packet (the task line, its indented block, and any referenced plan material) and spawns an implementer subagent.
2. Stages the candidate changes, excluding plan artifacts and never force-adding ignored files. Staging before review lets the reviewer see new untracked files via `git diff --cached HEAD`.
3. Spawns a reviewer subagent to judge the staged candidate.
4. On approval, commits the task. On changes requested, resets the candidate and re-runs the implementer with the reviewer's feedback.

The loop is bounded: reviewer change requests and system/commit failures each have a retry ceiling, after which the run is blocked with the accumulated reason rather than looping forever.

An implementer may report `already_satisfied` when the current repository state already meets the task and no changes are needed. In that case a dedicated reviewer verifies the claim against the repo, and on approval the checkbox is marked without an empty commit.

## Overall review

After the last task is committed (and, in parallel mode, after final validation), a read-only overall reviewer inspects the combined base→HEAD diff against the full plan to catch cross-task gaps, missed edge cases, and integration problems.

If the overall reviewer requests changes, pi-implement can autonomously run a bounded rework loop: an implementer addresses the feedback, commits the changes, and the overall review is re-run. This repeats up to a small retry limit. If the limit is exhausted before approval, the run ends in a `followup_required` state and writes a `<plan>.overall-review.md` artifact next to the plan describing the required changes and a suggested follow-up. Re-running `/implement` after addressing them resumes from the remaining work.

## Parallel execution and integration

In parallel mode, the planner produces a dependency graph and a scheduler runs ready tasks concurrently, up to the effective concurrency limit. Each task gets its own branch and worktree.

Integration is serialized and plan-ordered: approved task commits are cherry-picked onto the main checkout one at a time, validated, and committed. If validation fails or integration mutates plan artifacts/HEAD/the staged diff unexpectedly, the integration is rolled back and the task is sent for bounded rework (or blocked once its integration-attempt ceiling is reached). A final validation pass runs before the overall review.

## Safety boundaries

Implementer and reviewer prompts are self-contained contracts that instruct subagents not to touch git state or plan files. The orchestrator enforces this regardless of subagent behavior by snapshotting and re-checking around every subagent call:

- Implementers may not change HEAD, dirty the main checkout outside their worktree, or modify plan artifacts — any of these blocks the run.
- Reviewers are read-only; benign reviewer mutations to the candidate diff are auto-healed back to the reviewed state, and unhealable changes block the run.
- The overall reviewer must leave HEAD, the staged state, the worktree, and plan artifacts unchanged.

Plan checkbox updates are intentionally not part of any commit. Plan files may be gitignored or live outside the repository, as long as `/implement` is run from inside the target repository.

## Requirements

- The current directory must be inside a git repo with a clean worktree, ignoring the source plan artifact and any validated supporting plan artifacts.
- `@tintinweb/pi-subagents` must be installed; pi-implement drives its implementer, reviewer, and planner roles through that extension's cross-extension RPC/event interfaces. If it is missing or unresponsive, `/implement` refuses to start.

## Plan format and task scope

Executable work comes from top-level checkbox tasks under `## Tasks`. `/implement` runs the next unchecked top-level task and updates that same checkbox when the task is approved. Only the `## Tasks` section is parsed for executable checklist state.

For index-style plans, a task can reference supporting markdown files with indented `Plan:` linkage lines:

```markdown
## Tasks

- [ ] Implement auth storage
  - Plan: `auth-storage.md`
  - Plan: <shared-decisions.md>
```

Supported references contain exactly one `Plan:` target per line, written as either a backticked or angle-bracketed local markdown path. Multiple `Plan:` lines under one task are allowed. URLs, non-markdown targets, directories, missing files, empty files, malformed references, and multiple references on one line block execution before implementation.

Referenced supporting file contents are inlined as raw markdown in the implementer's task packet under `Referenced Plan Material`. The selected checkbox remains the only unit of work: implementers are instructed to use referenced material only for requirements directly relevant to the selected task, and they are not directed to read the whole source plan. Sibling task lines are omitted from implementer packets; reviewers receive sibling task context only as a scope-creep guard.

## Config

Global config lives at:

```text
~/.pi/agent/extensions/pi-implement/config.json
```

```json
{
  "implementer": {
    "model": "provider/model-id",
    "type": "general-purpose"
  },
  "reviewer": {
    "model": "provider/model-id",
    "type": "general-purpose"
  },
  "planner": {
    "model": "provider/model-id",
    "type": "Explore"
  },
  "maxParallel": 3,
  "verifyCommand": "npm test",
  "taskReview": {
    "mode": "auto",
    "maxSkipDiffChars": 2000,
    "maxSkipFiles": 3
  }
}
```

If a role model is omitted, pi-implement does not pass a model override, so `pi-subagents` uses the role's subagent type default model (and then the current session model if that type has no default). If a role type is omitted, `general-purpose` is used for implementer and reviewer, and `Explore` is used for the planner. The runtime prompts are self-contained enough to work with `general-purpose`, but reviewer safety is only instruction-enforced in that mode; configure `reviewer.type` to a dedicated read-only review agent for stronger isolation.

`maxParallel` defaults to `3` and is clamped to a hard maximum of `8`. Invalid values are ignored with a warning.

`taskReview` controls when per-task review can be skipped. Default `auto` preserves review as the safety net unless planner hints and runtime evidence (small docs-only or additive-fixture diffs with passing validation) make a task skip-eligible. Set `mode` to `"always"` to force review for every task. `maxSkipDiffChars` and `maxSkipFiles` cap the size of skip-eligible diffs.

`verifyCommand` is an optional non-empty shell command. In parallel mode it runs from the repository root during per-task integration and final validation. If omitted, pi-implement auto-detects `test`, `typecheck`, and `build` package scripts (respecting the repo's npm/pnpm/yarn lockfile); if none exist, it falls back to an LLM integration review.

Run `/implement config` to print the resolved configuration and configured role model overrides.

## Verification

The implementer chooses task-appropriate checks and is instructed to err toward more verification. The reviewer judges correctness, quality, scope, and verification sufficiency. Precommit hooks are the hard gate and are never bypassed.

## Live status

In a TUI session, pi-implement shows a status footer summarizing the current phase and a widget listing active subagents with their runtime stats (tokens, tool uses, compaction counts). It also streams `pi-implement-progress` messages into the session as tasks start, finish, get reviewed, and land. These are pi-implement's own authoritative updates — the host agent stays idle while a run is in flight.

Run `/implement view` to inspect active pi-implement subagents. With one active agent it prints fallback instructions to open the agent via `/agents`; with multiple agents it prompts you to pick by pretty label.

## Recovery

Use `/implement stop` to halt local orchestration and request that active subagents stop. If a run is blocked or stopped, run `/implement inspect` to locate the run directory and worktrees and see each task's status, fix or revert as needed, return to a clean state (except for intended plan checkbox state), then rerun `/implement <plan.md>`.

Use `/implement cleanup` to remove durable state and worktrees left behind by failed, blocked, or stopped runs. It refuses while a run is active or another session holds a live run lock, and prunes stale locks it can prove are dead. Successful runs are cleaned up automatically.
