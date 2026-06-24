# pi-implement

Autonomously implement a markdown plan file, working through its unchecked tasks one at a time and making a commit per task. Any plan with a `## Tasks` checklist works — it does not require output from a specific `/plan` skill or a particular plan template.

Each task is handled by an implementer subagent and then judged by a reviewer subagent. Only approved work is committed, and after every task lands a final reviewer checks the whole feature against the plan. Independent tasks can run concurrently in isolated git worktrees.

## Capabilities

- **Autonomous task loop** — drives the full implement → review → commit cycle per task without human input, one commit per approved task.
- **Independent review gate** — a separate reviewer subagent judges correctness, quality, scope, and verification before anything is committed; changes-requested feedback is fed back to a bounded rework loop.
- **Whole-feature overall review** — once all tasks land, a read-only reviewer assesses the combined diff against the original plan and can require follow-up work.
- **Serial or parallel execution** — auto-selects per plan whether tasks should run one at a time or through a dependency graph. Parallel tasks run in isolated worktrees and integrate back one at a time with verification at each step.
- **Subagent isolation checks** — implementers and reviewers run from their assigned worktree; the orchestrator detects and blocks (or auto-heals) any out-of-bounds change to HEAD, the candidate diff, the main checkout, or plan artifacts.
- **Built-in verification** — runs a configured verify command or auto-detected `test`/`typecheck`/`build` scripts, with an LLM integration review as a last resort. Precommit hooks are a hard gate and are never bypassed.
- **Plan corpus ingestion** — the entry plan and the markdown files it links to (plus `tasks/` siblings) are ingested into the planner's corpus and distilled into per-task contracts, rather than being inlined wholesale into the implementer's context.
- **Durable, resumable state** — per-run state, artifacts, and worktrees are persisted under `<repo>/.pi/implement/`; runs are lockable across sessions, auto-cleaned on success, and inspectable/recoverable on failure.
- **Live progress** — a TUI status footer and per-agent widget (tokens, tool uses, compactions) plus progress messages streamed into the session.

## Usage

```text
/implement                          # open the interactive action menu
/implement path/to/plan.md          # pick serial or parallel automatically
/implement path/to/plan.md --serial # force serial execution
```

The interactive menu includes status, stop, inspect, cleanup, config, and active-agent viewing actions.

Plan paths passed directly must not contain spaces. Use the interactive menu, a symlink, or a rename if needed.

## Execution strategy

Zero or one unchecked task short-circuits to serial. Otherwise a progressive planner decides whether the remaining tasks require serial execution or can run from a dependency graph, inspecting the repository only when needed. Invalid planner output, planner failures, invalid graphs, and explicit planner serial decisions fall back to serial execution.

Passing `--serial` forces serial execution and skips the planner entirely.

Parallel execution runs independent tasks concurrently up to `maxParallel` from config, with a hard maximum of `8`. Each autonomous worker runs from its assigned task worktree as its current working directory; pi-implement owns those worktrees and validates the boundaries around them.

## Execution planning and compiled task contracts

`/implement` accepts a human plan file, compiles an internal execution manifest, and executes compiled task contracts. The execution planner reads the human plan corpus, derives scoped task contracts and a dependency graph, and the orchestrator gives implementer/reviewer agents only the selected compiled contract.

The source plan remains the human-facing contract. The compiled execution manifest is an internal pi-implement artifact used to execute that human plan safely. Legacy Markdown checkbox plans are still supported as an ingestion fallback: the orchestrator parses the source plan, auto-generates a minimal compiled contract for each task, and projects checkbox state back to the source file.

## The per-task loop

For each unchecked task, pi-implement:

1. Loads the compiled task contract for the selected task from the execution manifest. The contract includes a precise objective, in-scope items, acceptance criteria, and out-of-scope items. Sibling task contracts are intentionally omitted.
2. Stages the candidate changes, excluding plan artifacts and never force-adding ignored files. Staging before review lets the reviewer see new untracked files via `git diff --cached HEAD`.
3. Spawns a reviewer subagent to judge the staged candidate against the compiled contract.
4. On approval, commits the task. On changes requested, resets the candidate and re-runs the implementer with the reviewer's feedback.

The loop is bounded: reviewer change requests and system/commit failures each have a retry ceiling, after which the run is blocked with the accumulated reason rather than looping forever.

An implementer may report `already_satisfied` when the current repository state already meets the task and no changes are needed. In that case a dedicated reviewer verifies the claim against the repo, and on approval the checkbox is marked without an empty commit.

## Overall review

After the last task is committed (and, in parallel mode, after final validation), a read-only overall reviewer inspects the combined base→HEAD diff against the full plan to catch cross-task gaps, missed edge cases, and integration problems.

