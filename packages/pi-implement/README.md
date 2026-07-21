# pi-implement

Autonomously implement a markdown plan file, working through its unchecked tasks one at a time and making a commit per task. Any plan with a `## Tasks` checklist works — it does not require output from a specific `/plan` skill or a particular plan template.

Each task is handled by an implementer subagent and then judged by a reviewer subagent. Only approved work is committed, and after every task lands a final reviewer checks the whole feature against the plan. Independent tasks can run concurrently in isolated git worktrees.

## Capabilities

- **Autonomous task loop** — drives the full implement → review → commit cycle per task without human input, one commit per approved task.
- **Independent review gate** — a separate reviewer returns atomic typed findings with stable IDs. Rework preserves one cumulative candidate and continues while the outstanding set reaches new lows; two consecutive non-improving rounds stall for recovery rather than silently discarding work.
- **Whole-feature overall review** — once all tasks land, a read-only reviewer assesses the combined diff against the original plan and can require follow-up work.
- **Dependency-aware execution** — schedules independent tasks concurrently in isolated worktrees up to configured worker concurrency, while dependencies and integration order remain explicit.
- **Subagent isolation checks** — implementers and reviewers run from their assigned worktree; the orchestrator detects and blocks (or auto-heals) any out-of-bounds change to HEAD, the candidate diff, the main checkout, or plan artifacts.
- **Built-in verification** — runs a configured verify command or auto-detected `test`/`typecheck`/`build` scripts, with an LLM integration review as a last resort. Precommit hooks are a hard gate and are never bypassed.
- **Plan corpus ingestion** — the entry plan and the markdown files it links to (plus `tasks/` siblings) are ingested into the planner's corpus and distilled into per-task contracts, rather than being inlined wholesale into the implementer's context.
- **Durable retained state** — a strict, revisioned canonical run aggregate plus round artifacts, candidate identities, review ledgers, and worktrees are persisted under `<repo>/.pi/implement/`; successful runs auto-clean, while stalled candidates remain inspectable and explicitly cleanable.
- **Live progress** — a TUI status footer and per-agent widget (tokens, tool uses, compactions) plus progress messages streamed into the session.

## Usage

```text
/implement                          # open the interactive action menu
/implement path/to/plan.md          # execute with configured worker concurrency
/implement path/to/plan.md --resume <run-id> # explicitly resume a retained run
/implement path/to/plan.md --start-over <run-id> # explicitly discard one retained run and start again
```

The interactive menu includes status, stop, inspect, cleanup, config, and active-agent viewing actions.

Plan paths passed directly must not contain spaces. Use the interactive menu, a symlink, or a rename if needed.

## Execution strategy

A progressive planner derives a dependency graph and worker-concurrency limit, inspecting the repository only when needed. Invalid planner output, planner failures, and invalid graphs fall back to concurrency one with a plan-order dependency chain. Set worker concurrency to one in configuration when no task overlap is wanted.

Independent tasks run concurrently up to `workerConcurrency` from config, with a hard maximum of `8`. `maxParallel` is accepted only as a deprecated configuration alias and is never persisted. Each autonomous worker runs from its assigned task worktree as its current working directory; pi-implement owns those worktrees and validates the boundaries around them.

## Execution planning and compiled task contracts

`/implement` accepts a human plan file, compiles an internal execution manifest, and executes compiled task contracts. The execution planner reads the human plan corpus, derives scoped task contracts and a dependency graph, and the orchestrator gives implementer/reviewer agents only the selected compiled contract.

The source plan remains the human-facing contract. The compiled execution manifest is an internal pi-implement artifact used to execute that human plan safely. Legacy Markdown checkbox plans are still supported as an ingestion fallback: the orchestrator parses the source plan, auto-generates a minimal compiled contract for each task, and projects checkbox state back to the source file.

## The per-task loop

For each unchecked task, pi-implement:

1. Loads the compiled task contract for the selected task from the execution manifest. The contract includes a precise objective, in-scope items, acceptance criteria, and out-of-scope items. Sibling task contracts are intentionally omitted.
2. Stages the candidate changes, excluding plan artifacts and never force-adding ignored files. Staging before review lets the reviewer see new untracked files via `git diff --cached HEAD`.
3. Spawns a reviewer subagent to judge the staged candidate against the compiled contract.
4. On approval, finalizes and integrates the exact reviewed checkpoint. On changes requested, retains that checkpoint and re-runs the implementer from it with the outstanding typed findings.

