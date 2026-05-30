# pi-implement

Autonomously implement `/plan` markdown files one unchecked task at a time.

## Usage

```text
/implement path/to/plan.md
/implement --serial path/to/plan.md
/implement --parallel <n> path/to/plan.md
/implement status
/implement stop
/implement cleanup
/implement config
/implement agents
```

Plan paths must not contain spaces. Use a symlink or rename if needed.

## How it works

- Requires the current directory to be inside a git repo with a clean worktree, ignoring the source plan artifact.
- Parses only the `## Tasks` section for executable checklist state.
- Requires `@tintinweb/pi-subagents` and uses its cross-extension RPC/event interfaces.
- Spawns an implementer subagent, then a reviewer subagent through `pi-subagents`.
- Stages the candidate commit before review so the reviewer sees new untracked files with `git diff --cached HEAD`.
- Excludes the source plan artifact from staging and never force-adds ignored files.
- The parent extension marks the approved checkbox as local run state and makes one commit per task.

Plan checkbox updates are intentionally not part of the commit. Plan files may be gitignored or outside the repository, as long as `/implement` is run from inside the target repository.

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

If a role model is omitted, the current session model is used. If a role type is omitted, `general-purpose` is used for implementer/reviewer and `Explore` is used for planner. A common setup is a cheaper implementer model and a frontier reviewer model, optionally with the bundled `review` subagent type.

Run `/implement agents` to scaffold the bundled global `review` agent at `~/.pi/agent/agents/review.md`. The command always asks for confirmation and fails rather than overwriting an existing global `review` agent. Configure it with:

```json
{
  "reviewer": {
    "type": "review"
  }
}
```

`maxParallel` defaults to `3` and is clamped to a hard maximum of `8`. Invalid values are ignored with a warning.

`verifyCommand` is an optional non-empty string recorded as evidence but not automatically executed.

## Verification

The implementer chooses task-appropriate checks and is instructed to err toward more verification. The reviewer judges correctness, quality, scope, and verification sufficiency. Precommit hooks are the hard gate and are not bypassed.

## Recovery

Use `/implement stop` to stop local orchestration and request that the active subagent stops. If a run is blocked or stopped, inspect the worktree, fix or revert as needed, return to a clean state except for intended plan checkbox state, then rerun `/implement <plan.md>`.

Use `/implement cleanup` to remove durable state and worktrees from failed, blocked, or stopped runs.
