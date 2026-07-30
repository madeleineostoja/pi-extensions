# Implementation

Implement is Pipkin's autonomous software implementation system and parallel agent orchestrator. Give `/implement` a Markdown plan and it owns the run from planning through reviewed publication.

Before coding starts, a high-reasoning planner reads the complete linked plan material and creates one immutable, dependency-aware schedule. It groups work at stable implementation and review boundaries: shared context and cumulative review can justify a multi-task workstream, while a narrower recovery scope can justify a split, including a dependent chain. Dedicated implementer and reviewer agents then work in isolated Git worktrees. Independent workstreams proceed concurrently up to the configured capacity; capacity is useful, not a requirement to split or to fill every slot. Review findings go back through bounded repair loops, and a final review checks the result as a whole.

The complete source plan is the shipment boundary. An approved intermediate candidate can establish a contract for a dependent workstream, but it must remain coherent and safe to publish. The target branch has one controlled writer. Pipkin integrates approved work serially, runs ordinary Git hooks, verifies the commit it prepared, and uses compare-and-swap protection when advancing the branch. Durable state and retained evidence make interrupted and failed runs inspectable and safely cleanable.

This is not a public-agent fan-out or a prompt loop around a checklist. Implement owns scheduling, workspace isolation, review, recovery, publication, and plan projection as one system.

It is powerful and intentionally opinionated. Learn it in a disposable checkout before relying on unfamiliar hooks or project conventions.

## Write a plan

A plan contains one section of Markdown checkboxes. The heading can have any name or be absent. The least-indented checkboxes are executable tasks; nested boxes remain context.

```md
# Release work

## Delivery

- [ ] Add the API endpoint
  - [ ] Return useful validation errors
- [ ] Update the client
- [ ] Document the new flow

[Design notes](docs/design.md)
```

Only unchecked tasks execute. A plan with no unchecked tasks is a no-op.

Pipkin follows ordinary local Markdown links recursively and freezes the reachable documents as the planning and review corpus. This lets a concise checklist point to designs and acceptance criteria without pasting everything into each task.

The corpus is bounded to 50 files and 200,000 characters. Missing, unreadable, empty, escaping, or invalid local Markdown targets block the run. Images, external URLs, fragment-only links, and non-Markdown files are not added to the corpus. Code paths, proposed files, URLs, tickets, and other pointers in plan text remain ordinary task instructions; they do not need to be corpus documents.

## Start a run

From a clean checkout on a named local branch:

```text
/implement path/to/plan.md
```

Running `/implement` without arguments opens a phase-aware menu for current and retained checkout runs.

A new run requires:

- a resolvable `HEAD` on a named local branch;
- no merge, rebase, cherry-pick, or revert in progress;
- a clean index and worktree, including nonignored untracked files.

It does not require an upstream, remote, package manager, configured validation command, or hook dry run.

## What happens under the hood

1. **Plan once.** A planner produces one strict immutable execution plan that covers every unchecked task exactly once, identifies dependencies, and groups static workstreams.
2. **Work in isolation.** Eligible workstreams receive disposable owned Git worktrees. Independent streams may implement and review concurrently up to `workerConcurrency`; dependent streams receive bases that already contain completed dependencies.
3. **Keep evidence.** Task coverage and commit provenance are distinct: implementers may retain meaningful intermediate checkpoints, while changed tasks without one use the validated final candidate tip. Verification is retained as concise statements of what was checked and the outcome, whether by tests, static analysis, or direct inspection. If a task is already satisfied, Pipkin asks for current-repository review instead of manufacturing a change.
4. **Review before publication.** Initial review first assesses every ordered contract, then the cumulative candidate for interactions, regressions, verification, and unnecessary machinery. Findings return through bounded repair and review. A checkpoint is not completion.
5. **Publish one at a time.** When all managed agents are idle, the serialized integration lane replays an approved candidate onto the current target, commits it with the implementer-authored cumulative workstream message, runs ordinary commit hooks, verifies the prepared commit, records publication intent, and advances the target with compare-and-swap protection.
6. **Project completion.** Published or reviewed-as-satisfied tasks update their source checkboxes. Whole-plan review can send further findings through the same repair, review, integration, and publication path. The run completes only after its remaining projection debt is settled.

