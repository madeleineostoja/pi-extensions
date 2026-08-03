# Workflow tools

Some of Pipkin's most useful features are small ones: a semantic source query that avoids a search detour, a side question that does not derail the transcript, or a captured lesson that survives the session.

## LSP: ask the codebase semantic questions

The read-only `lsp` tool complements text search with language-server relationships and type information.

| Action              | What it answers                                                      |
| ------------------- | -------------------------------------------------------------------- |
| `definition`        | Where is this symbol defined?                                        |
| `type_definition`   | Where is its type defined?                                           |
| `implementation`    | What implements this contract?                                       |
| `references`        | Where is it used?                                                    |
| `hover`             | What type or documentation does the server know here?                |
| `document_symbols`  | What symbols are in this file?                                       |
| `workspace_symbols` | Where is a symbol with this name in the workspace?                   |
| `diagnostics`       | What diagnostics does the server currently report for this file?     |
| `status`            | Which servers are discovered, running, cooling down, or unavailable? |

Position queries accept a workspace-relative or absolute `file` plus a 1-indexed `line` and `column`. When the symbol text is known, `symbol` can replace the column and `occurrence` selects among repeated instances on the line.

Use LSP for a focused relationship that literal search may miss. Use text search or Explore for broad discovery. Request diagnostics after a coherent edit batch, then run the project's lint, typecheck, tests, or build as the authority.

### Supported languages

| Language                | Files                                                        | Server                                                                    |
| ----------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------- |
| TypeScript / JavaScript | `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs`, `.mts`, `.cts` | Packaged `typescript-language-server` with workspace TypeScript preferred |
| Svelte                  | `.svelte`                                                    | Packaged `svelte-language-server`                                         |
| Ruby                    | `.rb`, `.rake`                                               | Project-provisioned `ruby-lsp` from `bin/ruby-lsp` or `PATH`              |

Servers start lazily, are shared per workspace, and retire after idle time. Requests default to five seconds and cap at 15. Results are bounded to 100 locations, symbols, or diagnostics and 2,000 hover characters. Model-visible lists include paths, positions, names, and diagnostic messages within a 20 KB aggregate output limit.

Unavailable servers and unsupported capabilities return non-fatal fallback results. Use the `status` action to inspect runtime status without eagerly starting every server.

The model can choose only Pipkin's fixed read-only actions, supported files, and in-workspace paths. It cannot choose an executable, send arbitrary protocol methods, apply edits, or invoke server commands. The language servers themselves are trusted processes outside Sandbox and inherit Pi's environment.

## Managed processes: schedule, then project

Use foreground `bash` or `bash_outcome` when completion is immediately required. Use `start_process` only for finite foreground commands or readiness work that can overlap real independent work; never start it merely to call an immediate join. When completion or readiness becomes a dependency, call `get_process_result` with `wait:true` once, not as a poll. `untilContains` waits eventfully for one case-sensitive literal on either source stream, and its timeout leaves the process running.

Use output mode for bounded recent-tail or `find` inspection when output changes the next decision. Use `resultMode:"outcome"` when only a point-in-time status matters, then use the supplied exact ID with `context_recall` to recover its full result, lines, or literal matches. A later output-mode result is required for newer output; failures stay directly visible. Stop unneeded processes with `stop_process`. `/processes` is the separate human recovery surface: it updates from process events, shows bounded live details and recent output, and only stops the still-selected exact running record.

## Papercuts: factual incidental workaround inbox

`record_papercut` is an experimental inbox, not a backlog or remediation system. A trusted agent records a finding only when, while completing an assigned subject that was something else, it concretely encountered avoidable friction, exercised at least one workaround or detour, and then completed or safely continued the task.

An incident need not be an outage, exception, failed command or run, or user-visible failure. It can be a recoverable test failure handled with a narrower reliable command, discovery of an undocumented validation convention, reconstructing missing context from ambiguous output, or redundant manual worktree setup. The workaround list records the actions actually exercised.

Do not record the task or review subject itself, unmet criteria, unresolved correctness or safety issues, inferred architectural concerns, unused suggestions, expected guided steps, adequately documented proportionate procedures, ordinary agent mistakes, or transient provider failures. This eligibility rule is a trusted-agent instruction; Pipkin does not classify incidents or apply a candidate fix.

Records merge by stable key and retain an occurrence count. `/papercuts` presents open and closed findings; an open finding can be closed, while a later observed recurrence reopens it. Records are factual candidates for repository guidance or small fixes in `agents`, skills, tests, lint, tooling, docs, or code, never automatic work.

A repository and its linked worktrees share one atomically published, leased registry at the canonical primary worktree:

```text
.pi/pipkin/papercuts.json
.pi/pipkin/papercuts.lock
```

Pipkin excludes these paths through the common Git directory's `info/exclude`; it does not change committed `.gitignore`. The footer shows the current host's open count after session start and successful local mutations. Non-interactive `/papercuts` prints a bounded deterministic summary.

The interactive host, public General, Explore, and Review agents, and Implement's planner, review, implementation, revision, repair, and reconciliation workers record directly to this same registry. For repository-preserving workers, it is the sole controlled metadata write; it does not expose source-editing, Git, orchestration, or public-agent controls. Records are not relayed through worker completion data or another persistence path.

## BTW: ask without changing the subject

`/btw` is for the question you want answered but do not want folded into the main agent conversation:

```text
/btw Why did we choose a file lease here?
```

Pipkin sends the current model a bounded view of the session context and prior BTW exchanges, then shows the answer in a disposable non-overlay custom surface. The exchange does not enter the main transcript, trigger the primary agent, or influence later model turns.

BTW has no tools. It cannot inspect files, run commands, or mutate state beyond what is already present in the supplied conversation context. Use an Explore or General agent when the side task needs tool access.

Escape closes or aborts the surface, arrow keys scroll, and `x` clears process-local BTW history for that session. Session replacement and shutdown abort and dispose the active surface, so stale completions are ignored. BTW requires an interactive session, active model, and usable authentication.