If the overall reviewer requests changes, pi-implement can autonomously run a bounded rework loop: an implementer addresses the feedback, commits the changes, and the overall review is re-run. This repeats up to a small retry limit. If the limit is exhausted before approval, the run ends in a `followup_required` state and writes a `<plan>.overall-review.md` artifact next to the plan describing the required changes and a suggested follow-up. Re-running `/implement` after addressing them resumes from the remaining work.

## Parallel execution and integration

In parallel mode, the planner produces a dependency graph and a scheduler runs ready tasks concurrently, up to the effective concurrency limit. Each task gets its own branch and worktree, and the worker's `cwd` is that task worktree so file reads, commands, and edits target the isolated checkout.

Integration is serialized and plan-ordered: approved task commits are cherry-picked onto the main checkout one at a time, validated, and committed. Parallel orchestration intentionally narrows broad reviewer/main-HEAD guards while a worker is isolated: the main checkout can advance as other tasks land, but each worker is still fenced to its task worktree and the candidate commit it is responsible for. If validation fails or integration mutates plan artifacts/the staged diff unexpectedly, the integration is rolled back and the task is sent for bounded rework (or blocked once its integration-attempt ceiling is reached). A final validation pass runs before the overall review.

## Safety boundaries

Implementer and reviewer prompts are self-contained contracts that instruct subagents not to touch git state or plan files. The orchestrator enforces this regardless of subagent behavior by snapshotting and re-checking around every subagent call:

- Implementers may not change HEAD, dirty the main checkout outside their task worktree, or modify plan artifacts — any of these blocks the run.
- Reviewers are read-only; benign reviewer mutations to the candidate diff are auto-healed back to the reviewed state, and unhealable changes block the run.
- The overall reviewer must leave HEAD, the staged state, the worktree, and plan artifacts unchanged.
- Internally owned workers run through `pi-subagents`, inherit the host extension environment, and use pi-implement-selected tool sets: implementation and self-heal roles use the host's active tools, while review and planning roles use read-oriented tools.

Plan checkbox updates are intentionally not part of any commit. Plan files may be gitignored or live outside the repository, as long as `/implement` is run from inside the target repository.

## Runtime integration and requirements

- The current directory must be inside a git repo with a clean worktree, ignoring the source plan artifact and any validated supporting plan artifacts.
- `pi-implement` uses the bundled first-party `pi-subagents` runtime directly. Installing the root `pi-extensions` bundle registers `pi-subagents` before `pi-implement`, so implementer, reviewer, planner, and self-heal workers run in-process without external installation or RPC setup.
- Worker status is surfaced through `pi-implement` progress messages, the `/implement` action menu, and the shared `/agents` dashboard. Internally owned workers are intentionally quiet in the main transcript except for pi-implement's orchestration updates.

## Plan format and task scope

The only hard structural requirement is a `## Tasks` section containing top-level checkbox tasks. `/implement` runs the next unchecked top-level task and updates that same checkbox when the task is approved; only the `## Tasks` section is parsed for executable checklist state. Any markdown plan with that section works — pi-implement does not require output from a specific `/plan` skill.

### Plan corpus ingestion

The entry plan file and its supporting material form the _plan corpus_ that the execution planner reads. The corpus is built by following standard markdown links in the entry file:

```markdown
## Context

See [auth storage design](./design/auth-storage.md) and [shared decisions](./design/shared-decisions.md).

## Tasks

- [ ] Implement auth storage
- [ ] Wire up session refresh
```

Every `[label](target.md)` link (image links are ignored) is resolved relative to the entry file and its content pulled into the corpus. If a linked file lives in a directory named `tasks/`, every sibling `.md` file in that directory is ingested too, so a plan can point at one task file and pick up the rest of the set. The corpus is capped at 50 files and 200,000 characters. URLs, directories, non-markdown targets, and missing or empty files are recorded as validation errors that block the run before any implementation starts.

Indented `Plan:` linkage lines under a task are also still supported as a legacy reference style:

```markdown
## Tasks

- [ ] Implement auth storage
  - Plan: `auth-storage.md`
  - Plan: <shared-decisions.md>
```

Each `Plan:` line carries exactly one backticked or angle-bracketed local markdown path; multiple lines per task are allowed, and the same URL/non-markdown/directory/missing/empty/malformed rules block execution.

During execution planning, the planner reads the full corpus as source material and produces compiled task contracts that exclude sibling deliverables. Implementer and reviewer prompts contain only the compiled task contract for the selected task; they do not receive whole supporting files as selected-task scope. The overall reviewer receives the full plan corpus, including referenced material, to check for planner/compiler omissions.

## Source checkbox projection and roll-forward recovery

