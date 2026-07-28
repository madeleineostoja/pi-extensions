# Interface and Personality

Pipkin's interface features are intentionally quiet. They keep important state visible, stop temporary choices from becoming accidental defaults, name sessions so they can be found again, and keep the machine awake while a session is open.

## UI: a footer that answers operational questions

Pipkin replaces Pi's footer with a compact display of:

- current directory and Git branch;
- selected model and thinking level;
- active-branch cost across model switches;
- prompt-cache hit rate;
- context-window usage;
- extension statuses such as Sandbox mode, readonly mode, active agents, or pending papercuts.

Cost includes assistant usage and prompt-cache read/write pricing on the active branch. Subscription-auth responses are excluded, and cost disappears when the branch contains only subscription usage. Cache hit rate appears after cache activity exists.

The footer adapts to terminal width rather than forcing every metric onto one crowded line.

## Defaults: experiment without rewriting tomorrow

Defaults preserves Pi's persisted `settings.json` values for `defaultModel`, `defaultProvider`, and `defaultThinkingLevel`.

Switching model or thinking during a session—or launching with `pi --model`—changes that session without silently rewriting the persisted defaults used for the next one. Pi continues to own `settings.json`; Pipkin's configuration file remains separate.

## Personality: sessions you can recognize later

Personality gives an unnamed session a short descriptive title from its early non-empty prompts. It uses the `utility` model preset and sets Pi's canonical session name, so the result appears naturally in `/resume`, the terminal title, and the window title.

Naming runs asynchronously and never delays the main agent turn. Up to three early prompts may provide context if naming has not completed yet. Personality never replaces a manually assigned or existing name.

If the utility model cannot run, Pipkin derives a local fallback from the initial prompt. Titles use the first non-empty generated line, strip labels and surrounding quotes, collapse whitespace, and stop at 40 characters on a word boundary.

See [Configuration](../configuration.md#model-presets) for the `utility` route.

## Caffeinate: keep long work from sleeping halfway through

Caffeinate holds an idle-sleep inhibitor for the lifetime of an open Pi session:

- macOS uses `caffeinate -i -w <pi-pid>`;
- Linux uses `systemd-inhibit` with a process watcher;
- unsupported platforms do nothing.

It starts at `session_start`, stops at `session_shutdown`, and the child watches Pi's PID so the inhibitor is released if normal extension cleanup does not run. Missing platform commands degrade to a no-op. It does not override laptop lid-close behavior.

Logs are written to `<agent-dir>/pipkin/logs/pipkin-caffeinate.log`, falling back to the system temporary directory if the agent log directory cannot be created.