Each finding is atomic and receives an orchestrator-owned ID. Anchored re-reviews assess every outstanding ID and can add only regressions caused by the latest candidate delta. Semantic progress is a strict low-water mark: there is no total review cap, but two consecutive rounds that do not beat the best outstanding count stall the retained candidate. Provider and protocol failures remain separately bounded safety retries.

An implementer may report `already_satisfied` when the current repository state already meets the task and no changes are needed. In that case a dedicated reviewer verifies the claim against the repo, and on approval the checkbox is marked without an empty commit.

## Overall review

After the last task is committed (and, in parallel mode, after final validation), a read-only overall reviewer inspects the combined base→HEAD diff against the full plan to catch cross-task gaps, missed edge cases, and integration problems.

If the overall reviewer requests changes, pi-implement creates an isolated cumulative overall candidate. The main checkout remains untouched until that candidate is approved and integrated. Overall review uses the same typed finding and low-water convergence rules as task review. A stalled overall candidate stays in the retained run directory with its worktree, branch, convergence evidence, and a stall artifact; it is not reduced to an external prose-only follow-up file.

## Parallel execution and integration

In parallel mode, the planner produces a dependency graph and a scheduler runs ready tasks concurrently, up to the effective concurrency limit. Each task gets its own branch and worktree, and the worker's `cwd` is that task worktree so file reads, commands, and edits target the isolated checkout.

Canonical integration is serialized per run through an owned staging worktree. Approved candidates are applied, validated, and committed there while the target checkout remains unchanged. Publication is a short Git-native fast-forward after target identity, branch, cleanliness, and protected-artifact checks. Retained legacy execution paths still use the older integration behavior while the refactor is being completed. A final validation pass runs before the overall review.

## Run ownership and recovery

Each run owns the checkout and branch from which it starts. pi-implement rejects a second active run in that same checkout, but supports simultaneous runs from distinct linked worktrees on distinct branches in the same repository. Each run has a target-scoped lock, state directory, index, and owned-workspace namespace.

The durable `canonical-run-state.json` aggregate is the lifecycle authority. Events, status UI, Markdown artifacts, and source-plan checkboxes are projections and may be rebuilt; they are never used to infer task completion, a reviewed candidate, or an integration result. State is revisioned, strictly validated, atomically replaced, and rejects historical/corrupt retained runs with start-over or cleanup guidance. Required checkbox/status projection and owned-workspace cleanup are tracked as recoverable debt rather than discarding landed work.

While a run is active, user or third-party mutation of that run's target checkout, target branch, or pi-owned refs/worktrees is unsupported. Unrelated linked worktrees and branches remain usable. Persistent locks, unexplained target changes, or ambiguous ownership pause the run with approved candidates retained. pi-implement never automatically deletes Git lock files. Old retained runs use an incompatible state format and require start-over or explicit cleanup.

## Safety boundaries

Implementer and reviewer prompts are self-contained contracts that instruct subagents not to touch git state or plan files. The orchestrator enforces this regardless of subagent behavior by snapshotting and re-checking around every subagent call:

- Implementers may not change HEAD, dirty the main checkout outside their task worktree, or modify plan artifacts — any of these blocks the run.
- Reviewers are read-only; benign reviewer mutations to the candidate diff are auto-healed back to the reviewed state, and unhealable changes block the run.
- The overall reviewer must leave HEAD, the staged state, the worktree, and plan artifacts unchanged.
- Internally owned workers run through `pi-subagents`, inherit the host extension environment, and use pi-implement-selected tool sets: implementation and self-heal roles use the host's active tools, while review and planning roles use read-oriented tools. The remaining mutating self-heal role is a legacy mechanism pending removal; canonical integration uses deterministic reconciliation.

Plan checkbox updates are intentionally not part of any commit. Plan files may be gitignored or live outside the repository, as long as `/implement` is run from inside the target repository.

## Runtime integration and requirements

