import { describe, it, expect } from "vitest";
import { parseModelRef } from "#lib/model-ref";
import { sanitizeTitle, buildTitlePrompt } from "./utils.js";

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

describe("sanitizeTitle", () => {
  it("normalizes model output into a single title", () => {
    expect(sanitizeTitle('Title: "hello   world."\nsecond line')).toBe(
      "hello world",
    );
    expect(sanitizeTitle("“hello world”")).toBe("hello world");
    expect(sanitizeTitle("`hello world`")).toBe("hello world");
  });

  it("rejects empty or boilerplate titles", () => {
    expect(sanitizeTitle("")).toBeNull();
    expect(sanitizeTitle("   \n   ")).toBeNull();
    expect(sanitizeTitle("Session Name:")).toBeNull();
    expect(sanitizeTitle("Session title")).toBeNull();
  });

  it("preserves complete titles without imposing a storage-length limit", () => {
    expect(
      sanitizeTitle("Implement Explicit MCP Evaluation Budgets and Routing"),
    ).toBe("Implement Explicit MCP Evaluation Budgets and Routing");
  });
});

describe("buildTitlePrompt", () => {
  it("passes the prompt text and basic title constraints to the model", () => {
    const result = buildTitlePrompt("Implement a red-black tree in Rust");

    expect(result.userText).toContain("Implement a red-black tree in Rust");
    expect(result.userText).toContain("usually 3–6 words");
    expect(result.userText).toContain("complete, natural phrase");
    expect(result.systemPrompt).toContain("No quotes");
  });

  it("formats multiple early prompts as title context", () => {
    const result = buildTitlePrompt([
      "Help me debug this",
      "The auto-name extension uses the second prompt",
    ]);

    expect(result.userText).toContain("early user prompts");
    expect(result.userText).toContain("Prompt 1:\nHelp me debug this");
    expect(result.userText).toContain(
      "Prompt 2:\nThe auto-name extension uses the second prompt",
    );
  });
});
