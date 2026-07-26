# pi-implement

`/implement` executes an unchecked Markdown plan through checkout-owned workstreams. Runs use the current pi-implement state format; retained artifacts that cannot be validated are for manual inspection or removal, not migration.

## Write a plan

A plan has exactly one section containing Markdown checkboxes. The section may have any heading, or no heading at all; `## Tasks` is not special. The least-indented checkboxes in that section are executable tasks. Nested checkboxes remain task context.

```md
# Release work

## Delivery

- [ ] Add the API endpoint
  - [ ] Return useful errors
- [ ] Update the client

[Design notes](docs/design.md)
```

Only unchecked tasks execute. A plan with no unchecked tasks is a no-op.

Pi-implement starts with the plan and recursively follows ordinary local Markdown links. The reachable Markdown files form an immutable corpus for planning and review. Images, URLs, and non-Markdown links are ignored; missing, empty, unreadable, or escaping Markdown links block the run. There is no `Plan:` syntax, sibling-directory discovery, or task-local material linkage.

## How a run works

1. Pi-implement parses the corpus and asks a planner for one strict immutable execution plan. That plan must cover every unchecked source task exactly once with grounded contracts, dependencies, and static workstreams.
2. An eligible workstream receives an immutable base from the current target only after all of its dependencies have completed. Independent workstreams may implement and review concurrently up to `workerConcurrency`.
3. Implementers work in disposable owned Git worktrees and retain committed checkpoints and evidence. Already-satisfied tasks receive repository-state review instead of a fabricated change.
4. Target publication waits until every managed agent is idle. One serialized integration lane replays an approved candidate onto the current target, runs ordinary Git commit hooks, verifies the prepared commit, records a write-ahead publication intent, and updates the target with compare-and-swap protection.
5. Reconciliation, hook failures, review findings, and recoverable execution failures enter durable recovery episodes. Recovery agents choose bounded actions in owned worktrees; target and projection safety failures stop autonomous mutation instead.
6. After publication or reviewed satisfaction, pi-implement atomically projects the corresponding source checkboxes. It then performs a whole-plan review. Findings re-enter the same repair, review, integration, and publication path until the plan closes.

A checkpoint is not completion. Source checkboxes change only after a workstream publishes or an already-satisfied task receives a current-target satisfaction receipt. Successful publication is never rolled back because checkbox projection or owned-resource cleanup needs a later retry.

## Safety, recovery, and state

The invoking checkout owns all operational state:

```text
<checkout>/.pi/implement/
  checkout.lock
  checkout.owner.json
  runs/<run-id>/
    execution-plan.json
    run-state.json
    artifacts/
  worktrees/<run-id>/
  trash/
```

One OS-backed lease covers each run and destructive cleanup in that checkout. Linked checkouts have independent state and leases. `run-state.json` is the lifecycle authority; status output, evidence, and Markdown checkboxes are projections.

A new run requires a Git worktree with a resolvable `HEAD`, a named local branch, no active merge, rebase, cherry-pick, or revert, and a clean index and worktree including nonignored untracked files. Tracked plan files are allowed while clean. No upstream, remote, package-manager, validation-command, or hook dry-run preflight is required.

The target checkout remains orchestrator-owned. Managed agents run only while integration and publication are idle; integration and publication run only while managed agents are idle. Before and after every managed agent, pi-implement verifies target identity, Git-operation state, cleanliness outside protected projections, and exact protected-artifact hashes. It safety-blocks rather than attributing unauthorized target changes to an agent.

Tracked source plans become expected working changes after checkbox projection. While the run is active, their exact retained hashes are verified and excluded from target cleanliness checks. Unrelated dirt still blocks lifecycle work. Resume first settles retained publication and projection transactions, then validates the target and protected corpus. Completed and safety-blocked runs cannot resume; use `:cleanup` for completed runs, or manually recover and use `:abandon` for paused or safety-blocked runs.

## Commands

```text
/implement path/to/plan.md
/implement path/to/plan.md --resume <run-id>
/implement path/to/plan.md --start-over <completed-run-id>
/implement :status
/implement :inspect <run-id>
/implement :cleanup <completed-run-id>
/implement :abandon <run-id>
/implement :stop
```

- `:status` lists runs in the current checkout with their phase, findings, gates, leases, and projection debt.
- `:inspect` shows a run's durable state and evidence paths.
- `:stop` settles owned processes and pauses the active session run safely.
- `--resume` resumes a nonterminal run from the same checkout after transaction-aware safety checks pass.
- `--start-over` verifies prospective new-run preflight, cleans a completed run, then starts a new run for the supplied plan.
- `:cleanup` conservatively removes a completed run's provably owned worktrees and branches. It is retryable after partial cleanup. It retains run authority and reports manual recovery paths if ownership cannot be proven. After cleanup, projected tracked files are ordinary working changes that must be committed or reverted before another run.
- `:abandon` is available only for a paused or safety-blocked run in the current checkout with no active process leases. It never changes the target and removes authority only after the same conservative owned-resource scan succeeds.

## Configuration

Configuration is optional and lives at `~/.pi/agent/extensions/pi-implement/config.json`. It accepts role overrides for `planner`, `implementer`, `reviewer`, and `recovery`, plus bounded `workerConcurrency` (default `3`, maximum `8`).

```json
{
  "workerConcurrency": 3,
  "planner": { "type": "Explore" },
  "implementer": { "model": "provider/model-id" },
  "reviewer": { "type": "Review", "thinking": "max" },
  "recovery": { "model": "provider/model-id", "thinking": "high" }
}
```

Role thinking accepts `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`; Pi may clamp it to the selected model's capability. Implementers choose and run appropriate verification for their workstream; pi-implement has no configured or auto-detected validation command. Managed agents use Pi's current-session generic subagent runtime. Recovery agents receive the retained gate, candidate, workspace, findings, prior actions, and mutation boundary, then return one typed bounded action. The `recovery` override selects that agent. There is no pi-implement-specific reviewer watchdog; use Pi's generic agent controls for supervision.

## Human follow-up

Run an interactive plan in a disposable checkout before relying on a new configuration, repository hook policy, or agent-role combination. Automated tests verify lifecycle and Git safety boundaries, but an interactive run remains the appropriate smoke test for a specific project.
