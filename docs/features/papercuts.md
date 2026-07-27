# pi-papercuts

Keep a checkout-local, human-reviewed queue of recurring project-specific failure modes and hidden workflow constraints.

Papercuts capture lessons that should outlive the current session but are not yet encoded in project guidance, tests, tooling, errors, or documentation. Proposals are metadata only: the extension never applies a remediation or edits project files automatically.

## Usage

The agent uses `propose_papercut` when it encounters a durable, repeatable gap with a concrete remediation. A useful proposal identifies:

- what reliably triggers the problem;
- why it will affect a future independent session;
- why existing safeguards were insufficient;
- a concrete resolution and its likely destination.

Good papercuts include undocumented environment constraints, recurring unsafe workflows, and failures that better guidance or automation could prevent. One-off mistakes, transient service failures, expected intermediate errors, and failures already covered by project guidance do not belong in the queue.

Repeated proposals are merged into the existing item and increment its occurrence count instead of creating duplicates.

## Reviewing proposals

Run `/papercuts` to browse proposals grouped by status:

- **Pending** — work on the remediation, mark it resolved, ignore it, edit it, or delete it.
- **Ignored** — review, edit, delete, or reopen it.
- **Resolved** — review, edit, delete, or reopen it.

**Work on this** places a remediation prompt in the editor. It does not mark the papercut resolved; status changes remain an explicit human decision. Resolved and ignored items may include an optional note and target.

In interactive sessions, the footer shows the number of pending papercuts. In non-interactive sessions, `/papercuts` prints a deterministic summary instead of opening the browser.

## Storage

State is stored in the current Git checkout:

```text
.pi/papercuts.json
```

The extension creates the registry and its checkout-local coordination anchor on first use, and adds both to the checkout's `.git/info/exclude`. It does not modify the committed `.gitignore` or create a global registry. Linked worktrees therefore keep separate queues.

A Git checkout is required. The registry uses versioned JSON, atomic writes, and an OS-backed file lease so proposals from concurrent sessions are serialized safely.

## License

MIT
