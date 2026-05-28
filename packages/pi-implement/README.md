# pi-implement

Autonomously implement `/plan` markdown files one unchecked task at a time.

## Usage

```text
/implement path/to/plan.md
/implement path with spaces/plan.md
/implement status
/implement stop
/implement config
```

## How it works

- Requires the current directory to be inside a git repo with a clean worktree, ignoring the source plan artifact.
- Parses only the `## Tasks` section for executable checklist state.
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
  }
}
```

If a role model is omitted, the current session model is used. If a role type is omitted, `general-purpose` is used. A common setup is a cheaper implementer model and a frontier reviewer model, optionally with a custom reviewer subagent type.

## Verification

The implementer chooses task-appropriate checks and is instructed to err toward more verification. The reviewer judges correctness, quality, scope, and verification sufficiency. Precommit hooks are the hard gate and are not bypassed.

## Recovery

Use `/implement stop` to stop local orchestration and request that the active subagent stops. If a run is blocked or stopped, inspect the worktree, fix or revert as needed, return to a clean state except for intended plan checkbox state, then rerun `/implement <plan.md>`.
