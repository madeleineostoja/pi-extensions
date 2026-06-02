# pi-footer

Pi extension that replaces the built-in footer with a compact status bar.

## Display

- Starship-inspired current directory basename and git branch (``)
- Selected model, thinking level, cost, and context usage (`󰔚`)
- Extension statuses from `ctx.ui.setStatus()`

Cost is estimated from assistant usage on the active branch, including prompt-cache read/write pricing and per-response model switches. Subscription-auth responses are excluded; cost is hidden when the branch has only subscription usage.

## Install

Install as part of this bundle:

```bash
pi install git:github.com/madeleineostoja/pi-extensions
```

Or install this package directly if published/linked in your environment.
