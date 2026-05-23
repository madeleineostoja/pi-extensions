import { describe, expect, it } from "vitest";
import {
  EXCLUDED_PREFIXES,
  OVERFLOW_RE,
  mapModel,
  shouldIncludeModel,
  stripOrgPrefix,
} from "./mapping.ts";
import type { DeepInfraModel } from "./mapping.ts";

interface OAICompat {
  thinkingFormat?: string;
  supportsReasoningEffort?: boolean;
  cacheControlFormat?: string;
  maxTokensField?: string;
  supportsDeveloperRole?: boolean;
}

const compat = (m: ReturnType<typeof mapModel>): OAICompat =>
  m.compat as OAICompat;

// ── stripOrgPrefix ────────────────────────────────────────────────────────────

describe("stripOrgPrefix", () => {
  it("strips the org part and leaves the rest", () => {
    expect(stripOrgPrefix("Qwen/Qwen3-Max")).toBe("Qwen3 Max");
  });

  it("converts underscores to spaces", () => {
    expect(stripOrgPrefix("moonshotai/Kimi_K2")).toBe("Kimi K2");
  });

  it("handles a model with no slash", () => {
    expect(stripOrgPrefix("no-prefix-model")).toBe("no-prefix-model");
  });

  it("handles a nested org (only first segment stripped)", () => {
    expect(stripOrgPrefix("deepseek-ai/DeepSeek-R1")).toBe("DeepSeek R1");
  });
});

// ── shouldIncludeModel ────────────────────────────────────────────────────────

describe("shouldIncludeModel", () => {
  const chatModel = (
    overrides: Partial<DeepInfraModel> = {},
  ): DeepInfraModel => ({
    id: "some-org/some-model",
    tags: ["chat"],
    metadata: { context_length: 32768 },
    ...overrides,
  });

  it("accepts a basic chat model", () => {
    expect(shouldIncludeModel(chatModel())).toBe(true);
  });

  it("rejects a model without the chat tag", () => {
    expect(shouldIncludeModel(chatModel({ tags: ["embed"] }))).toBe(false);
  });

  it("rejects models in the excluded-prefix list", () => {
    for (const prefix of EXCLUDED_PREFIXES) {
      expect(shouldIncludeModel(chatModel({ id: `${prefix}some-model` }))).toBe(
        false,
      );
    }
  });

  it("rejects models with context_length below 8192", () => {
    expect(
      shouldIncludeModel(chatModel({ metadata: { context_length: 4096 } })),
    ).toBe(false);
  });

  it("accepts a model with exactly 8192 context", () => {
    expect(
      shouldIncludeModel(chatModel({ metadata: { context_length: 8192 } })),
    ).toBe(true);
  });

  it("rejects TTS/image-gen models that have no chat tag", () => {
    expect(shouldIncludeModel(chatModel({ tags: ["tts"] }))).toBe(false);
    expect(shouldIncludeModel(chatModel({ tags: ["image-gen"] }))).toBe(false);
  });
});

// ── mapModel ──────────────────────────────────────────────────────────────────

