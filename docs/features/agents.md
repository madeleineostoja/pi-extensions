# Agents

Pipkin provides two focused subagents through the `Agent` tool. Use them when a separate context and ownership boundary helps—not merely because the main session is long.

## Choose an agent

| Agent       | Best use                                                                                       |
| ----------- | ---------------------------------------------------------------------------------------------- |
| **Explore** | Multi-step codebase discovery, symbol tracing, usage analysis, and subsystem mapping           |
| **Review**  | An independent assessment of a concrete diff, commit, patch, plan, or completed implementation |

Use `lsp` for one known-symbol question and ordinary reads for a couple of obvious files. Keep routine implementation, iterative debugging, and verification in the primary session.

## Start, then join

Every `Agent` call starts session-managed work and immediately returns a semantic ID such as `explore-1` or `review-2`:

```json
{
  "subagent_type": "Explore",
  "prompt": "Trace how review policy reaches publication. Cite relevant files and tests.",
  "description": "Map review policy"
}
```

`prompt` is the complete task contract; `description` is the short status label. Agents run in the invoking session's working directory. `model` and `thinking` may override defaults for one invocation when exact values are known.

Continue useful independent work when available, then join once when the result becomes a dependency:

```json
{
  "id": "explore-1",
  "wait": true
}
```

An immediate `wait: true` join is appropriate when nothing else can proceed. The separate call deliberately distinguishes starting durable work from waiting for it. Use `wait: false` only for an intentional point-in-time inspection; do not poll. Add `include_progress: true` to inspect one bounded partial-progress excerpt or recover partial work. Steering queues updated direction after the child's current assistant turn finishes its tool calls; it fails for queued, stopped, unknown, or completed agents.

Progress is untrusted child-generated content, may be incomplete, and is not a final answer. Queued agents report that progress is not available yet; running agents return immediately; stopped and failed agents return immediately with currently available work when `wait` is false. With `wait: true`, stopped and failed agents wait for terminal cleanup and use the frozen post-abort inspection. Completed agents always return only their authoritative final result, even when progress is requested.

## Waiting and lifetime

Once `Agent` accepts a job and returns its ID, the session runtime owns that work rather than the initiating turn. Escape during startup can prevent an unaccepted job from starting. Escape during `get_subagent_result` with `wait: true` cancels only that wait and its current turn; the accepted agent continues. A later join can retrieve its complete result.

Use `/agents` to stop a selected agent explicitly, with confirmation. Session replacement and shutdown stop and settle session-owned agents. Implement retains authority over its scheduler-managed workers.

## `/agents`

The dashboard presents one scannable roster with status glyphs, hierarchy, current description, and elapsed time. Live agent groups appear before retained history without separate section headings. Selecting an agent opens a landing page with status, elapsed time, available context and cost, and a bounded failure reason when relevant. From there you can view Activity, view a completed Result, stop running work with confirmation, or return to the roster.

Activity is a full-width chronological timeline: assistant prose is rendered as Markdown; tool calls are compact summaries with bounded arguments and status; steering is quoted; and retry and compaction events remain visible. It never replays complete tool output. Steerable agents have an inline bordered guidance editor beneath the timeline: type normally, use Enter to send and Shift+Enter for a new line; arrows scroll the timeline. Escape returns to the landing page.

A completed agent’s Result is a separate scrollable Markdown page containing its complete final result. Activity deliberately excludes that final result.

The shared Activity view shows only queued, running, or waiting public-agent and Implement work in a bounded hierarchy; settled rows disappear immediately. A Subagent row may include current context usage and one bounded latest-assistant preview, but never prompts, commands, cwd, raw output, hidden runtime objects, cost, or aggregate token telemetry. Public-agent failures are notified once and remain inspectable in `/agents`, which is the complete inspector including Implement-managed workers and retained records.

Child sessions are in-memory only. They do not appear in `/resume` and cannot be resumed after the parent session ends. Stopped or failed partial progress is recoverable only while the current parent session remains alive; inspection does not create persistent or resumable child sessions.

## Tools and context

Subagents inherit the parent extension environment except public agent tools (`Agent`, `get_subagent_result`, and `steer_subagent`), which are withheld to prevent recursive fan-out. Nested Explore used by managed Pipkin workflows is private and remains visible to the operator.

Where Bash is available:

- use `bash_outcome` when exit status alone answers the question;
- use ordinary Bash when successful output informs reasoning;
- use managed-process tools only for work that can overlap independent activity; and
- use `context_recall` for retained child-session output while that child remains alive.

Explore and Review may record qualifying incidental friction through `record_papercut`. That controlled metadata write does not grant source, dependency, or Git mutation.

## Filesystem and Sandbox boundaries

Public subagents share the invoking session's filesystem and do not receive isolated Git worktrees. Repository preservation is a role contract.

On enabled macOS Sandbox sessions, Explore, Review, and nested Explore snapshot repository-read-only mode when spawned. Their workspace/worktree, worktree Git directory, and common Git directory are protected while intended temporary and cache writes remain available. `/sandbox off` affects later children only. Linux remains instruction-only.

Do not edit files currently owned by a public child. For workspace isolation and controlled publication, use [Implement](implementation.md).

## Model routing

| Role                                                           | Preset   |
| -------------------------------------------------------------- | -------- |
| Explore, including nested exploration                          | `low`    |
| Review                                                         | `high`   |
| Implement planning and review                                  | `high`   |
| Implement implementation, revision, reconciliation, and repair | `medium` |

Explicit `model` or `thinking` arguments apply to one public invocation. See [Configuration](../configuration.md#model-presets).

## Deliberate limits

Pipkin does not provide custom agent-definition files, persistent child memory, a public dependency scheduler, or public worktree creation. Those omissions keep the agent surface small and ownership visible.
