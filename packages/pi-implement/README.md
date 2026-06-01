# pi-implement

Autonomously implement a `/plan` markdown file, working through its unchecked tasks one at a time and making a commit per task.

Each task is handled by an implementer subagent and then judged by a reviewer subagent. Only approved work is committed. Independent tasks can run concurrently in isolated git worktrees.

## Usage

```text
/implement path/to/plan.md          # auto: pick serial or parallel automatically
/implement --serial path/to/plan.md # force one task at a time
/implement --parallel <n> path/to/plan.md
/implement status
/implement stop
/implement cleanup
/implement config
/implement agents
```

Plan paths must not contain spaces. Use a symlink or rename if needed.

## Execution modes

- `auto` (default): a cheap heuristic decides whether parallelism is worth considering. If it is, a planner subagent triages the tasks and, if they look independent, builds a task dependency graph. Anything ambiguous falls back to serial.
- `--serial`: run unchecked tasks strictly one at a time in plan order.
- `--parallel <n>`: ask the planner for a dependency graph and run independent tasks concurrently, up to `n` (clamped by `maxParallel` and a hard maximum of `8`).

Trivial cases short-circuit: zero or one unchecked task always runs serially.

## How it works

- Requires the current directory to be inside a git repo with a clean worktree, ignoring the source plan artifact.
- Parses only the `## Tasks` section for executable checklist state.
- Requires `@tintinweb/pi-subagents` and drives implementer, reviewer, and planner roles through its cross-extension RPC/event interfaces.
- For each task, spawns an implementer subagent, stages the candidate commit, then spawns a reviewer subagent. Staging before review lets the reviewer see new untracked files via `git diff --cached HEAD`.
- Excludes the source plan artifact from staging and never force-adds ignored files.
- In parallel mode, tasks run in isolated git worktrees and are integrated back into the main branch one at a time, with verification at each integration step and a final validation pass.
- The parent extension marks the approved checkbox as local run state and makes one commit per task.

Plan checkbox updates are intentionally not part of any commit. Plan files may be gitignored or live outside the repository, as long as `/implement` is run from inside the target repository.

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
  "verifyCommand": "npm test"
}
```

If a role model is omitted, the current session model is used. If a role type is omitted, `general-purpose` is used for implementer and reviewer, and `Explore` is used for the planner. A common setup pairs a cheaper implementer model with a frontier reviewer model, optionally using the bundled `review` subagent type.

Run `/implement agents` to scaffold the bundled global `review` agent at `~/.pi/agent/agents/review.md`. The command always asks for confirmation and fails rather than overwriting an existing global `review` agent. Point the reviewer at it with:

```json
{
  "reviewer": {
    "type": "review"
  }
}
```

`maxParallel` defaults to `3` and is clamped to a hard maximum of `8`. Invalid values are ignored with a warning.

`verifyCommand` is an optional non-empty shell command. In parallel mode it runs from the repository root during per-task integration and final validation. If omitted, pi-implement auto-detects `test`, `typecheck`, and `build` package scripts; if none exist, it falls back to an LLM integration review.

Run `/implement config` to print the resolved configuration and effective role models.

## Verification

The implementer chooses task-appropriate checks and is instructed to err toward more verification. The reviewer judges correctness, quality, scope, and verification sufficiency. Precommit hooks are the hard gate and are never bypassed.

## Recovery

Use `/implement stop` to halt local orchestration and request that active subagents stop. If a run is blocked or stopped, inspect the worktree, fix or revert as needed, return to a clean state (except for intended plan checkbox state), then rerun `/implement <plan.md>`.

Use `/implement cleanup` to remove durable state and worktrees left behind by failed, blocked, or stopped runs. Successful runs are cleaned up automatically.
