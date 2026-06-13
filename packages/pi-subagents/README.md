# pi-subagents

First-party pi-subagents extension with runtime and interactive tools.

## Extension entrypoint

`./src/index.ts` registers public builtin definitions (`General`, `Explore`, `Review`) and interactive tools (`Agent`, `get_subagent_result`, `steer_subagent`).

## Runtime API

```ts
import { getSubagentRuntime } from "pi-subagents/runtime";

const runtime = getSubagentRuntime();
runtime.registerDefinition({ name: "Custom", public: false, ... });
const id = await runtime.spawn({ type: "General", prompt: "...", description: "..." });
const result = await runtime.waitFor(id);
await runtime.stop(id);
await runtime.steer(id, "change direction");
const snapshots = runtime.snapshots();
```

## Config

Global config lives at `~/.pi/agent/extensions/pi-subagents/config.json` and only supports a model map for public builtins:

```json
{
  "models": {
    "General": "provider/model-id",
    "Explore": "provider/model-id",
    "Review": "provider/model-id"
  }
}
```

Invalid config fields are ignored with warnings.
