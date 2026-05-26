import { describe, it, expect } from "vitest";
import { parseModelRef, sanitizeTitle, buildTitlePrompt } from "./utils.js";

describe("parseModelRef", () => {
  it("splits on the first slash for openrouter nested ids", () => {
    const result = parseModelRef("openrouter/openai/gpt-oss-120b");
    expect(result).toEqual({
      provider: "openrouter",
      id: "openai/gpt-oss-120b",
    });
  });

  it("handles simple provider/model ids", () => {
    const result = parseModelRef("openai/gpt-4.1-nano");
    expect(result).toEqual({ provider: "openai", id: "gpt-4.1-nano" });
  });

  it("returns null for refs without a slash", () => {
    expect(parseModelRef("gpt-4")).toBeNull();
  });

  it("returns null for refs starting with a slash", () => {
    expect(parseModelRef("/gpt-4")).toBeNull();
  });

  it("returns null for refs ending with a slash", () => {
    expect(parseModelRef("openai/")).toBeNull();
  });
});

describe("sanitizeTitle", () => {
  it("trims quotes and backticks", () => {
    expect(sanitizeTitle('"hello world"')).toBe("hello world");
    expect(sanitizeTitle("`hello world`")).toBe("hello world");
    expect(sanitizeTitle("'hello world'")).toBe("hello world");
  });

  it("collapses whitespace", () => {
    expect(sanitizeTitle("hello   world")).toBe("hello world");
    expect(sanitizeTitle("  hello world  ")).toBe("hello world");
  });

  it("uses only the first non-empty line", () => {
    expect(sanitizeTitle("\n\nfirst line\nsecond line")).toBe("first line");
  });

  it("removes trailing punctuation", () => {
    expect(sanitizeTitle("hello world.")).toBe("hello world");
    expect(sanitizeTitle("hello world!")).toBe("hello world");
    expect(sanitizeTitle("hello world?")).toBe("hello world");
    expect(sanitizeTitle("hello world,")).toBe("hello world");
  });

  it("rejects empty output", () => {
    expect(sanitizeTitle("")).toBeNull();
    expect(sanitizeTitle("   \n   ")).toBeNull();
  });

  it("rejects boilerplate", () => {
    expect(sanitizeTitle("Session Name:")).toBeNull();
    expect(sanitizeTitle("Session title")).toBeNull();
  });

  it("truncates titles over 40 characters on a word boundary", () => {
    expect(sanitizeTitle("a".repeat(40))).toBe("a".repeat(40));
    expect(
      sanitizeTitle("Implement a red black tree data structure in Rust"),
    ).toBe("Implement a red black tree data");
  });

  it("hard-truncates when no word boundary is available", () => {
    expect(sanitizeTitle("a".repeat(60))).toBe("a".repeat(40));
  });

  it("strips smart quotes", () => {
    expect(sanitizeTitle("“hello world”")).toBe("hello world");
    expect(sanitizeTitle("‘hello world’")).toBe("hello world");
  });

  it("strips leading label prefixes", () => {
    expect(sanitizeTitle("Title: hello world")).toBe("hello world");
    expect(sanitizeTitle("Name: hello world")).toBe("hello world");
    expect(sanitizeTitle("Session name: hello world")).toBe("hello world");
    expect(sanitizeTitle('Title: "hello world"')).toBe("hello world");
  });
});

describe("buildTitlePrompt", () => {
  it("includes the first prompt text", () => {
    const result = buildTitlePrompt("Implement a red-black tree in Rust");
    expect(result.userText).toContain("Implement a red-black tree in Rust");
    expect(result.systemPrompt.length).toBeGreaterThan(0);
  });

  it("asks for 3–6 words and max 40 characters", () => {
    const result = buildTitlePrompt("any prompt");
    expect(result.userText).toContain("3–6 words");
    expect(result.userText).toContain("max 40 characters");
  });

  it("requests no quotes and no trailing punctuation", () => {
    const result = buildTitlePrompt("any prompt");
    expect(result.systemPrompt).toContain("No quotes");
    expect(result.systemPrompt).toContain("no punctuation at the end");
  });
});
