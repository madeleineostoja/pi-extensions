import { describe, it, expect } from "vitest";
import { parseModelRef, sanitizeTitle, buildTitlePrompt } from "./utils.js";

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

  it("caps titles at 40 characters", () => {
    expect(sanitizeTitle("a".repeat(40))).toBe("a".repeat(40));
    expect(
      sanitizeTitle("Implement a red black tree data structure in Rust"),
    ).toBe("Implement a red black tree data");
    expect(sanitizeTitle("a".repeat(60))).toBe("a".repeat(40));
  });
});

describe("buildTitlePrompt", () => {
  it("passes the prompt text and basic title constraints to the model", () => {
    const result = buildTitlePrompt("Implement a red-black tree in Rust");

    expect(result.userText).toContain("Implement a red-black tree in Rust");
    expect(result.userText).toContain("3–6 words");
    expect(result.userText).toContain("max 40 characters");
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