The result is parallel work where it is safe and a single accountable lane where Git history changes.

## Protecting the target checkout

The invoking checkout remains orchestrator-owned. Managed agents do not run while integration or publication is active, and publication does not run while managed agents are active.

Before and after managed work, Pipkin verifies:

- target checkout and branch identity;
- absence of an unexpected Git operation;
- cleanliness outside protected plan projections;
- exact hashes of protected source material and projected plans.

A boundary problem reports the exact paths and terminally fails the run. A boundary change during managed work is a safety failure because Pipkin cannot safely attribute its source.

Published commits are never rolled back just because a later checkbox projection or owned-resource cleanup needs another attempt. Plan checkbox changes are expected dirt while the run is active and ordinary working changes after it completes.

## Durable state and recovery

Each checkout owns its runs:

```text
<checkout>/.pi/pipkin/implement/
  checkout.lock
  checkout.owner.json
  runs/<run-id>/
    execution-plan.json
    run-state.json
    artifacts/
  worktrees/<run-id>/
  trash/
```

`run-state.json` is authoritative. UI, evidence, status output, and Markdown checkboxes are projections of it.

One OS-backed lease protects each checkout's active run and destructive cleanup. Linked checkouts have independent state and can run separately. A second run in the same checkout is rejected.

Live recovery retains the gate, candidate, workspace, complete current findings, prior actions, and mutation boundary while the current actor remains alive. Recovery packets embed actionable findings inline; retained artifacts are diagnostic provenance, not worker-readable input. When recovery is exhausted, the run fails rather than reconstructing workers later.

Stopping is transient while owned processes settle. Failed and completed runs are terminal. A crash-retained active run is terminalized as interrupted under the checkout lease without launching workers. Cleanup settles exact durable publication and projection transactions first, preserves published target and plan changes, and removes only resources Pipkin can prove it owns.

## Commands

```text
/implement
/implement <plan.md>
/implement restart <plan.md> <completed-run-id>
/implement status
/implement status <run-id>
/implement inspect <run-id>
/implement cleanup <run-id>
/implement stop
```

| Command   | Purpose                                                                                        |
| --------- | ---------------------------------------------------------------------------------------------- |
| `status`  | Show phases, findings, gates, leases, and projection debt                                      |
| `inspect` | Show durable state and evidence paths for one run                                              |
| `stop`    | Settle owned processes and terminally fail the active run safely                               |
| `restart` | Clean a completed run after new-run preflight and start again                                  |
| `cleanup` | Terminalize interrupted runs, settle durable transactions, and remove provably owned resources |

The active session also shows a diagnostic widget with overall progress, workstream stages, recent failures, and open findings.

## Models and concurrency

Implement uses `high` for planning and review and `medium` for implementation and recovery. `implement.workerConcurrency` defaults to `3` and caps at `8`.

Implementers choose appropriate project verification. There is no configured validation command, automatic validation-command discovery, role-specific persistent model override, or Implement-only reviewer watchdog. Use Pipkin's generic `/agents` controls for supervision.

## Development tests

Implement tests are partitioned by the boundary they exercise. `implement-unit` owns packet, parser, reducer, scheduler, model, and scripted worker behavior and does not invoke Git. `implement-integration` owns managed Pi runtime integration and focused real-Git contracts such as worktrees, hooks, replay, index behavior, and publication durability. `implement-e2e` is serial and owns the complete correction/publication journey.

Run the layers independently or together from the repository root:

```sh
npm run test:subagents
npm run test:implement:unit
npm run test:implement:integration
npm run test:implement:e2e
npm run test:implement
npm run test
```

The root `npm run test` remains authoritative and executes every project once.

See [Configuration](../configuration.md) for model routing and settings.
