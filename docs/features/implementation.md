# Implementation

Implement is Pipkin's autonomous software implementation system and parallel agent orchestrator. Give `/implement` a Markdown plan and it owns the run from planning through reviewed publication.

Before coding starts, a high-reasoning planner reads the complete linked plan material and creates one immutable, dependency-aware schedule. It groups work at stable implementation and review boundaries: shared context and cumulative review can justify a multi-task workstream, while a narrower revision scope can justify a split, including a dependent chain. Dedicated implementer and reviewer agents then work in isolated Git worktrees, with Pipkin supplying each trusted managed worker its owned worktree cwd. Independent workstreams proceed concurrently up to the configured capacity; capacity is useful, not a requirement to split or to fill every slot. Review findings create exact bounded revision assignments, and a final review checks the result as a whole.

The complete source plan is the shipment boundary. An approved intermediate candidate can establish a contract for a dependent workstream, but it must remain coherent and safe to publish. The target branch has one controlled writer. Pipkin integrates approved work serially, runs ordinary Git hooks, verifies the commit it prepared, and uses compare-and-swap protection when advancing the branch. Durable state and retained evidence keep completed runs inspectable after their disposable Git resources are released, while interrupted and failed runs retain their workspaces for diagnosis and safe cleanup.

This is not a public-agent fan-out or a prompt loop around a checklist. Implement owns scheduling, workspace isolation, review, revision policy, publication, and plan projection as one system.

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
4. **Review before publication.** Implement derives candidate branch, commit, tree, and changed paths from the owned worktree rather than trusting worker-reported Git identity. A clean committed candidate remains reviewable when semantic completion is unavailable; dirty or unsafe workspaces are retained for inspection rather than reset. Initial review then assesses every ordered contract, the cumulative candidate, verification, and unnecessary machinery. Canonical findings retain immutable scheduler-owned identities, scope, and introduction provenance with reviewer-owned `open` or `resolved` status. Every initial finding receives one correction opportunity. Final reassessment may retain open residual findings but clears pending correction authority. The revision worker reports only semantic evidence; Pipkin observes the next candidate and anchors a fresh review. A checkpoint is not completion.
5. **Publish one at a time.** When all managed agents are idle, the serialized integration lane replays an approved candidate's reviewed contribution from its integration base (or its original workstream base) onto the current target. If that replay conflicts, overlaps semantically, or produces a changed patch, Pipkin retains that exact target and sends the owned candidate worktree to a dedicated reconciliation worker. The worker merges the retained target into the candidate and preserves both histories; Pipkin admits only a clean observed dual-ancestry candidate, then independently reviews its target-relative contribution before retrying ordinary replay. Reconciliation never grants target-write authority. After review, the lane commits the replay with the initial cumulative reviewer's workstream-wide publication subject, runs ordinary commit hooks, verifies the prepared commit, records publication intent, and advances the target with compare-and-swap protection.
6. **Project completion.** Published or reviewed-as-satisfied tasks update their source checkboxes. Whole-plan review receives every retained open source concern as context, may send one complete whole-plan finding set through one repair and final pre-publication review, and retains any final residual concerns. A changed repair completes only after its exact publication receipt; an unchanged repair settles only against its exact reviewed target. The run completes only after its remaining projection debt is settled.

Checkpoint and correction commit subjects remain internal provenance. The first reviewer of a changed workstream authors its publication subject during cumulative review, even when requesting changes; subsequent anchored reviews preserve that subject while assessing only the correction. Already-satisfied workstreams create no publication commit.

The result is parallel work where it is safe and a single accountable lane where Git history changes.

## Delivery outcomes

A run is `completed` only after every source workstream is delivered, projected, and approved by whole-plan review. The accepted whole-plan reviewer draft is the authoritative handoff: an approved repair replaces the initial draft, while material final residual findings remain reported without blocking completion. The draft summarizes the outcome, every material change worth reporting, passed and unavailable verification, and known residual findings; a compact deterministic receipt adds publication provenance and the inspection command. Once completion is durable, Pipkin captures exactly one durable, TUI-rendered handoff entry in the session transcript before best-effort removal of the run's owned candidate and staging worktrees and branches and release of the checkout lease. The entry is not model context and does not trigger an agent turn. It is distinct from the shared Activity projection and deterministic notifications. If Pi is busy, delivery waits for an idle `agent_settled`; an undelivered handoff blocks another execution or restart in that session but leaves `status`, `inspect`, `stop`, and `cleanup` available. Cleanup failure does not change the successful outcome or suppress the captured handoff; it retains the existing warning and leaves remaining resources for explicit cleanup. State, evidence, and the captured handoff remain usable after completed Git resources are gone. A lane that exhausts its bounded worker, review, revision, reconciliation, hook, or workspace-recreation policy becomes `failed`; queued descendants with an unavailable direct dependency become `dependency_skipped`. Their candidates, findings, worktrees, and bounded evidence remain retained and unpublished. Independent lanes continue, and any successful publication keeps its checkbox projection.

Once no safe work, lease, publication transaction, or projection debt remains, a partial run settles as `incomplete`. Failed and skipped source tasks stay unchecked, and whole-plan review does not run over a partial result. `incomplete` and failed/interrupted terminal runs capture one deterministic handoff grouped into run outcome, delivered and undelivered workstreams, causal failures and residual findings, retained-state actions, and a compact receipt. The report prefers actionable failures over derivative dependency skips, deduplicates earlier worker-attempt evidence, and leaves candidate identities, workspace paths, and complete forensic records to `/implement inspect <run-id>`. It gives exact inspection and `/implement cleanup <run-id>` commands and states explicitly that the terminal run cannot resume. `incomplete` blocks another run in the same checkout until confirmed cleanup and is distinct from `failed`, which is reserved for explicit stop/interruption or a target, ownership, persistence, projection, or publication-safety boundary that cannot be proven. Pipkin does not roll back, auto-resume, or publish retained candidates.

