import { describe, it, expect } from "vitest";
import {
  estimateTextBlockChars,
  estimateContentTokens,
  estimateMessageTextChars,
  estimateMessageTokens,
  estimateSuffixTokens,
} from "./tokens.js";

describe("estimateTextBlockChars", () => {
  it("counts string content directly", () => {
    expect(estimateTextBlockChars("hello world")).toBe(11);
  });

  it("ignores non-text blocks in block arrays", () => {
    expect(
      estimateTextBlockChars([
        { type: "text", text: "hello" },
        { type: "image", data: "abc" },
        { type: "text", text: " world" },
      ]),
    ).toBe(11);
  });

  it("returns 0 for unsupported types", () => {
    expect(estimateTextBlockChars(null)).toBe(0);
    expect(estimateTextBlockChars(42)).toBe(0);
    expect(estimateTextBlockChars({})).toBe(0);
  });
});

describe("estimateContentTokens", () => {
  it("rounds token estimates with Math.ceil(chars / 4)", () => {
    expect(estimateContentTokens("abc")).toBe(1);
    expect(estimateContentTokens("abcd")).toBe(1);
    expect(estimateContentTokens("abcde")).toBe(2);
  });

  it("returns 0 for empty content", () => {
    expect(estimateContentTokens([])).toBe(0);
    expect(estimateContentTokens("")).toBe(0);
  });
});

describe("estimateMessageTextChars", () => {
  it("counts text for user, assistant, and toolResult messages", () => {
    expect(estimateMessageTextChars({ role: "user", content: "hi" })).toBe(2);
    expect(estimateMessageTextChars({ role: "assistant", content: "ok" })).toBe(
      2,
    );
    expect(
      estimateMessageTextChars({
        role: "toolResult",
        content: [{ type: "text", text: "result" }],
      }),
    ).toBe(6);
  });

  it("returns zero for unsupported/unknown message roles", () => {
    expect(estimateMessageTextChars({ role: "system", content: "hi" })).toBe(0);
    expect(estimateMessageTextChars({ role: "unknown", content: "hi" })).toBe(
      0,
    );
    expect(estimateMessageTextChars({})).toBe(0);
  });
});

describe("estimateMessageTokens", () => {
  it("uses Math.ceil(chars / 4)", () => {
    expect(estimateMessageTokens({ role: "user", content: "abc" })).toBe(1);
    expect(estimateMessageTokens({ role: "user", content: "abcde" })).toBe(2);
  });

  it("returns 0 for unsupported roles", () => {
    expect(estimateMessageTokens({ role: "system", content: "hi" })).toBe(0);
  });
});

describe("estimateSuffixTokens", () => {
  it("counts user, assistant, and toolResult text blocks from afterIndex", () => {
    const messages = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "world" },
      { role: "user", content: "third" },
    ];
    expect(estimateSuffixTokens(messages, -1)).toBe(
      Math.ceil(("hello".length + "world".length + "third".length) / 4),
    );
    expect(estimateSuffixTokens(messages, 1)).toBe(
      Math.ceil("third".length / 4),
    );
    expect(estimateSuffixTokens(messages, 2)).toBe(0);
  });

  it("ignores non-text blocks within toolResult content", () => {
    const messages = [
      {
        role: "toolResult",
        content: [{ type: "image", data: "ignored" }],
      },
      { role: "user", content: "after" },
    ];
    expect(estimateSuffixTokens(messages, -1)).toBe(
      Math.ceil("after".length / 4),
    );
  });

  it("returns 0 when afterIndex is the last message", () => {
    const messages = [{ role: "user", content: "only" }];
    expect(estimateSuffixTokens(messages, 0)).toBe(0);
  });

  it("handles empty messages", () => {
    expect(estimateSuffixTokens([], 0)).toBe(0);
  });

  it("preserves suffix estimate behavior for mixed message types", () => {
    const messages = [
      { role: "user", content: "a" },
      { role: "toolResult", content: [{ type: "text", text: "bb" }] },
      { role: "assistant", content: "ccc" },
      { role: "toolResult", content: [{ type: "text", text: "dddd" }] },
    ];
    expect(estimateSuffixTokens(messages, 1)).toBe(
      Math.ceil(("ccc".length + "dddd".length) / 4),
    );
  });
});
