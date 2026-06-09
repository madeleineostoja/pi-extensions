# pi-footer

Pi extension that replaces the built-in footer with a compact status bar.

## Display

- Starship-inspired current directory basename and git branch (``)
- Selected model, thinking level, cost, cache hit rate (`󰃨`), and context usage (`󰔚`)
- Extension statuses from `ctx.ui.setStatus()`

Cost is estimated from assistant usage on the active branch, including prompt-cache read/write pricing and per-response model switches. When a cached USD/NZD exchange rate is available, the displayed cost is converted to NZD; otherwise the cost is hidden. Subscription-auth responses are excluded; cost is hidden when the branch has only subscription usage.

Cache hit rate shows the latest prompt cache hit rate as a percentage, computed from the most recent assistant response. It appears only after there has been some cache read or write activity.

## Install

Install as part of this bundle:

```bash
pi install git:github.com/madeleineostoja/pi-extensions
```

Or install this package directly if published/linked in your environment.