## Protecting the target checkout

The invoking checkout remains orchestrator-owned. Managed agents do not run while integration or publication is active, and publication does not run while managed agents are active. Each worker receives its controlled worktree cwd and initializes its own enabled Sandbox policy there.

Before and after managed work, Pipkin verifies:

- target checkout and branch identity;
- absence of an unexpected Git operation;
- cleanliness outside protected plan projections;
- exact hashes of protected source material and projected plans.

A boundary problem reports the exact paths and terminally fails the run. A boundary change during managed work is a safety failure because Pipkin cannot safely attribute its source.

Published commits are never rolled back just because a later checkbox projection or owned-resource cleanup needs another attempt. Plan checkbox changes are expected dirt while the run is active and ordinary working changes after it completes. Resource cleanup preserves these projections silently.

## Durable state and failure policy

Each checkout owns its runs:

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

`run-state.json` is authoritative. UI, evidence, status output, and Markdown checkboxes are projections of it. `source-corpus.json` is immutable run input beside the execution plan: it retains the frozen root plan and linked Markdown content used to prepare worker packets. Implementers receive only their assigned contracts and selected snapshot material; reviewers and revision workers additionally receive the complete frozen corpus and a worker-safe schedule for interpretation and dependency context. The corpus is not evidence or a worker-readable filesystem path. Pipkin continues to verify the live protected source files for integrity and checkbox projection; the snapshot never bypasses those checks. Every worker attempt remains durably owned until its exact terminal result settles; completed attempts retain their settlement identity so late or conflicting worker output cannot affect a newer attempt.

Implement state is versioned. Before upgrading to an incompatible lifecycle version, settle and clean retained runs with the previously loaded runtime. A newer runtime rejects legacy run state rather than guessing how to resume it.

One OS-backed lease protects each checkout's active run and destructive cleanup. Linked checkouts have independent state and can run separately. A second run in the same checkout is rejected.

Failures retain their real category, candidate, lifecycle gate, target evidence, and workspace observation. Failed replay reconciliation retains the exact failed target, replay disposition, canonical relevant paths, candidate identity, and bounded staging and hook evidence; it never guesses from a later target. The scheduler—not a model—selects a bounded review retry, the one candidate correction, failed-target reconciliation, workspace recreation, or operational retry. Revision and reconciliation packets bind exact observed candidates and comparison bases; a reconciliation integration base remains the review base through later revisions. Provider/protocol attempts remain bounded separately. An admitted unchanged correction retains its candidate, worktree, worker evidence, and final review anchor; it settles through the same bounded final review rather than failing the lane. A post-review delivery-gate rejection receives bounded remediation from fresh workers using the exact retained gate evidence. Changed remediation is reviewed before publication retries; unchanged remediation never blindly republishes the same candidate.

Stopping is transient while owned processes settle. Failed, incomplete, and completed runs are terminal. A crash-retained active run is terminalized as interrupted under the checkout lease without launching workers. Cleanup settles exact durable publication and projection transactions first, preserves published target and plan changes, and removes only resources Pipkin can prove it owns. The top-level menu offers **Clean completed runs (N)** when completed history exists; after confirmation it removes those retained records and any proven owned resources left by a blocked automatic release, without including failed, incomplete, or historical entries.

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

| Command   | Purpose                                                                                         |
| --------- | ----------------------------------------------------------------------------------------------- |
| `status`  | Show terminal outcome, lane phases, findings, failures, assignments, leases, receipts, and debt |
| `inspect` | Show durable state and evidence paths for one run; failed candidates may retain workspaces      |
| `stop`    | Settle owned processes and terminally fail the active run safely                                |
| `restart` | Clean a completed run after new-run preflight and start again                                   |
| `cleanup` | Terminalize interrupted runs, settle durable transactions, and remove provably owned resources  |

`inspect_implement_run` is the model-facing counterpart to `status` and `inspect`. It lists retained durable runs or summarizes one run, returning state and artifact paths for deeper diagnosis with ordinary read tools. It is read-only and unavailable to managed Implement workers.

The active session projects one Implement parent with active workstream children into UI's shared Activity widget. Implement does not publish active progress to the footer; detailed live and retained worker inspection remains available through `/agents`.

## Models and concurrency

Implement uses `high` for planning and review and `medium` for implementation, revision, and reconciliation. `implement.workerConcurrency` defaults to `3` and caps at `8`.

Implementers choose appropriate project verification. There is no configured validation command, automatic validation-command discovery, role-specific persistent model override, or Implement-only reviewer watchdog. Use Pipkin's generic `/agents` controls for supervision.

## Development tests

Implement tests are partitioned by the boundary they exercise. `implement-unit` owns packet, parser, reducer, scheduler, model, and scripted worker behavior and does not invoke Git. `implement-integration` owns managed Pi runtime integration and focused real-Git contracts such as worktrees, hooks, replay, index behavior, and publication durability.

Run the layers independently or together from the repository root:

```sh
npm run test:subagents
npm run test:implement:unit
npm run test:implement:integration
npm run test:implement
npm run test
```

The root `npm run test` remains authoritative and executes every project once.

See [Configuration](../configuration.md) for model routing and settings.
