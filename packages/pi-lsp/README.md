# pi-lsp

`pi-lsp` provides the read-only `lsp` tool and `/lsp` runtime status command for focused semantic queries. It supports TypeScript, JavaScript, JSX, TSX, MJS, CJS, MTS, and CTS through the packaged TypeScript language server; `.svelte` through the packaged Svelte server; and Ruby (`.rb`, `.rake`) only when the active environment already provides `ruby-lsp`.

Use LSP for definitions, type definitions, implementations, references, hover/type information, symbols, and explicit file diagnostics. Use text search or Explore for broad discovery, request diagnostics after coherent edit batches, and run the project's lint/typecheck/tests/build as final validation. Diagnostics never run automatically after edits. When support is unavailable, the tool returns a non-fatal fallback result: continue with source search or project CLI tooling and do not install dependencies unless asked.

Servers are discovered lazily and a workspace-specific process starts only when a semantic request needs it. `/lsp` reports available/not-started, running, cooling-down, and unavailable state without starting every server. TypeScript prefers a workspace SDK and falls back to the packaged TypeScript SDK. Ruby is not bundled or installed: it requires project-compatible Ruby, Bundler, dependencies, and `ruby-lsp`; devcontainer projects must run Pi inside their provisioned devcontainer. Ruby LSP may manage `.ruby-lsp/` state itself.

Language servers are trusted extension subprocesses launched directly outside `pi-sandbox`/`nono`. They inherit Pi's environment and may inspect project configuration or dependencies. The model cannot select executables, submit arbitrary protocol methods, apply edits, run commands, or query paths outside the selected workspace.
