# pi-deepinfra

Pi extension that registers [DeepInfra](https://deepinfra.com) as a model provider.

On startup it fetches the live DeepInfra model catalog, filters it to chat-capable models, and registers them under the `deepinfra` provider using the OpenAI-compatible API.

## Setup

```bash
export DEEPINFRA_API_KEY="your-key"
```

Then pick a model with `/model` → `deepinfra/…`.

## Filtering

Models are excluded when they:

- lack the `chat` tag (embeddings, TTS, image generation, etc.)
- are proxied partner models already covered by pi's built-in providers (`anthropic/`, `google/gemini-`, `openai/`)
- have a context window smaller than 8192 tokens

## Compat flags

Reasoning/thinking format and cache control are inferred from model tags and ID prefix:

| Condition                             | Flags                                                         |
| ------------------------------------- | ------------------------------------------------------------- |
| `deepseek-ai/` + `reasoning` tag      | `thinkingFormat: "deepseek"`                                  |
| `Qwen/` + `reasoning_effort` tag      | `thinkingFormat: "qwen"`, `supportsReasoningEffort: true`     |
| `zai-org/` prefix                     | `thinkingFormat: "zai"`                                       |
| `reasoning` + `reasoning_effort` tags | `thinkingFormat: "together"`, `supportsReasoningEffort: true` |
| `reasoning` tag only                  | `thinkingFormat: "together"`                                  |
| `prompt_cache` tag                    | `cacheControlFormat: "anthropic"`                             |

## Error handling

If the model list fetch fails at startup, the extension continues with an empty model list so pi still starts normally.

Context overflow errors from DeepInfra are rewritten to start with `context_length_exceeded` so pi's auto-compaction triggers correctly.
