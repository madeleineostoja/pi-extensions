# Workflow tools

Pipkin includes several focused utilities for semantic navigation, overlapping commands, durable friction notes, and transcript-independent side questions.

## LSP

The read-only `lsp` tool complements text search with language-server relationships and type information.

| Action              | Question answered                                                    |
| ------------------- | -------------------------------------------------------------------- |
| `definition`        | Where is this symbol defined?                                        |
| `type_definition`   | Where is its type defined?                                           |
| `implementation`    | What implements this contract?                                       |
| `references`        | Where is it used?                                                    |
| `hover`             | What type or documentation does the server know here?                |
| `document_symbols`  | What symbols are in this file?                                       |
| `workspace_symbols` | Where is a symbol with this name in the workspace?                   |
| `diagnostics`       | What diagnostics does the server report for this file?               |
| `status`            | Which servers are discovered, running, cooling down, or unavailable? |

Position queries use a workspace-relative or absolute `file` with 1-indexed `line` and `column`. When symbol text is known, `symbol` can replace the column and `occurrence` selects a repeated instance.

Use LSP for focused semantic relationships, text search for literal discovery, and Explore for multi-step mapping. Diagnostics are advisory; project lint, typecheck, tests, and builds remain authoritative.

### Supported languages

| Language                | Files                                                        | Server                                                                 |
| ----------------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------- |
| TypeScript / JavaScript | `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs`, `.mts`, `.cts` | Packaged `typescript-language-server`, preferring workspace TypeScript |
| Svelte                  | `.svelte`                                                    | Packaged `svelte-language-server`                                      |
| Ruby                    | `.rb`, `.rake`                                               | Project-provisioned `ruby-lsp` from `bin/ruby-lsp` or `PATH`           |

Servers start lazily, are shared per workspace, and retire after idle time. Requests default to five seconds and cap at 15. Results are bounded to 100 locations, symbols, or diagnostics and 2,000 hover characters; rendered lists also use Pi's ordinary tool-result limits.

Unavailable servers and unsupported capabilities return non-fatal fallback results. Collapsed rows identify the operation, target, and available result count; expanding a row preserves the complete bounded semantic output. The model cannot choose an executable, send arbitrary protocol methods, apply edits, or invoke server commands. Language servers are trusted processes outside Sandbox and inherit Pi's environment.

## Managed processes

Use foreground Bash when completion is immediately required. Use managed processes only when useful independent work can continue.

| Tool or command      | Purpose                                                        |
| -------------------- | -------------------------------------------------------------- |
| `start_process`      | Start one foreground, non-interactive command and return an ID |
| `get_process_result` | Wait once or inspect bounded output/status                     |
| `stop_process`       | Stop a process and return final output or a recallable outcome |
| `/processes`         | Human live inspection and confirmed stop controls              |

`untilContains` waits eventfully for one case-sensitive literal on either stream; timeout ends only the wait. Use bounded tail or `find` inspection when output changes the next decision. Use `resultMode: "outcome"` when status is enough, then recall that point-in-time result if needed. A later output-mode request is required for newer output. Do not poll.

Commands must remain foreground and non-interactive. Stop work that is no longer needed.

## Papercuts

`record_papercut` is an experimental factual inbox, not a backlog or remediation system. A finding qualifies only when all of these are true:

1. The assigned subject was something else.
2. The agent encountered concrete avoidable friction.
3. It exercised at least one workaround or detour.
4. It completed or safely continued the assigned task.

Qualifying friction may include a flaky documented test handled with a narrower command, an undocumented validation convention, ambiguous output requiring context reconstruction, or redundant manual setup.

Do not record the task or review subject itself, unmet criteria, unresolved correctness or safety problems, inferred architecture, unused suggestions, expected guided steps, adequately documented procedures, one-off agent mistakes, or transient provider failures.

Records merge by stable key and retain occurrence count. A collapsed confirmation names the recorded key and outcome; expanding it preserves the complete model-facing confirmation. `/papercuts` shows open and closed findings; closing is reversible when a later recurrence reopens the key. Findings are candidates for repository guidance or small fixes, never automatic work.

A repository and linked worktrees share one leased registry in the canonical primary worktree:

```text
.pi/pipkin/papercuts.json
.pi/pipkin/papercuts.lock
```

The paths are excluded through common Git `info/exclude`, not committed `.gitignore`. Repository-preserving workers may write only this controlled personal metadata; it grants no source, Git, or orchestration authority.

## BTW

`/btw` asks a side question without adding the exchange to the main transcript:

```text
/btw Why did we choose a file lease here?
```

Pipkin sends the current model a bounded view of session context and prior BTW exchanges, then shows the answer in a disposable full-screen surface. The exchange does not trigger the primary agent or affect later model turns.

BTW has no tools: it cannot inspect files, run commands, or mutate state beyond what is already in supplied context. Use Explore when the side task needs tools.

Escape closes or aborts, arrow keys scroll, and `x` clears process-local BTW history. Session replacement and shutdown dispose the active surface. BTW requires an interactive session, active model, and usable authentication.