- The current directory must be inside a git repo with a clean worktree, ignoring the source plan artifact and any validated supporting plan artifacts.
- Node.js 24 or newer is required.
- `pi-implement` uses the bundled first-party `pi-subagents` runtime directly. Installing the root `pi-extensions` bundle registers `pi-subagents` before `pi-implement`, so implementer, reviewer, planner, and legacy self-heal workers run in-process without external installation or RPC setup.
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
  "workerConcurrency": 3,
  "verifyCommand": "npm test",
  "selfHeal": {
    "model": "provider/model-id",
    "type": "general-purpose",
    "thinking": "medium"
  }
}
```

pi-implement owns its role model, type, and thinking configuration separately from public `pi-subagents` defaults. If a role model is omitted, pi-implement does not pass a model override, so `pi-subagents` uses the role's subagent type default model (and then the current session model if that type has no default). If a role thinking value is omitted, the subagent session uses the current session default. If a role type is omitted, `general-purpose` is used for implementer, reviewer, and legacy self-heal roles, and `Explore` is used for the planner. The runtime prompts are self-contained enough to work with `general-purpose`, but reviewer safety is only instruction-enforced in that mode; configure `reviewer.type` to a dedicated read-only review agent for stronger isolation.

Implementer and reviewer workers can use injected read-only `explore` on demand for broad map-building or targeted context checks. Exploration is not configured separately in pi-implement and does not expand task scope.

`workerConcurrency` defaults to `3` and is clamped to a hard maximum of `8`. It controls candidate-worker overlap only; target publication remains serialized per run. Invalid values are ignored with a warning. `maxParallel` remains an input-only deprecated alias for user convenience.

Per-task review is reviewer-led and triage-first. Reviewers may approve structurally low-risk actual diffs quickly; otherwise they continue into a full review. The final whole-feature overall review remains mandatory after all tasks land.

`verifyCommand` is an optional non-empty shell command. In parallel mode it runs from the repository root during per-task integration and final validation. If omitted, pi-implement auto-detects `test`, `typecheck`, and `build` package scripts (respecting the repo's npm/pnpm/yarn lockfile); if none exist, it falls back to an LLM integration review.

Open `/implement` and choose **Show config** to print the resolved configuration and configured role model overrides.

## Verification

The implementer chooses task-appropriate checks and is instructed to err toward more verification. The reviewer judges correctness, quality, scope, and verification sufficiency. Precommit hooks are the hard gate and are never bypassed.

## Live status

In a TUI session, pi-implement shows a status footer summarizing the current phase and a widget listing active subagents with their runtime stats (tokens, tool uses, compaction counts). It also streams `pi-implement` progress messages into the session as tasks start, finish, get reviewed, and land. These are pi-implement's own authoritative updates — the host agent stays idle while a run is in flight.

Open `/implement` and choose **View active agents** to inspect active pi-implement subagents. With one active agent it prints fallback instructions to open the agent via `/agents`; with multiple agents it prompts you to pick by pretty label.

## Recovery

Open `/implement` and choose **Stop run** to halt local orchestration and request that active subagents stop. If a run is blocked, stopped, or stalled, choose **Inspect artifacts** to locate its run directory, task/overall candidates, outstanding finding IDs, and per-round evidence under `<repo>/.pi/implement/`. Every round retains its implementer/reviewer prompts and typed results, candidate identity/diff, finding transition, validation evidence, runtime health/model metadata when available, and any discarded worker-delta bundle.

A direct headless/RPC/JSON/print invocation never creates a competing run when a retained compatible run exists: use `--resume <run-id>` or `--start-over <run-id>`. Historical state remains inspectable and cleanable but cannot be resumed. Start-over is destructive and refuses live owners. Choose **Cleanup artifacts** to explicitly remove retained task and overall worktrees/branches; it is idempotent. Successful runs are cleaned automatically.

When a worker fails before a valid completion, pi-implement captures a hashed discarded-delta bundle (tracked patch, untracked archive, and manifest) and proves the candidate's HEAD, index, worktree, untracked paths, Git operation, and protected plan artifacts were restored before retrying.

pi-implement automatically registers `/.pi/implement/` in the repo-local `.git/info/exclude` on startup, so its runtime state never appears as an untracked file in `git status`.
