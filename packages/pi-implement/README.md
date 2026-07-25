# pi-implement

`/implement` executes an unchecked Markdown plan through checkout-owned VNext workstreams.

## Lifecycle

1. Parse the plan and recursively ingest ordinary local Markdown links as immutable source material.
2. Compile one strict execution plan with exact task coverage, contracts, dependencies, and static workstreams.
3. Run ready independent workstreams concurrently within `workerConcurrency`; each implementer owns a disposable Git worktree and commits checkpoints.
4. Independently review each cumulative candidate. Material findings enter a durable recovery episode and anchored re-review.
5. Replay approved candidates onto staging from the current target and publish through a serialized write-ahead transaction.
6. Project published task checkboxes atomically, settle cleanup debt, then review the complete plan and repair any findings through the same workstream machinery.

The target checkout is orchestrator-owned. Implementers may repair normal dependencies, caches, and runtime state in their owned workspace and choose appropriate verification. There is no configured or auto-detected validation command.

## Safety and retained state

State belongs to the checkout that invoked `/implement`:

```text
<checkout>/.pi/implement/
  checkout.lock
  checkout.owner.json
  runs/<run-id>/execution-plan.json
  runs/<run-id>/run-state.json
  worktrees/<run-id>/
```

One OS-backed checkout lease covers run and cleanup mutations. `run-state.json` is the only lifecycle authority; events, status output, evidence, and Markdown checkboxes are projections. Owned worktrees are disposable, but committed checkpoints and durable evidence are retained. Historical run formats cannot resume or be converted.

Source checkboxes change only after their workstream publishes or receives reviewed already-satisfied completion. Publication, projection, and cleanup failures are retained as recoverable debt; successful publication is never rolled back for projection or cleanup.

## Usage

```text
/implement path/to/plan.md
/implement path/to/plan.md --resume <run-id>
/implement path/to/plan.md --start-over <run-id>
/implement :status
/implement :inspect <run-id>
/implement :cleanup <run-id>
/implement :stop
```

## Configuration

`~/.pi/agent/extensions/pi-implement/config.json` accepts role overrides for `planner`, `implementer`, `reviewer`, and `recovery`, plus bounded `workerConcurrency` (default `3`, maximum `8`). A recovery role inherits the implementer model and thinking configuration unless overridden.

```json
{
  "workerConcurrency": 3,
  "planner": { "type": "Explore" },
  "implementer": { "model": "provider/model-id" },
  "reviewer": { "type": "Review", "thinking": "high" },
  "recovery": { "thinking": "medium" }
}
```

Managed agents use the current session's generic subagent runtime. Pi-implement has no automatic reviewer watchdog; operator controls and richer agent observability are supplied by the generic runtime.
