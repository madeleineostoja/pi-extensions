# Implementation

Implement is Pipkin's autonomous software implementation system. Give it a Markdown plan and it owns dependency-aware scheduling, isolated workspaces, review and repair, serialized publication, and durable evidence.

```text
/implement path/to/plan.md
```

Use it in a disposable checkout before relying on unfamiliar hooks or project conventions.

## Quick start

A plan needs one set of Markdown checkboxes. The least-indented unchecked boxes are executable tasks; nested boxes remain context.

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

Start from a clean checkout on a named local branch:

```text
/implement path/to/plan.md
```

A new run requires:

- a resolvable `HEAD` on a named local branch;
- no merge, rebase, cherry-pick, or revert in progress; and
- a clean index and worktree, including nonignored untracked files.

It does not require an upstream, remote, package manager, configured validation command, or hook dry run.

## Plan corpus

Implement follows ordinary local Markdown links recursively and freezes reachable documents as the planning and review corpus. A concise checklist can therefore link to designs and acceptance criteria without repeating them in every task.

| Boundary                    |   Value |
| --------------------------- | ------: |
| Maximum corpus files        |      50 |
| Maximum combined characters | 200,000 |

Missing, unreadable, empty, escaping, or invalid local Markdown targets block the run. Images, external URLs, fragment-only links, and non-Markdown files are not added. Code paths, proposed files, URLs, tickets, and other pointers remain ordinary task instructions.

## Run lifecycle

1. **Plan once.** A high-reasoning planner creates one immutable schedule covering every unchecked task exactly once. It identifies dependencies and groups work at coherent implementation and review boundaries.
2. **Work in isolation.** Eligible workstreams receive owned disposable Git worktrees. Independent streams may run concurrently; dependent streams start from bases containing completed dependencies.
3. **Retain evidence.** Implement records task coverage, candidate provenance, and concise verification statements. Already-satisfied tasks receive current-repository review instead of manufactured changes.
4. **Review and repair.** Pipkin derives candidate identity from the owned worktree rather than trusting worker-reported Git state. Initial review assesses each ordered contract and the cumulative candidate. Every material finding receives one bounded correction opportunity followed by anchored reassessment.
5. **Publish serially.** One integration lane replays reviewed contributions onto the current target, runs ordinary Git hooks, verifies the prepared commit, and advances the branch with compare-and-swap protection. Conflicting or semantically changed replay goes through bounded reconciliation and fresh review without giving the worker target-write authority.
6. **Review the whole result.** After all source work is delivered, a final reviewer assesses the complete plan. One bounded whole-plan repair and final review may follow. Completed task checkboxes are projected only from durable scheduler state.

Managed agents never run while integration or publication is active, and publication never runs while managed agents are active. The target checkout remains orchestrator-owned throughout.

## Outcomes and recovery

| Outcome              | Meaning                                                                                                                      | Next step                                                                   |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `completed`          | Every source workstream was delivered and projected, followed by whole-plan review                                           | Read the durable handoff; clean retained history when no longer needed      |
| `incomplete`         | Independent work settled, but some source tasks could not be safely delivered                                                | Inspect evidence, then explicitly clean before another run in that checkout |
| `failed`             | The run was stopped/interrupted or a safety, ownership, persistence, projection, or publication boundary could not be proven | Inspect retained candidates and evidence; clean when finished               |
| `dependency_skipped` | A workstream could not run because a direct dependency was unavailable                                                       | Diagnose the causal failed workstream rather than the derivative skip       |

Completed and partial runs capture a concise durable handoff. It summarizes delivered state, verification, residual findings, and exact inspection or cleanup commands without dumping forensic details into the transcript.

Pipkin does not roll back published commits, auto-resume a terminal run, or automatically publish retained candidates. Independent successful lanes may remain published when another lane fails. Failed or interrupted workspaces are retained when needed for diagnosis.

A crash-retained active run is terminalized as interrupted under the checkout lease without launching workers. Cleanup first settles durable publication and projection transactions, preserves published target and plan changes, and removes only resources Pipkin can prove it owns.

## Commands

