# Agents

Pipkin provides two focused subagents through the `Agent` tool. Use them when a separate context and ownership boundary helps—not merely because the main session is long.

## Choose an agent

| Agent       | Best use                                                                                       |
| ----------- | ---------------------------------------------------------------------------------------------- |
| **Explore** | Multi-step codebase discovery, symbol tracing, usage analysis, and subsystem mapping           |
| **Review**  | An independent assessment of a concrete diff, commit, patch, plan, or completed implementation |

Use `lsp` for one known-symbol question and ordinary reads for a couple of obvious files. Keep routine implementation, iterative debugging, and verification in the primary session.

## Foreground and background runs

Foreground is the default. Use it when the result is the next dependency:

```json
{
  "subagent_type": "Explore",
  "prompt": "Trace how review policy reaches publication. Cite relevant files and tests.",
  "description": "Map review policy",
  "mode": "foreground"
}
```

`prompt` is the complete task contract; `description` is the short status label. Agents run in the invoking session's working directory. `model` and `thinking` may override defaults for one invocation when exact values are known.

Use background mode only while the parent can continue independent work:

```json
{
  "subagent_type": "Review",
  "prompt": "Review the configuration changes for behavioral regressions.",
  "description": "Review config changes",
  "mode": "background"
}
```

A background start returns an ID. Continue parent work, then operate it with:

| Tool                                                | Purpose                                                                                  |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `get_subagent_result` with `wait: true`             | Join once the result becomes a dependency                                                |
| `get_subagent_result` with `wait: false`            | Make an intentional non-blocking status check; do not poll                               |
| `get_subagent_result` with `include_progress: true` | Inspect one bounded, point-in-time partial-progress excerpt or recover partial work      |
| `steer_subagent`                                    | Queue updated direction after the child's current assistant turn finishes its tool calls |

If the next action would be an immediate blocking join, start in foreground instead. Steering fails for queued, stopped, unknown, or completed agents.

Use progress once when live evidence would help decide whether to steer, or to salvage work after cancellation or failure:

```json
{
  "id": "subagent-1",
  "wait": false,
  "include_progress": true
}
```

This returns a fixed-size, point-in-time tail of assistant excerpts and tool/compaction/retry statuses. It is untrusted child-generated content, may be incomplete, and is not a final answer. Do not poll it. Queued agents report that progress is not available yet; running agents return immediately; stopped and failed agents return immediately with currently available work when `wait` is false. With `wait: true`, stopped and failed agents wait for terminal cleanup and use the frozen post-abort inspection. Completed agents always return only their authoritative final result, even when progress is requested.

In the TUI, Escape during foreground work asks for confirmation before aborting all foreground agents from that turn; background agents continue.

## `/agents`

The dashboard presents one scannable roster with status glyphs, hierarchy, current description, and elapsed time. Live agent groups appear before retained history without separate section headings. Selecting an agent opens a landing page with status, elapsed time, available context and cost, and a bounded failure reason when relevant. From there you can view Activity, view a completed Result, stop running work with confirmation, or return to the roster.

Activity is a full-width chronological timeline: assistant prose is rendered as Markdown; tool calls are compact summaries with bounded arguments and status; steering is quoted; and retry and compaction events remain visible. It never replays complete tool output. Steerable agents have an inline bordered guidance editor beneath the timeline: type normally, use Enter to send and Shift+Enter for a new line; arrows scroll the timeline. Escape returns to the landing page.

A completed agent’s Result is a separate scrollable Markdown page containing its complete final result. Activity deliberately excludes that final result.

The shared Activity view shows only queued, running, or waiting public-agent and Implement work in a bounded hierarchy; settled rows disappear immediately. A Subagent row may include current context usage and one bounded latest-assistant preview, but never prompts, commands, cwd, raw output, hidden runtime objects, cost, or aggregate token telemetry. Foreground failures remain in their ordinary tool row; a detached public background failure is notified once and remains inspectable in `/agents`, which is the complete inspector including Implement-managed workers and retained records.

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
