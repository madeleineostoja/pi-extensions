import { describe, it, expect } from "vitest";
import { parseModelRef, isModelRef } from "./model-ref.js";

describe("parseModelRef", () => {
  it("splits provider/model refs at the first slash", () => {
    expect(parseModelRef("openrouter/openai/gpt-oss-20b")).toEqual({
      provider: "openrouter",
      id: "openai/gpt-oss-20b",
    });
    expect(parseModelRef("openai/gpt-4.1-nano")).toEqual({
      provider: "openai",
      id: "gpt-4.1-nano",
    });
  });

  it("rejects refs without both provider and model", () => {
    expect(parseModelRef("gpt-4")).toBeNull();
    expect(parseModelRef("/gpt-4")).toBeNull();
    expect(parseModelRef("openai/")).toBeNull();
  });
});

describe("isModelRef", () => {
  it("accepts valid provider/model refs", () => {
    expect(isModelRef("openai/gpt-4.1-nano")).toBe(true);
    expect(isModelRef("openrouter/openai/gpt-oss-20b")).toBe(true);
  });

  it("rejects refs without a slash", () => {
    expect(isModelRef("gpt-4")).toBe(false);
  });

  it("rejects refs starting with slash or whitespace", () => {
    expect(isModelRef("/gpt-4")).toBe(false);
    expect(isModelRef(" openai/gpt-4")).toBe(false);
  });

  it("rejects refs ending in whitespace", () => {
    expect(isModelRef("openai/gpt-4 ")).toBe(false);
  });

  it("rejects empty provider or model", () => {
    expect(isModelRef("openai/")).toBe(false);
    expect(isModelRef("/")).toBe(false);
  });
});