| Command                                           | Purpose                                                                                               |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `/implement`                                      | Open the phase-aware menu for current and retained checkout runs                                      |
| `/implement <plan.md>`                            | Start a new run                                                                                       |
| `/implement restart <plan.md> <completed-run-id>` | Preflight a new run, clean the specified completed run, and start again                               |
| `/implement status`                               | Show current and retained outcomes, phases, findings, failures, leases, receipts, and projection debt |
| `/implement inspect <run-id>`                     | Show durable state and evidence paths for one run                                                     |
| `/implement cleanup <run-id>`                     | Settle terminal state and remove provably owned resources after confirmation                          |
| `/implement stop`                                 | Settle owned processes and terminally stop the active run                                             |

The menu also offers **Clean completed runs (N)** for retained completed history. It does not include failed, incomplete, or historical entries.

`inspect_implement_run` is the read-only model-facing inspection tool. Without `runId`, it lists retained runs in the current checkout; with `runId`, it summarizes that run and reports authoritative artifact paths for ordinary reads. Its collapsed row identifies the retained run and point-in-time phase; expanding it shows the complete bounded inspection artifact. Managed Implement workers cannot call it.

The shared Activity view shows active workstreams. `/agents` remains the detailed live and retained worker inspector.

## Target protection and Sandbox

Before and after managed work, Pipkin verifies target checkout and branch identity, absence of unexpected Git operations, cleanliness outside protected plan projection, and exact hashes of protected source material. An unattributable boundary change terminally fails the run and reports affected paths.

| Worker role                                                     | Enabled macOS Sandbox mode           |
| --------------------------------------------------------------- | ------------------------------------ |
| Planner and all reviewers                                       | Repository read-only                 |
| Implementation, revision, reconciliation, and whole-plan repair | Workspace write in an owned worktree |

`/sandbox off` affects later child snapshots only. Linux remains instruction-only, and this trusted-agent defense is not hostile-code isolation. Managed workers may record qualifying Papercuts; that shared personal-metadata write grants no source, Git, or orchestration authority.

Published commits are not rolled back because a later checkbox projection or resource cleanup needs another attempt. Plan checkbox updates are expected dirt while a run is active and ordinary working changes after completion.

## Durable state

Each checkout owns its Implement state:

```text
<checkout>/.pi/pipkin/implement/
  checkout.lock
  checkout.owner.json
  runs/<run-id>/
    execution-plan.json
    source-corpus.json
    run-state.json
    artifacts/
  worktrees/<run-id>/
  trash/
```

`run-state.json` is authoritative. UI, status, evidence views, and Markdown checkboxes are projections. `source-corpus.json` preserves immutable planning input; the execution plan preserves the schedule.

One OS-backed lease protects each checkout's active run and destructive cleanup. Linked checkouts own independent state and may run separately; a second run in the same checkout is rejected.

State is versioned. Before upgrading across an incompatible lifecycle version, settle and clean retained runs with the previous runtime. Newer runtimes reject legacy run state rather than guessing how to resume it.

## Models and concurrency

| Work                                                            | Preset   |
| --------------------------------------------------------------- | -------- |
| Planning and review                                             | `high`   |
| Implementation, revision, reconciliation, and whole-plan repair | `medium` |

`implement.workerConcurrency` defaults to `3` and caps at `8`. Capacity permits parallel work but does not force plan splitting or full utilization. Publication is always serialized.

Implementers choose project-appropriate verification. Pipkin has no configured validation command, automatic command discovery, role-specific persistent model override, or Implement-only reviewer watchdog. Use `/agents` for supervision.

See [Configuration](../configuration.md) for settings and model presets.

## Development tests

Implement uses separate Vitest projects:

| Project                 | Boundary                                                                                    |
| ----------------------- | ------------------------------------------------------------------------------------------- |
| `implement-unit`        | Packets, parser, reducer, scheduler, models, and scripted workers without Git               |
| `implement-integration` | Managed Pi runtime and real-Git worktrees, hooks, replay, index, and publication durability |

```sh
npm run test -- --project implement-unit
npm run test -- --project implement-integration
npm run test -- --project implement-unit --project implement-integration
```

The root `npm run test` remains authoritative.
