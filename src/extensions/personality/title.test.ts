import { describe, it, expect } from "vitest";
import {
  buildImplementTitlePrompt,
  buildTitlePrompt,
  sanitizeTitle,
} from "./title.js";

describe("sanitizeTitle", () => {
  it("normalizes model output into a single title", () => {
    expect(sanitizeTitle('Title: "hello   world."\nsecond line')).toBe(
      "hello world",
    );
    expect(sanitizeTitle("\u201chello world\u201d")).toBe("hello world");
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
    expect(result.userText).toContain("usually 3\u20136 words");
    expect(result.userText).toContain("complete, natural phrase");
    expect(result.userText).toContain("dangling conjunction or preposition");
    expect(result.userText).toContain("current request is authoritative");
    expect(result.userText).toContain("incidental Git state");
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

  it("requires an Implement-prefixed title for active runs", () => {
    const result = buildImplementTitlePrompt(
      "# Managed processes\n\n- [ ] Add tests",
    );

    expect(result.systemPrompt).toContain("active Pipkin Implement run");
    expect(result.systemPrompt).toContain("beginning with Implement");
    expect(result.userText).toContain("# Managed processes");
    expect(result.userText).toContain(
      "usually 3\u20136 words after \u201cImplement\u201d",
    );
    expect(result.userText).toContain("complete, natural phrase");
    expect(result.userText).toContain("root plan excerpt is authoritative");
    expect(result.userText).toContain("Git activity alone never justifies it");
  });
});