describe("mapModel", () => {
  const base = (overrides: Partial<DeepInfraModel> = {}): DeepInfraModel => ({
    id: "some-org/Model-7B",
    tags: ["chat"],
    metadata: {
      context_length: 32768,
      max_tokens: 32768,
      pricing: { input_tokens: 0.1, output_tokens: 0.3 },
    },
    ...overrides,
  });

  it("maps basic fields correctly", () => {
    const m = mapModel(base());
    expect(m.id).toBe("some-org/Model-7B");
    expect(m.name).toBe("Model 7B");
    expect(m.reasoning).toBe(false);
    expect(m.input).toEqual(["text"]);
    expect(m.contextWindow).toBe(32768);
    expect(m.cost).toEqual({
      input: 0.1,
      output: 0.3,
      cacheRead: 0,
      cacheWrite: 0,
    });
  });

  it("caps non-reasoning maxTokens at 16384", () => {
    const m = mapModel(
      base({ metadata: { context_length: 131072, max_tokens: 131072 } }),
    );
    expect(m.maxTokens).toBe(16384);
  });

  it("caps reasoning maxTokens at 65536", () => {
    const m = mapModel(
      base({
        id: "some-org/Thinker",
        tags: ["chat", "reasoning"],
        metadata: { context_length: 131072, max_tokens: 131072 },
      }),
    );
    expect(m.maxTokens).toBe(65536);
  });

  it("sets reasoning:true and thinkingFormat:together for reasoning tag only", () => {
    const m = mapModel(base({ tags: ["chat", "reasoning"] }));
    expect(m.reasoning).toBe(true);
    expect(compat(m).thinkingFormat).toBe("together");
    expect(compat(m).supportsReasoningEffort).toBeUndefined();
  });

  it("sets reasoning:true and together+supportsReasoningEffort for reasoning+reasoning_effort", () => {
    const m = mapModel(
      base({ tags: ["chat", "reasoning", "reasoning_effort"] }),
    );
    expect(m.reasoning).toBe(true);
    expect(compat(m).thinkingFormat).toBe("together");
    expect(compat(m).supportsReasoningEffort).toBe(true);
  });

  it("sets reasoning:true for reasoning_effort alone (Qwen3-Max case)", () => {
    const m = mapModel({
      id: "Qwen/Qwen3-Max",
      tags: ["chat", "prompt_cache", "reasoning_effort"],
      metadata: { context_length: 256000, max_tokens: 256000 },
    });
    expect(m.reasoning).toBe(true);
    expect(compat(m).thinkingFormat).toBe("qwen");
    expect(compat(m).supportsReasoningEffort).toBe(true);
    expect(compat(m).cacheControlFormat).toBe("anthropic");
    expect(m.maxTokens).toBe(65536);
  });

  it("maps deepseek-ai reasoning model to deepseek format", () => {
    const m = mapModel({
      id: "deepseek-ai/DeepSeek-R1",
      tags: ["chat", "reasoning"],
      metadata: { context_length: 163840, max_tokens: 163840 },
    });
    expect(compat(m).thinkingFormat).toBe("deepseek");
    expect(compat(m).supportsReasoningEffort).toBeUndefined();
  });

  it("maps zai-org model to zai format", () => {
    const m = mapModel(
      base({ id: "zai-org/glm-z1-32b", tags: ["chat", "reasoning"] }),
    );
    expect(compat(m).thinkingFormat).toBe("zai");
  });

  it("adds image input for vision/vlm models", () => {
    expect(mapModel(base({ tags: ["chat", "vision"] })).input).toEqual([
      "text",
      "image",
    ]);
    expect(mapModel(base({ tags: ["chat", "vlm"] })).input).toEqual([
      "text",
      "image",
    ]);
  });

  it("sets cacheControlFormat for prompt_cache models", () => {
    const m = mapModel(base({ tags: ["chat", "prompt_cache"] }));
    expect(compat(m).cacheControlFormat).toBe("anthropic");
  });

  it("always sets maxTokensField and supportsDeveloperRole", () => {
    const m = mapModel(base());
    expect(compat(m).maxTokensField).toBe("max_tokens");
    expect(compat(m).supportsDeveloperRole).toBe(false);
  });

  it("falls back gracefully when metadata is absent", () => {
    const m = mapModel({ id: "some-org/Bare" });
    expect(m.contextWindow).toBe(8192);
    expect(m.maxTokens).toBe(8192); // min(contextWindow, cap) — contextWindow wins here
    expect(m.cost).toEqual({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    });
  });
});

// ── OVERFLOW_RE ───────────────────────────────────────────────────────────────

describe("OVERFLOW_RE", () => {
  const matches = (s: string) => OVERFLOW_RE.test(s);

  it("matches DeepInfra context overflow phrasings", () => {
    expect(matches("maximum context length exceeded")).toBe(true);
    expect(matches("context length exceeded")).toBe(true);
    expect(matches("context window too long")).toBe(true);
    expect(matches("prompt is too long")).toBe(true);
    expect(matches("prompt too long")).toBe(true);
    expect(matches("input tokens exceed the limit")).toBe(true);
    expect(matches("context tokens exceed maximum")).toBe(true);
  });

  it("does not match quota / rate-limit errors", () => {
    expect(matches("monthly token limit exceeded")).toBe(false);
    expect(matches("rate limit exceeded")).toBe(false);
    expect(matches("daily limit exceeded")).toBe(false);
  });
});
