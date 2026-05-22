# pi-caffeinate

Tiny pi extension that prevents the host from idle-sleeping for the lifetime of a pi session.

- macOS: `caffeinate -i -w <pi-pid>`
- Linux: `systemd-inhibit --what=idle:sleep -- tail --pid <pi-pid> -f /dev/null`
- Other platforms: no-op

No config, no slash commands, no UI. Starts on `session_start`, stops on `session_shutdown`. The child watches pi's PID and exits on its own when pi dies, so the inhibitor is released even if pi is killed with `SIGKILL` and our shutdown handlers never run.

This deliberately does **not** try to detect when pi is "active". The inhibitor is held for the whole session — including idle time at the prompt. Defining "active" reliably (queued steering, parallel tools, follow-ups, the gap during `/reload`) is more trouble than it's worth for a problem this small. If you don't want pi keeping your laptop awake when you're not using it, quit pi.

## Try it

```bash
pi -e ./src/index.ts
```

## Install

```bash
pi install "$PWD"
```

## Notes

- Lid-close on a laptop will still suspend the machine. This only blocks the idle-sleep timer (and on Linux, also the sleep transition itself, since `systemd-inhibit --what=sleep` is stronger than `caffeinate -i`).
- If `caffeinate` / `systemd-inhibit` isn't on `$PATH`, the extension silently does nothing.
- Linux requires GNU coreutils for `tail --pid`. This ships on every distro that has `systemd-inhibit`.
