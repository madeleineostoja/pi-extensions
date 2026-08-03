# Interface and Personality

Pipkin's interface features are intentionally quiet. They keep important state visible and name sessions so they can be found again.

## UI: a footer that answers operational questions

Pipkin replaces Pi's footer with a compact display of:

- current directory and Git branch;
- selected model and thinking level;
- active-branch cost across model switches;
- prompt-cache hit rate;
- context-window usage;
- ordered extension statuses such as Sandbox mode, readonly mode, or pending papercuts.

Cost includes assistant usage and prompt-cache read/write pricing on the active branch. Subscription-auth responses are excluded, and cost disappears when the branch contains only subscription usage. Cache hit rate appears after cache activity exists.

The footer adapts to terminal width rather than forcing every metric onto one crowded line. Sandbox, Readonly, and Papercuts publish source-owned `normal`, `warning`, or `error` statuses with required icons; unknown statuses retain their icon or receive a generic fallback. Sandbox turns warning-yellow with its active-runtime denial count after a confirmed direct-tool or kernel Bash write denial.

UI owns the generic Activity widget and status presentation. Subagents, Implement, and Processes independently publish bounded source-qualified activity; Processes owns its `/processes` inspector and process cleanup, while UI never imports a producer or owns its records. It does not replace Pi's editor, working indicator, ordinary selectors, built-in tool renderers, or custom-message presentation.

## Personality: sessions you can recognize later

Personality gives an unnamed session a short descriptive title from its early non-empty prompts. It uses the `utility` model preset and sets Pi's canonical session name, so the result appears naturally in `/resume`, the terminal title, and the window title.

Naming runs asynchronously and never delays the main agent turn. Up to three early prompts may provide context if naming has not completed yet. Personality never replaces a manually assigned or existing name.

If the utility model cannot run, Pipkin derives a local fallback from the initial prompt. Titles use the first non-empty generated line, strip labels and surrounding quotes, collapse whitespace, and stop at 40 characters on a word boundary.

On an empty fresh TUI startup or `/new` session, Personality also shows a synchronous one- or two-line greeting. It uses the optional configured nickname and local time band, includes only the current workspace basename as muted detail, and disappears on the first accepted input. It never appears on reload, resume, or fork, waits for no model or history lookup, and never changes session naming.

See [Configuration](../configuration.md#model-presets) for the `utility` route and [nickname](../configuration.md#nickname) for the greeting setting.
