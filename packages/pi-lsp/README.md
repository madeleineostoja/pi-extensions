# pi-lsp

`pi-lsp` is a bounded, process-global, read-only Language Server Protocol runtime for TypeScript/JavaScript/React, Svelte, and environment-provided Ruby LSP servers. It is a foundation package; it does not register a model-facing tool.

Servers run as trusted direct subprocesses, outside `pi-sandbox`. Fixed server resolution uses packaged `typescript-language-server` and `svelte-language-server`; TypeScript uses a workspace SDK when present and otherwise the packaged SDK. Ruby only resolves `<workspace>/bin/ruby-lsp` or `ruby-lsp` from the inherited `PATH`; this package never installs Ruby, gems, Bundler dependencies, or alternative servers. Ruby LSP may maintain its own `.ruby-lsp/` directory.

All document targets are canonicalized and bounded to the caller workspace. The protocol handler explicitly rejects `workspace/applyEdit`, and the package implements no formatting, rename, code actions, commands, or compiler/linter validation.
