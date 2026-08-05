# Interface and Personality

Pipkin's interface features stay quiet: UI keeps operational state visible, while Personality makes sessions recognizable later.

## UI

The footer presents a width-aware subset of:

- current directory and Git branch;
- selected model and thinking level;
- active-branch cost across model switches;
- prompt-cache hit rate;
- context-window usage; and
- ordered extension status such as Sandbox mode, Readonly mode, or pending Papercuts.

Cost includes assistant usage and prompt-cache read/write pricing on the active branch. Subscription-auth responses are excluded; cost disappears when the branch contains only subscription usage. Cache hit rate appears after cache activity exists.

Sandbox, Readonly, and Papercuts publish source-owned `normal`, `warning`, or `error` statuses. Sandbox becomes warning-yellow and shows its active-runtime denial count after a confirmed direct-tool or kernel Bash write denial.

UI also owns the generic bounded Activity view. Processes, Subagents, and Implement publish source-qualified queued, running, or waiting work but keep ownership of their records, lifecycle, inspectors, cleanup, and terminal delivery; they remove settled work immediately. The full-width pending-work box has no history or count. Activity excludes prompts, commands, cwd, raw output, hidden runtime objects, provider payloads, cost, and aggregate token telemetry. A Subagent row may show current context usage and one already-bounded latest-assistant preview.

UI does not replace Pi's editor, working indicator, selectors, built-in tool renderers, or custom-message presentation.

## Session naming

Personality gives an unnamed session a short title from up to three early non-empty prompts. It uses the `utility` model preset asynchronously, so naming never delays the main agent turn, and writes Pi's canonical session name for `/resume`, terminal titles, and window titles.

Personality never replaces a manually assigned or existing ordinary-session name. If the utility model cannot run, it derives a local fallback from the initial prompt. Titles use the first non-empty generated line, remove labels and surrounding quotes, collapse whitespace, and stop at 40 characters on a word boundary.

When an Implement run or restart successfully starts, it receives an asynchronous `Implement …` title based on a bounded excerpt of the root plan. The active run owns session identity, so this replaces an earlier name. Invalid or unavailable generation falls back to `Implement run`. Blocked, control, and all-checked no-op commands leave the name unchanged.

See [Configuration](../configuration.md#model-presets) for model routing.

## Fresh-session welcome

On an empty fresh TUI startup or `/new`, Personality shows a synchronous one- or two-line greeting. It may use the configured nickname and local time band, and includes only the workspace basename as muted detail.

The greeting disappears on first accepted input or a session-name update. It never appears on reload, resume, or fork, waits for no model or history lookup, and does not change session naming.

See [Nickname](../configuration.md#nickname) for configuration.
