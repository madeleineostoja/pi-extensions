# Interface and Personality

Pipkin's interface features stay quiet: UI keeps operational state visible, while Personality makes sessions recognizable later.

## UI

The footer presents a width-aware subset of:

- current directory and Git branch;
- selected model and thinking level;
- active-branch cost across model switches;
- prompt-cache hit rate;
- context-window usage; and
- ordered extension status such as Readonly mode, Sandbox mode, or pending Papercuts.

Cost includes assistant usage and prompt-cache read/write pricing on the active branch. Subscription-auth responses are excluded; cost disappears when the branch contains only subscription usage. Cache hit rate appears after cache activity exists.

A long Git branch yields to the complete model/cost/cache/context segment before the optional context-window detail is removed. Sandbox, Readonly, and Papercuts publish source-owned `normal`, `warning`, or `error` statuses. Sandbox becomes warning-yellow and shows its active-runtime denial count after a confirmed direct-tool or kernel Bash write denial.

UI also owns the generic bounded Activity view. Processes, Subagents, and Implement publish source-qualified queued, running, or waiting work but keep ownership of their records, lifecycle, inspectors, cleanup, and terminal delivery; they remove settled work immediately. The full-width pending-work box has no history or count. Activity excludes prompts, commands, cwd, raw output, hidden runtime objects, provider payloads, cost, and aggregate token telemetry. A Subagent row may show current context usage and one already-bounded latest-assistant preview.

UI does not replace Pi's editor, working indicator, selectors, built-in tool renderers, or custom-message presentation.

## Session naming

Personality gives an unnamed session a short title from up to three early non-empty prompts. It uses the `utility` model preset asynchronously, so naming never delays the main agent turn, and writes Pi's canonical session name for `/resume`, terminal titles, and window titles. Bounded branch, changed-area, recent-commit, and recent-session context can disambiguate the request, but the request remains the title's subject. Evidence from recent sessions may support a compact continuity touch such as `Continue …` or `— again`; incidental Git activity does not.

Personality never replaces a manually assigned or existing ordinary-session name. If the utility model cannot run, it derives a local fallback from the initial prompt. Titles use the first non-empty generated line, remove labels and surrounding quotes, collapse whitespace, and stop at 40 characters on a word boundary. When an automatic title is applied in the TUI, Personality quietly announces it with a small mascot notification.

When an Implement run or restart successfully starts, it claims naming ownership before its asynchronous title lookup. It receives an `Implement …` title based on a bounded excerpt of the root plan; repository context can only disambiguate that authoritative plan and continuity wording is deliberately conservative. The active run owns session identity, so this replaces an earlier name and its Activity title. Invalid or unavailable generation falls back to `Implement run`. Blocked, control, and all-checked no-op commands leave the name unchanged.

See [Configuration](../configuration.md#model-presets) for model routing.

## Fresh-session welcome

On an empty fresh TUI startup or `/new`, Personality shows a compact passive identity card with a small kaomoji mascot, a stable varied greeting, and one friendly context signal. Greetings use the optional configured nickname, local time band, and supported continuity; a stable session seed keeps wording fixed across rerenders. The single subline prioritizes changed files, then a recent meaningful session, then the latest commit, and finally a friendly fallback. It deliberately does not repeat repository, branch, model, cost, or other operational UI facts.

The card collects its bounded recent-session and read-only Git context before installing, so it never flashes a provisional card. Missing history or Git information simply falls back gracefully. It disappears on first accepted input or a session-name update, and never appears on reload, resume, or fork.

See [Nickname](../configuration.md#nickname) for configuration.
