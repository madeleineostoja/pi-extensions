# pi-implement

`/implement` executes an unchecked Markdown plan through checkout-owned workstreams. It is a hard-cutover VNext extension: historical pi-implement runs cannot resume or be converted.

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

1. Pi-implement parses the plan, ingests its Markdown corpus, and asks a planner for one strict immutable execution plan.
2. The plan must cover every unchecked source task exactly once with grounded contracts, dependencies, and static workstreams. Invalid planner output blocks before implementation starts.
3. Closely related tasks are batched into an ordered workstream. Clearly independent workstreams may implement concurrently up to `workerConcurrency`.
4. An implementer works in a disposable owned Git worktree. It owns ordinary setup, dependency/cache repair, verification, and committed checkpoints. A task that is already satisfied can instead return concrete repository-state evidence.
5. An independent reviewer assesses the whole workstream candidate. Material blocking findings open a durable recovery episode with the candidate and gate evidence retained for operator resolution.
6. An approved candidate replays onto staging from the current target. Publication is serialized and uses a short write-ahead transaction. Conflicts, changed reconciliation deltas, and failed publication checks stop that publication attempt rather than publishing unchecked.
7. After publication, Pi-implement atomically checks the corresponding source tasks. It then performs a whole-plan review; any finding is repaired through the same workstream machinery.

A checkpoint is not completion. Source checkboxes change only after the containing workstream publishes, or after an already-satisfied task receives reviewed completion. Successful publication is never rolled back because checkbox projection or owned-worktree cleanup needs a later retry.

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

One OS-backed lease covers each run and destructive cleanup in that checkout. Linked checkouts have independent state and leases. `run-state.json` is the only lifecycle authority; events, status output, evidence, and Markdown checkboxes are projections.

The target checkout remains orchestrator-owned. Agents can repair routine environment state only in their owned worktree; committed checkpoints and evidence survive a provider failure, while dirty owned worktrees can be recreated. If target identity, protected plan artifacts, or restoration cannot be proven, pi-implement prevents that publication attempt.

A paused run retains its candidate, recovery evidence, projection debt, and cleanup debt. Resume from the same checkout and source plan after resolving the cause. Historical run directories are manual-inspection artifacts, not resumable state.

## Commands

```text
/implement path/to/plan.md
/implement path/to/plan.md --resume <run-id>
/implement path/to/plan.md --start-over <completed-run-id>
/implement :status
/implement :inspect <run-id>
/implement :cleanup <completed-run-id>
/implement :stop
```

- `:status` lists VNext runs in the current checkout and their phase, findings, gates, and debt.
- `:inspect` shows a run's durable state and evidence paths.
- `:stop` settles owned processes and pauses the active session run safely.
- `--resume` resumes a paused VNext run after source and checkout safety checks pass.
- `--start-over` cleans a completed VNext run, then starts a new run for the supplied plan.
- `:cleanup` removes only a completed VNext run whose durable cleanup obligations have settled. Unknown or historical artifacts require manual cleanup.

## Configuration

Configuration is optional and lives at `~/.pi/agent/extensions/pi-implement/config.json`. It accepts role overrides for `planner`, `implementer`, `reviewer`, and `recovery`, plus bounded `workerConcurrency` (default `3`, maximum `8`).

```json
{
  "workerConcurrency": 3,
  "planner": { "type": "Explore" },
  "implementer": { "model": "provider/model-id" },
  "reviewer": { "type": "Review", "thinking": "high" },
  "recovery": { "model": "provider/model-id", "thinking": "high" }
}
```

Implementers choose and run appropriate verification for the workstream; pi-implement has no configured or auto-detected validation command. Managed agents use Pi's current-session generic subagent runtime. Recovery agents receive the retained gate, candidate, workspace, findings, prior actions, and mutation boundary, then return one typed bounded action. The `recovery` override selects that agent. There is no pi-implement-specific reviewer watchdog; use Pi's generic agent controls for supervision.

## Maintenance evidence

The VNext lifecycle audit retains 111 focused test cases across 17 files. Reducer tests cover illegal transitions and durable invariants; real-Git tests cover checkout, replay, publication, projection, and cleanup boundaries; lifecycle tests cover queued actor work, recovery, and target safety. The lifecycle and real-Git boundary groups each passed three consecutive focused runs; the recorded package suite completed in 157 seconds before the mandatory workspace and root suites. These figures describe retained safety coverage, not a coverage target.

## Human follow-up

Run an interactive plan in a disposable checkout before relying on a new configuration, repository hook policy, or agent-role combination. Automated tests verify lifecycle and Git safety boundaries, but an interactive run remains the appropriate smoke test for a specific project.
