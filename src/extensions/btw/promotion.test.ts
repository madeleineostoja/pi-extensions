import { beforeAll, describe, expect, it } from "vitest";
import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { promotedBtwMessage, renderBtwMessage } from "./promotion.js";

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as Theme;

beforeAll(() => initTheme("dark", false));

describe("BTW promotion", () => {
  it("keeps the complete exchange in model-facing content and only bounded display data in details", () => {
    const message = promotedBtwMessage({
      question: "question ".repeat(100),
      answer: "**complete answer**",
    });

    expect(message.content).toContain(
      "Completed /btw side exchange promoted as context.",
    );
    expect(message.content).toContain("Question:");
    expect(message.content).toContain("Answer:");
    expect(message.content).toContain("**complete answer**");
    expect(message.content).not.toMatch(/continue|answer again/i);
    expect(message.details.question.length).toBeLessThan(
      message.content.length,
    );
  });

  it("renders a semantic collapsed message and complete expanded Markdown sections", () => {
    const message = promotedBtwMessage({
      question: "What is FastAPI?",
      answer: "**A web framework**",
    });
    const transcript = { ...message, role: "custom" as const, timestamp: 0 };
    const collapsed = renderBtwMessage(transcript, { expanded: false }, theme);
    const expanded = renderBtwMessage(transcript, { expanded: true }, theme);

    expect(collapsed?.render(80).join("\n")).toContain(
      "Promoted side question: What is FastAPI?",
    );
    const lines = expanded?.render(80).join("\n") ?? "";
    expect(lines).toContain("Question");
    expect(lines).toContain("What is FastAPI?");
    expect(lines).toContain("Answer");
    expect(lines).toContain("A web framework");
  });

  it("preserves a question containing the Answer delimiter when expanded", () => {
    const message = promotedBtwMessage({
      question: "Explain this template:\n\nAnswer:\nplaceholder",
      answer: "real answer",
    });
    const transcript = { ...message, role: "custom" as const, timestamp: 0 };
    const lines = (
      renderBtwMessage(transcript, { expanded: true }, theme)?.render(80) ?? []
    )
      .map((line) => line.trimEnd())
      .join("\n");

    expect(lines).toContain(
      "Question\nExplain this template:\n\nAnswer:\nplaceholder\nAnswer\nreal answer",
    );
  });
});