Each compiled task contract may include a `sourceCheckbox` reference that maps the task back to a specific checkbox line in the source plan file. The orchestrator uses this reference to update the human-readable source plan after a task is completed. If the recorded line no longer matches the recorded text (modulo checkbox marker state), the update is skipped to avoid corrupting the source file.

Plan checkbox updates are intentionally not part of any commit. Plan files may be gitignored or live outside the repository, as long as `/implement` is run from inside the target repository.

pi-implement prefers recoverable roll-forward behavior when orchestration metadata is stale or imperfect:

- If planner output is missing, malformed, ungrounded in the plan corpus, or otherwise unusable, it repairs or falls back to a legacy checkbox-derived execution manifest instead of blocking before work can start.
- On resume, grounded task reconciliation treats durable task state as authoritative when source checkboxes lag behind already landed or satisfied work.
- Source checkbox projection is best-effort and skipped when the recorded source line no longer safely matches.
- Tagged worker result parsing is tolerant of extra prose and minor formatting around the required JSON result block, while still blocking on genuinely missing or invalid results.

## Config

Global config lives at:

```text
~/.pi/agent/extensions/pi-implement/config.json
```

```json
{
  "implementer": {
    "model": "provider/model-id",
    "type": "general-purpose",
    "thinking": "medium"
  },
  "reviewer": {
    "model": "provider/model-id",
    "type": "general-purpose",
    "thinking": "high"
  },
  "planner": {
    "model": "provider/model-id",
    "type": "Explore",
    "thinking": "low"
  },
  "selfHeal": {
    "model": "provider/model-id",
    "type": "general-purpose",
    "thinking": "medium"
  },
  "maxParallel": 3,
  "verifyCommand": "npm test"
}
```

pi-implement owns its role model, type, and thinking configuration separately from public `pi-subagents` defaults. If a role model is omitted, pi-implement does not pass a model override, so `pi-subagents` uses the role's subagent type default model (and then the current session model if that type has no default). If a role thinking value is omitted, the subagent session uses the current session default. If a role type is omitted, `general-purpose` is used for implementer, reviewer, and self-heal roles, and `Explore` is used for the planner. The runtime prompts are self-contained enough to work with `general-purpose`, but reviewer safety is only instruction-enforced in that mode; configure `reviewer.type` to a dedicated read-only review agent for stronger isolation.

Implementer and reviewer workers can use injected read-only `explore` on demand for broad map-building or targeted context checks. Exploration is not configured separately in pi-implement and does not expand task scope.

`maxParallel` defaults to `3` and is clamped to a hard maximum of `8`. Invalid values are ignored with a warning.

Per-task review is reviewer-led and triage-first. Reviewers may approve structurally low-risk actual diffs quickly; otherwise they continue into a full review. The final whole-feature overall review remains mandatory after all tasks land.

`verifyCommand` is an optional non-empty shell command. In parallel mode it runs from the repository root during per-task integration and final validation. If omitted, pi-implement auto-detects `test`, `typecheck`, and `build` package scripts (respecting the repo's npm/pnpm/yarn lockfile); if none exist, it falls back to an LLM integration review.

Open `/implement` and choose **Show config** to print the resolved configuration and configured role model overrides.

## Verification

The implementer chooses task-appropriate checks and is instructed to err toward more verification. The reviewer judges correctness, quality, scope, and verification sufficiency. Precommit hooks are the hard gate and are never bypassed.

## Live status

In a TUI session, pi-implement shows a status footer summarizing the current phase and a widget listing active subagents with their runtime stats (tokens, tool uses, compaction counts). It also streams `pi-implement` progress messages into the session as tasks start, finish, get reviewed, and land. These are pi-implement's own authoritative updates — the host agent stays idle while a run is in flight.

Open `/implement` and choose **View active agents** to inspect active pi-implement subagents. With one active agent it prints fallback instructions to open the agent via `/agents`; with multiple agents it prompts you to pick by pretty label.

## Recovery

Open `/implement` and choose **Stop run** to halt local orchestration and request that active subagents stop. If a run is blocked or stopped, choose **Inspect artifacts** to locate the run directory and worktrees under `<repo>/.pi/implement/` and see each task's status, fix or revert as needed, return to a clean state (except for intended plan checkbox state), then rerun `/implement <plan.md>`.

Choose **Cleanup artifacts** to remove durable state and worktrees left behind by failed, blocked, or stopped runs. It refuses while a run is active or another session holds a live run lock, and prunes stale locks it can prove are dead. Successful runs are cleaned up automatically.

pi-implement automatically registers `/.pi/implement/` in the repo-local `.git/info/exclude` on startup, so its runtime state never appears as an untracked file in `git status`.
