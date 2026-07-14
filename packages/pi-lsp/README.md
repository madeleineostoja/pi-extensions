# pi-lsp

Add focused, read-only language-server queries to Pi through the `lsp` tool, plus `/lsp` for runtime status.

LSP is useful for semantic relationships that text search can miss: definitions, implementations, references, type information, symbols, hover details, and explicit diagnostics. It complements source search and project validation rather than replacing them.

## Supported languages

| Language                  | File types                                                   | Language server                                   |
| ------------------------- | ------------------------------------------------------------ | ------------------------------------------------- |
| TypeScript and JavaScript | `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs`, `.mts`, `.cts` | Packaged `typescript-language-server`             |
| Svelte                    | `.svelte`                                                    | Packaged `svelte-language-server`                 |
| Ruby                      | `.rb`, `.rake`                                               | Existing `ruby-lsp` from `bin/ruby-lsp` or `PATH` |

TypeScript prefers the workspace's TypeScript SDK and falls back to the packaged SDK. Ruby and `ruby-lsp` are not installed by this extension; Pi must run in an environment where the project's Ruby, Bundler dependencies, and language server are already available. For devcontainer projects, run Pi inside the provisioned container.

## Tool actions

| Action              | Purpose                                 | Required input                           |
| ------------------- | --------------------------------------- | ---------------------------------------- |
| `definition`        | Find a symbol's definition              | `file`, `line`, and `column` or `symbol` |
| `type_definition`   | Find a symbol's type definition         | `file`, `line`, and `column` or `symbol` |
| `implementation`    | Find implementations                    | `file`, `line`, and `column` or `symbol` |
| `references`        | Find references                         | `file`, `line`, and `column` or `symbol` |
| `hover`             | Get hover or type information           | `file`, `line`, and `column` or `symbol` |
| `document_symbols`  | List symbols in a file                  | `file`                                   |
| `workspace_symbols` | Search workspace symbols                | `query`                                  |
| `diagnostics`       | Request diagnostics for a file          | `file`                                   |
| `status`            | Show server discovery and runtime state | None                                     |

Files may be workspace-relative or absolute but must remain inside the selected workspace. Lines, columns, and `occurrence` are 1-indexed. `occurrence` selects among repeated instances of a symbol on the same line. Requests default to a five-second timeout, configurable up to 15 seconds.

Use LSP for targeted semantic questions. Prefer text search or Explore for broad discovery, and request diagnostics after a coherent edit batch rather than while code is intentionally incomplete.

## Runtime behavior

Servers are discovered and started lazily when a semantic request needs them. Processes are shared within a workspace, reused across requests, and retired after being idle. If a server is unavailable, cooling down after a failure, or lacks a requested capability, the tool returns a non-fatal fallback result so the agent can continue with source search or project tooling.

Run `/lsp` to inspect discovered and active servers. It reports `not-started`, `starting`, `running`, `cooling-down`, and `unavailable` states without starting every server.

Results are normalized and bounded. Locations, symbols, and diagnostics are limited to 100 entries, hover output is limited to 2,000 characters, and truncation is reported. Diagnostics are requested explicitly and may be unavailable, stale, or time out; always run the project's required lint, typecheck, tests, or build for authoritative validation.

## Security boundary

The model can only select the extension's fixed actions and supported file types. It cannot choose executables, send arbitrary protocol methods, apply edits, run commands, or query files outside the selected workspace.

Language servers themselves are trusted extension subprocesses launched outside `pi-sandbox` and `nono`. They inherit Pi's environment and may inspect project configuration and dependencies.

## License

MIT
