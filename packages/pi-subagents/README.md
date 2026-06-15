# pi-subagents

First-party in-process subagent runtime for Pi extensions and for user-facing `Agent` tooling.

`pi-subagents` ships with this bundle; install the root `pi-extensions` package and Pi enables it from the root `pi.extensions` list. No external subagent package is required.

## Public agents

Three built-in public agent types are available:

| Agent     | Use it for                                                                                                                         |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `General` | Well-scoped implementation, research, or synthesis work that benefits from a separate context.                                     |
| `Explore` | Codebase discovery: locating symbols, tracing usage, mapping unfamiliar areas, and answering "where/how is this wired?" questions. |
| `Review`  | Independent second-pass review of diffs, plans, or proposed changes.                                                               |

Public subagents inherit the parent session's extension environment. They bind the configured Pi extensions in their own session and inherit the parent's active tool set, except that `Agent`, `get_subagent_result`, and `steer_subagent` are withheld from public `General` agents to avoid accidental agent fan-out. `Explore` is read-oriented by prompt convention and is best used for discovery rather than edits; `Review` is intended to stay read-only by instruction.

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
- `mode` defaults to `foreground`.
- `model`, `thinking`, and `cwd` override defaults for that run only.

Foreground agents block until the child finishes and return its final runtime snapshot and result. Background agents return immediately with a snapshot containing the subagent `id`.

### `get_subagent_result`

Checks or joins a background agent.

```json
{ "id": "subagent-1", "wait": false }
```

With `wait: false`, the tool returns the current snapshot immediately. With `wait: true`, it waits for the agent to finish and returns the terminal snapshot. Prefer `get_subagent_result({ "id": "...", "wait": true })` when you need the final answer instead of polling.

### `steer_subagent`

Sends additional guidance to a running background agent.

```json
{ "id": "subagent-1", "message": "Narrow this to config parsing only." }
```

Steering fails for unknown, queued, completed, failed, or stopped agents.

## Foreground, background, and inspection

Foreground agents are for bounded work where the caller needs the answer before continuing. Background agents are for longer independent work; keep the returned `id`, optionally steer them, then join them with `get_subagent_result`.

Use `/agents` to inspect current-session subagents and stop running work. Runtime records are session-scoped and include status, owner, type, description, cwd, model/thinking overrides, timestamps, health, and final result or error.

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

If no model is configured or passed to `Agent`, the subagent session uses the current Pi session's model defaults.

## First-party extension integration

Other bundled extensions can use the same runtime directly. `pi-implement` uses internal managed agents for implementer, reviewer, planner, and self-heal roles while keeping its own role model/thinking configuration in `~/.pi/agent/extensions/pi-implement/config.json`.

Managed agents may opt into different tool sets. `pi-implement` owns the task-worktree boundaries for its autonomous workers; public `pi-subagents` v1 does not create separate worktrees or provide a scheduler.

## v1 limitations

- Built-in public agents are limited to `General`, `Explore`, and `Review`.
- No custom agent-definition files are supported yet.
- No persistent agent memory is provided.
- No public scheduler or dependency graph execution is provided.
- Public subagents do not get their own worktree isolation; run them with an appropriate `cwd` and sandbox policy for your task.
- Runtime records are scoped to the current Pi session rather than a durable cross-session database.
