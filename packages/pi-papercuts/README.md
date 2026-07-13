# pi-papercuts

`pi-papercuts` keeps a checkout-local, human-reviewed queue of recurring project-specific failure modes and hidden workflow constraints.

Use `propose_papercut` only for a durable lesson with a concrete remediation when current project guidance, tests, tooling, errors, or documentation did not adequately prevent or explain it. The tool records metadata only; it never edits the suggested destination.

Use `/papercuts` to browse pending items, work on a remediation prompt, resolve, ignore, edit, delete, or reopen proposals. In non-interactive sessions it prints a deterministic summary.

State is stored at `.pi/papercuts.json` in the current Git checkout and locally excluded with `/.pi/papercuts.json`. It is never added to committed `.gitignore` and no global registry is created.
