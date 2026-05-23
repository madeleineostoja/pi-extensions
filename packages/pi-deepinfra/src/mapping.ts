import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";

// DeepInfra's API always returns max_tokens === context_length, so it carries
// no real output-token information. Cap to values that match pi's own model
// defaults: 16384 is the fallback pi-coding-agent uses for custom models in
// models.json; 65536 is a conservative ceiling for reasoning models (pi-ai's
// built-in reasoning models have a median maxTokens of ~100k, but DeepInfra
// limits vary widely and users can override via models.json).
const MAX_OUTPUT_NON_REASONING = 16384;
const MAX_OUTPUT_REASONING = 65536;

const MIN_CONTEXT_WINDOW = 8192;

export const EXCLUDED_PREFIXES = ["anthropic/", "google/gemini-", "openai/"];

// Matches DeepInfra context-overflow error strings. Deliberately excludes
// "token limit" without a context/prompt/input qualifier to avoid catching
// rate-limit or quota errors like "monthly token limit exceeded".
export const OVERFLOW_RE =
  /(maximum context length|context (window |length )?(too long|exceed)|prompt (is )?too long|input (tokens? )?(exceed|too long)|(context|prompt|input) tokens? exceed)/i;

export interface DeepInfraModel {
  id: string;
  tags?: string[];
  metadata?: {
    context_length?: number;
    max_tokens?: number;
    pricing?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_tokens?: number;
    };
  };
}

export interface DeepInfraModelsResponse {
  data: DeepInfraModel[];
}

export function stripOrgPrefix(id: string): string {
  const slash = id.indexOf("/");
  if (slash === -1) return id;
  return id
    .slice(slash + 1)
    .replace(/-/g, " ")
    .replace(/_/g, " ");
}

export function mapModel(model: DeepInfraModel): ProviderModelConfig {
  const tags = model.tags ?? [];
  const meta = model.metadata ?? {};
  const pricing = meta.pricing ?? {};

  const hasReasoningTag = tags.includes("reasoning");
  const hasReasoningEffort = tags.includes("reasoning_effort");
  const isReasoning = hasReasoningTag || hasReasoningEffort;
  const isVision = tags.includes("vision") || tags.includes("vlm");
  const hasPromptCache = tags.includes("prompt_cache");

  const contextWindow = meta.context_length ?? MIN_CONTEXT_WINDOW;
  const maxTokensCap = isReasoning
    ? MAX_OUTPUT_REASONING
    : MAX_OUTPUT_NON_REASONING;
  const maxTokens = Math.min(meta.max_tokens ?? contextWindow, maxTokensCap);

  const compat: ProviderModelConfig["compat"] = {
    maxTokensField: "max_tokens",
    supportsDeveloperRole: false,
  };

  const id = model.id;

  if (id.startsWith("deepseek-ai/") && hasReasoningTag) {
    compat.thinkingFormat = "deepseek";
  } else if (id.startsWith("Qwen/") && hasReasoningEffort) {
    compat.thinkingFormat = "qwen";
    compat.supportsReasoningEffort = true;
  } else if (id.startsWith("zai-org/")) {
    compat.thinkingFormat = "zai";
  } else if (hasReasoningEffort) {
    compat.thinkingFormat = "together";
    compat.supportsReasoningEffort = true;
  } else if (hasReasoningTag) {
    compat.thinkingFormat = "together";
  }

  if (hasPromptCache) {
    compat.cacheControlFormat = "anthropic";
  }

  return {
    id,
    name: stripOrgPrefix(id),
    reasoning: isReasoning,
    input: isVision ? ["text", "image"] : ["text"],
    contextWindow,
    maxTokens,
    cost: {
      input: pricing.input_tokens ?? 0,
      output: pricing.output_tokens ?? 0,
      cacheRead: pricing.cache_read_tokens ?? 0,
      cacheWrite: 0,
    },
    compat,
  };
}

export function shouldIncludeModel(model: DeepInfraModel): boolean {
  const tags = model.tags ?? [];
  if (!tags.includes("chat")) return false;
  if (EXCLUDED_PREFIXES.some((p) => model.id.startsWith(p))) return false;
  if ((model.metadata?.context_length ?? 0) < MIN_CONTEXT_WINDOW) return false;
  return true;
}
