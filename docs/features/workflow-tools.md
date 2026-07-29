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

The model can choose only Pipkin's fixed read-only actions, supported files, and in-workspace paths. It cannot choose an executable, send arbitrary protocol methods, apply edits, or invoke server commands. The language servers themselves are trusted processes outside Guard and inherit Pi's environment.

## Papercuts: keep the lesson, not just the scar

`propose_papercut` records a recurring project-specific failure mode or hidden constraint for later human review. It is for lessons that should outlive this session but have not yet made their way into guidance, tests, tooling, errors, documentation, or code.

A proposal captures the lesson in a form that can become a real fix:

| Field                  | What belongs there                                                          |
| ---------------------- | --------------------------------------------------------------------------- |
| `key`                  | Stable lowercase slug for deduplication                                     |
| `title`                | Concise human-readable summary                                              |
| `trigger`              | Repeatable condition that exposes the gap                                   |
| `impact`               | Why it matters in a future independent session                              |
| `currentGap`           | What current guidance, tests, tooling, errors, docs, or code fails to cover |
| `proposedResolution`   | A concrete durable remedy                                                   |
| `suggestedDestination` | `agents`, `skill`, `test`, `lint`, `tooling`, `docs`, or `code`             |

One-off mistakes, transient service failures, expected intermediate errors, and behavior already explained by the project do not qualify. Repeated proposals merge into the existing record and increment its occurrence count.

Run `/papercuts` to browse pending, ignored, and resolved items. From the interactive browser you can inspect, edit, reopen, ignore, resolve, or delete a proposal. **Work on this** drafts a remediation prompt in the editor but deliberately does not mark the record resolved.

Each Git checkout keeps its own atomically written, leased registry:

```text
.pi/pipkin/papercuts.json
.pi/pipkin/papercuts.lock
```

Pipkin adds the paths to that checkout's `.git/info/exclude`; it never changes committed `.gitignore` and does not keep a global queue. The footer shows the pending count in interactive sessions. Non-interactive `/papercuts` prints a deterministic summary.

## BTW: ask without changing the subject

`/btw` is for the question you want answered but do not want folded into the main agent conversation:

```text
/btw Why did we choose a file lease here?
```

Pipkin sends the current model a bounded view of the session context and prior BTW exchanges, then shows the answer in an overlay. The exchange does not enter the main transcript, trigger the primary agent, or influence later model turns.

BTW has no tools. It cannot inspect files, run commands, or mutate state beyond what is already present in the supplied conversation context. Use an Explore or General agent when the side task needs tool access.

Escape closes or aborts the overlay, arrow keys scroll, and `x` clears process-local BTW history for that session. BTW requires an interactive session, active model, and usable authentication.
