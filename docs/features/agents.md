# Agents

Pipkin gives the main agent a small team without turning every task into orchestration. Explore can map an unfamiliar subsystem and Review can approach a diff without the implementer's assumptions.

Both run through the `Agent` tool and can be operated from `/agents`.

## Choose the right agent

| Agent       | Best use                                                                                    |
| ----------- | ------------------------------------------------------------------------------------------- |
| **Explore** | Multi-step codebase discovery, symbol tracing, usage analysis, and subsystem mapping        |
| **Review**  | An independent second pass over a concrete diff, commit, patch, or completed implementation |

Use `lsp` directly for one known-symbol question and ordinary reads for one or two obvious files. Keep routine implementation, iterative debugging, tests, and verification in the primary session. Delegation is useful when it creates a clean ownership boundary—not merely because the parent context is getting long.

## Start an agent

```json
{
  "subagent_type": "Explore",
  "prompt": "Trace how task review policy reaches publication. Cite the relevant files and tests.",
  "description": "Map review policy",
  "mode": "foreground"
}
```

`prompt` is the complete task contract. `description` is the short status label. Public agents always run in the invoking session's working directory. `model` and `thinking` can override the run's defaults when their exact values are known.

Foreground is the default and the right choice when the result is your next dependency. The tool waits for completion and returns the final snapshot and answer. In the TUI, pressing Escape while foreground agents are active asks for confirmation before aborting them. When a turn has multiple foreground agents, the prompt lists them and confirmation stops them together; background agents keep running.

## Run real work concurrently

Use background mode only when the parent has independent work to continue:

```json
{
  "subagent_type": "Review",
  "prompt": "Review the configuration changes for behavioral regressions.",
  "description": "Review config changes",
  "mode": "background"
}
```

A background start returns an agent ID immediately. Continue the independent parent work, then join when the result becomes necessary:

```json
{ "id": "subagent-1", "wait": true }
```

`get_subagent_result` with `wait: false` is for an intentional non-blocking status check. Do not poll. If the next action would be an immediate blocking join, start the agent in foreground mode instead.

Queue updated direction with:

```json
{
  "id": "subagent-1",
  "message": "Narrow the review to persistence and reload behavior."
}
```

`steer_subagent` cooperatively delivers guidance after the child's current assistant turn finishes its tool calls. It cannot steer a queued, stopped, or completed agent.

## Operate the team with `/agents`

The `/agents` dashboard is more than a process list. It can:

- show running agents or include retained terminal records;
- inspect status, owner, type, cwd, requested model and thinking, timestamps, and session health;
- display bounded recent activity and sanitized message previews;
- queue guidance to a running agent;
- ask for a point-in-time activity summary;
- stop active work with confirmation.

The live Activity widget keeps current public-agent and Implement work visible in one bounded hierarchy. Records are operational views, not raw transcripts: they omit prompts, commands, cwd, raw output, hidden runtime objects, and token or cost telemetry. `/agents` remains the complete inspector, including Implement-managed workers and retained records. Child sessions live in memory, do not appear in `/resume`, and cannot be resumed after the parent session ends.

Nested Explore runs created by managed Pipkin workflows use the same runtime and remain visible to the operator.

## Context and tool boundaries

Subagents inherit the parent extension environment and active tools, except public agent tools (`Agent`, `get_subagent_result`, and `steer_subagent`) are withheld to prevent recursive fan-out. Explore and Review may also use `record_papercut` for qualifying incidental friction. It is the sole controlled personal-metadata write: it does not permit source, dependency, or Git changes. Where Bash remains active, Implement mutable workers inherit managed-process tools, while Explore, Review, and Bash-enabled read-only workers select them from their explicit allowlists. `start_process` is withheld without Bash; `get_process_result` and `stop_process` remain available for existing records after Bash is disabled. Where Bash is available, `bash_outcome` and `context_recall` are available with it: choose the outcome tool for an action or validation when exit status alone answers the current question, regardless of finite duration. Use Bash for inspection, discovery, diagnostics, or when successful output informs reasoning or reporting. Successful output remains immediately recallable under ordinary Bash limits, no-output success stays concise, and failures stay visible. A child's retained Bash output belongs only to that in-memory child session for its lifetime; its final answer is the parent-visible handoff.

Explore and Review retain shell access for discovery and checks. Repository preservation is a role contract; it is not technical confinement.

Public subagents share the invoking session's filesystem and **do not receive isolated Git worktrees**. On enabled macOS Sandbox sessions, Explore, Review, and nested Explore snapshot repository-read-only mode when spawned: the workspace/worktree, worktree Git directory, and common Git directory are protected while temporary/cache writes remain available. The snapshot includes the invoking session's current enabled state; `/sandbox off` affects later children but does not change children already running. Linux has no kernel enforcement, so this remains an instruction-only trusted-agent boundary there, not hostile-code isolation. Do not edit files that a child currently owns. If implementation needs strong workspace separation and publication control, use [Implement](implementation.md), whose trusted managed workers run in owned disposable worktrees.

## Model routing

- Explore uses the `low` preset.
- Review uses the `high` preset.
- Explicit `model` or `thinking` arguments apply to one invocation.

Implement uses the same runtime internally, routing planner and reviewer work to `high` and implementation, revision, repair, and reconciliation work to `medium`. See [Configuration](../configuration.md).

## Deliberate limits

Pipkin does not provide custom agent-definition files, persistent child memory, a public dependency scheduler, or public worktree creation. Those omissions keep the public agent surface small and make ownership visible to the person operating the session.
