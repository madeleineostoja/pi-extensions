# pi-subagents

First-party in-process subagent runtime for Pi extensions and for user-facing `Agent` tooling.

`pi-subagents` ships with this bundle; install the root `pi-extensions` package and Pi enables it from the root `pi.extensions` list. No external subagent package is required.

## Public agents

Three built-in public agent types are available:

| Agent     | Use it for                                                                                                                                                                                           |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `General` | Bounded, self-contained research, synthesis, or investigation where only the final result matters and separate ownership, actual concurrency, or explicit orchestration provides a concrete benefit. |
| `Explore` | Non-trivial codebase discovery: tracing symbols and usage, mapping unfamiliar areas, and answering multi-step "where/how is this wired?" questions.                                                  |
| `Review`  | Independent second-pass review of concrete work such as diffs, commits, patches, and staged or unstaged changes.                                                                                     |

Subagents inherit the parent session's extension environment. They bind the configured Pi extensions in their own session and inherit the parent's active tool set, except that `Agent`, `get_subagent_result`, and `steer_subagent` are withheld from all subagents to avoid accidental agent fan-out. `Explore` and `Review` stay read-only by instruction and restricted tool sets.

Explore and Review use separate context deliberately. Explore keeps a disposable search trail out of the caller's context while returning relevant paths, relationships, and evidence. It uses LSP for targeted semantic relationships when available and search and reads for broad, literal, or behavioral discovery. Use `lsp` directly for one known-symbol lookup and direct reads for one or two obvious files; use Explore for multi-step tracing or mapping. Review's fresh context avoids anchoring on the implementer's assumptions. During implementation, prefer Review over self-review when an independent second pass is warranted for large, risky, or multi-file changes. A fresh session whose primary task is already review should review directly.

General is not a context-pruning mechanism. Routine implementation, iterative debugging, ordinary verification, and test execution remain with the primary agent so implementation decisions and working knowledge stay continuous; pi-context-prune and Pi compaction reclaim mechanical context. Public General may implement only when there is a benefit beyond context reduction and ownership is explicitly non-overlapping. Public subagents have no worktree isolation, so the parent must not modify delegated files while the child is running.

## Tools

### `Agent`

Starts a public subagent.

```json
{
  "subagent_type": "Explore",
  "prompt": "Find where task review skip eligibility is decided.",
  "description": "Trace task review policy",
  "mode": "foreground",
  "model": "provider/model-id",
  "thinking": "medium",
  "cwd": "/path/to/repo"
}
```

- `subagent_type` must be `General`, `Explore`, or `Review`.
- `prompt` is the full task contract.
- `description` is the short label shown in status views.
- `mode` defaults to `foreground`. Use `background` only when concrete independent work can proceed before the result is needed or when starting multiple independent agents.
- `model` is an exact `provider/model` override. Supply it only when the ID is explicitly known; callers should not guess available models.
- `thinking` and `cwd` override defaults for that run only.

Foreground agents block until the child finishes and return its final runtime snapshot and result. Use foreground when the result is the caller's next dependency. Background agents return immediately with a snapshot containing the subagent `id`; if the next action would be an immediate blocking join, foreground should have been used instead.

### `get_subagent_result`

Checks or joins a background agent.

```json
{ "id": "subagent-1", "wait": false }
```

With `wait: false`, the tool returns the current snapshot immediately; reserve this for an intentional non-blocking status check. With `wait: true`, it waits for the agent to finish and returns the terminal snapshot. Join with `wait: true` when the result becomes a dependency instead of polling.

### `steer_subagent`

Sends additional guidance to a running background agent.

```json
{ "id": "subagent-1", "message": "Narrow this to config parsing only." }
```

Steering fails for unknown, queued, completed, failed, or stopped agents.

## Foreground, background, and inspection

Foreground agents are for bounded work where the caller needs the answer before continuing. Background mode is for actual concurrency, not merely long-running work: continue the independent work that justified it, optionally steer the child, then join with `get_subagent_result({ "id": "...", "wait": true })` at the dependency barrier. Do not launch a background agent and immediately join it, and do not poll.

Use `/agents` to inspect current-session subagents and stop running work. Runtime records are session-scoped and include status, owner, type, description, cwd, model/thinking overrides, timestamps, health, and final result or error. Child sessions are in-memory only: they do not appear in `/resume` and cannot be resumed. After a child exits, `/agents` retains a bounded terminal message tail for inspection.

## Configuration

User-facing public-agent defaults live at:

```text
~/.pi/agent/extensions/pi-subagents/config.json
```

```json
{
  "agents": {
    "General": {
      "model": "provider/model-id",
      "thinking": "medium"
    },
    "Explore": {
      "model": "provider/model-id",
      "thinking": "low"
    },
    "Review": {
      "model": "provider/model-id",
      "thinking": "high"
    }
  }
}
```

`agents` is optional and keyed by `General`, `Explore`, and `Review`. Each agent can configure `model` and/or `thinking`. Valid thinking levels are `off`, `minimal`, `low`, `medium`, `high`, and `xhigh`. Invalid keys or values are ignored with a best-effort warning.

An explicit tool-call model override takes precedence over the role configuration; without either, the subagent inherits the current Pi session's model. Autonomous callers are not given an inventory of available models, so a different model is a configuration or orchestration capability rather than a reason for the caller to guess an override.

## First-party extension integration

Other bundled extensions can use the same runtime directly. `pi-implement` uses internal managed agents for planner, implementer, and reviewer roles while keeping its own role model/thinking configuration in `~/.pi/agent/extensions/pi-implement/config.json`. Its current recovery lifecycle retains evidence for operator resolution rather than launching an automatic repair agent.

Managed agents may opt into different tool sets. `pi-implement` owns the task-worktree boundaries for its autonomous workers; public `pi-subagents` v1 does not create separate worktrees or provide a scheduler.

## v1 limitations

- Built-in public agents are limited to `General`, `Explore`, and `Review`.
- No custom agent-definition files are supported yet.
- No persistent agent memory is provided.
- No public scheduler or dependency graph execution is provided.
- Public subagents do not get their own worktree isolation; run them with an appropriate `cwd` and sandbox policy for your task.
- Runtime records are scoped to the current Pi session rather than a durable cross-session database.
