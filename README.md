<div align="center">
  <h1>Pipkin</h1>
  <img src="docs/pipkin.png" alt="Pipkin" width="256">
  <p><strong>A small companion for big Pi sessions</strong></p>
  <p>
    <a href="https://github.com/madeleineostoja/pipkin/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/madeleineostoja/pipkin/actions/workflows/ci.yml/badge.svg"></a>
    <img alt="Node.js 24+" src="https://img.shields.io/badge/Node.js-24%2B-339933?logo=nodedotjs&logoColor=white">
    <a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/license-MIT-blue.svg"></a>
  </p>
</div>

Pipkin is an extension for the [Pi](https://pi.dev) agent harness that brings a satchel of goodies. It can orchestrate teams of agents to autonomously implement plans, optimise context on the fly, contain repository-write Bash on macOS, and much more.

## Getting setup

Pipkin requires Node 24 or later and an existing Pi installation.

```sh
pi install git:github.com/madeleineostoja/pipkin
```

Choose the models Pipkin should use in `~/.pi/agent/pipkin/config.json`

```json
{
  "nickname": "Mads",
  "models": {
    "utility": { "model": "provider/fast-model", "thinking": "minimal" },
    "low": { "model": "provider/low-cost-model", "thinking": "low" },
    "medium": { "model": "provider/coding-model", "thinking": "medium" },
    "high": { "model": "provider/reasoning-model", "thinking": "high" }
  }
}
```

See [Configuration](docs/configuration.md) for additional configuration and how these models map to various features.

## What Pipkin can help with

### Implementer

Pipkin is an autonomous engineering runtime and parallel agent orchestrator for implementing anything from small changes to full rewrites while you sleep. Hand it a Markdown plan, with linked specs or design notes, and it drives the implementation run from initial planning to reviewed commits.

```text
/implement docs/plan.md
```

**Plan → dependency graph → parallel implementation → review and repair → protected publication**

A planner agent reads the complete plan corpus and designs a dependency graph and workstreams. Pipkin then coordinates multiple implementer and reviewer agents in isolated Git worktrees. It schedules independent streams concurrently, gives dependent work the right completed base, routes findings back through repair, and finishes with a whole-plan review.

The orchestration remains inspectable throughout. The target branch only moves through a serialized integration lane after hooks run, the prepared commit is verified, and compare-and-swap checks still hold. Durable run state lets Pipkin explain retained candidates and failures, preserve independently delivered work, and safely clean terminal runs without losing evidence.

This makes it practical to give Pipkin a serious implementation plan and let it drive the work without surrendering visibility or Git discipline.

**[Implementation →](docs/features/implementation.md)**

### Safety

Pipkin's first layers are deliberately about control:

- **Sandbox** owns model Bash and direct `write`/`edit` containment. On macOS it confines model Bash descendants to the canonical repository, required Git state, temporary roots, and reviewed package caches; direct tools stay within the workspace. Linux reports Sandbox as unavailable and uses local Bash.
- **Readonly** separately checkpoints resolved tools named `edit` and `write`. Toggle its established workflow with `Ctrl+R` or `/readonly`.
- **Processes** starts Sandbox-owned foreground non-interactive work when useful independent work can continue. Join once for completion or literal readiness, inspect bounded tail/search output without polling, choose recallable point-in-time outcomes when only status matters, and stop no-longer-needed work explicitly.

**[Safety →](docs/features/safety.md)**

### Context

Long sessions collect a remarkable amount of baggage. **Context Prune** uses deterministic, persisted epochs to replace stale output, superseded and repeated reads, and already-consumed command results with small, reasoned stubs while keeping every original result available through `context_recall`. Choose `bash_outcome` for actions or validations when exit status alone answers the current question; choose `bash` for inspection, diagnostics, or when successful output informs reasoning or reporting. Successful output remains immediately recallable, no-output success stays concise, and failures remain visible. Managed process outcomes likewise retain one bounded point-in-time result for recall. Pi remains responsible for context pressure and compaction.

**[Context →](docs/features/context.md)**

### Agents

Pipkin adds three focused subagents through the `Agent` tool:

- **Explore** maps unfamiliar code and follows relationships across a repository.
- **Review** approaches a concrete change without the implementer's assumptions.
- **General** takes bounded research or genuinely separate work.

They can run in the foreground or alongside independent parent work, accept steering, and stay visible through `/agents`. Pipkin does not turn every task into multi-agent theatre; delegation is there when a separate context or owner actually helps.

**[Agents →](docs/features/agents.md)**

### Reference, code intelligence, and side questions

**Reference** provides bounded `docs`, `package_search`, and `code_search` tools: Context7 documentation with exact-version support, independently ranked Context7/npm/public-GitHub package discovery, and GitHub code matches visible to the configured credential. It does not inspect the project.

**[Reference →](docs/features/reference.md)**

**Web Fetch** provides `web_fetch` and fixed-concurrency `batch_web_fetch` for bounded readable retrieval from direct public URLs. It complements Reference: use `docs` for known-library documentation, `package_search` for package discovery, and `code_search` or the GitHub tool/skill for GitHub source and repository workflows. Web Fetch has no authentication, proxy, private-network, cache, or caller configuration support; it does not execute page JavaScript, and temporary artifacts remain readable directly only for the live session.

**[Web Fetch →](docs/features/web-fetch.md)**

The read-only **LSP** tool finds definitions, types, implementations, references, symbols, hover information, and diagnostics for TypeScript/JavaScript, Svelte, and provisioned Ruby projects. It follows a pull-only model where the agent uses it deliberately, rather than interrupting turns with noise.

**BTW** handles the small question that would otherwise derail the main thread: `/btw <question>` answers from current session context in a disposable full-screen surface and leaves the transcript alone.

**[Workflow tools →](docs/features/workflow-tools.md)**

### Session details

- **UI** keeps cwd, branch, model, thinking, cost, cache hit rate, context usage, and ordered extension state in one compact footer, with a bounded live Activity view for current work.
- **Personality** gives unnamed sessions useful titles and a brief fresh-session greeting, so `/resume` is less of an archaeological dig.
- **Papercuts** saves recurring project-specific workflow failures for human review instead of letting the lesson vanish with the session.

**[Interface and Personality →](docs/features/interface-and-personality.md)**

**[Workflow tools →](docs/features/workflow-tools.md)**

## Commands

| Surface                               | What it does                                                         |
| ------------------------------------- | -------------------------------------------------------------------- |
| `/sandbox [on\|off]`                  | Inspect or change the current repository-write Sandbox mode          |
| `/readonly [on\|off]`                 | Toggle approval for resolved `edit` and `write` tools                |
| `context_recall`                      | Recover a retained outcome or content behind an elision stub         |
| `bash_outcome`                        | Run Bash when exit status alone answers the current question         |
| `lsp`                                 | Make semantic source queries or inspect language-server status       |
| `start_process`                       | Start independent foreground non-interactive managed work            |
| `get_process_result` / `stop_process` | Join, inspect, or explicitly stop a managed process                  |
| `/processes`                          | Inspect live output and deliberately stop managed processes          |
| `docs`                                | Retrieve bounded Context7 documentation                              |
| `package_search`                      | Discover separately ranked Context7, npm, and public GitHub packages |
| `code_search`                         | Search bounded GitHub source visible to the configured credential    |
| `web_fetch`                           | Retrieve bounded readable content from one public URL                |
| `batch_web_fetch`                     | Retrieve one to eight public URLs with fixed four-worker concurrency |
| `/agents` / `Agent`                   | Run and operate General, Explore, and Review subagents               |
| `get_subagent_result`                 | Inspect or join a background agent                                   |
| `steer_subagent`                      | Queue guidance for a running background agent                        |
| `/implement`                          | Start, inspect, stop, or clean up implementation runs                |
| `/papercuts` / `record_papercut`      | Record and close incidental exercised-workaround findings            |
| `/btw <question>`                     | Ask an ephemeral side question from current session context          |

## Limits

On enabled macOS sessions, Sandbox lets model Bash and descendants write only the canonical repository, its required Git administration, temporary roots, and reviewed package caches; direct `write` and `edit` stay within the canonical workspace. `/sandbox off` also applies to Pipkin subagents spawned afterward. It allows broad reads and unrestricted networking, and repository and shared Git state remain mutable. Managed processes are current-session only: each runtime allows at most eight active processes, retains at most 32 records and 1 MiB per record, and exposes bounded output. `/processes` is the live operational surface; its Activity rows disclose only safe descriptions and state.

Pipkin extensions are trusted code with the permissions of the Pi process. Sandbox does not confine extension JavaScript, extension-owned processes, provider traffic, Web Fetch, direct RPC Bash, language servers, remote mutations, inherited credentials, or hostile repository code. Use a VM, devcontainer, remote sandbox, or equivalent external boundary for hostile or unattended work. Readonly steps aside where Pi cannot show an interactive prompt. Public subagents share the working tree. Implement intentionally changes Git state.

Those are operating constraints, not footnotes. The feature guides spell out where each boundary begins and ends. If `pi-smart-fetch` was separately installed, remove it before reloading Pipkin to avoid duplicate Web Fetch tool registrations.

## Documentation

- [Configuration and state](docs/configuration.md)
- [Safety](docs/features/safety.md)
- [Context](docs/features/context.md)
- [Agents](docs/features/agents.md)
- [Implementation](docs/features/implementation.md)
- [Reference](docs/features/reference.md)
- [Web Fetch](docs/features/web-fetch.md)
- [Interface and Personality](docs/features/interface-and-personality.md)
- [Workflow tools](docs/features/workflow-tools.md)
- [Architecture](docs/architecture.md)
- [Development](docs/development.md)

MIT [LICENSE](LICENSE).
