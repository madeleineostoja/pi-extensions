import type { Theme } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { toolResultRenderer } from "./tool-result-renderer.js";

const theme = {
  fg: (_color: string, text: string) => text,
} as Theme;

describe("toolResultRenderer", () => {
  it("keeps multi-line semantic summaries compact and every text block ordered when expanded", () => {
    const render = toolResultRenderer({
      summary: () => ["Completed query.", "Two providers responded."],
    });
    const result = {
      content: [
        { type: "text" as const, text: "first complete block" },
        { type: "image" as const, data: "image-data", mimeType: "image/png" },
        { type: "text" as const, text: "second complete block" },
      ],
    };

    const collapsed = render(
      result,
      { expanded: false, isPartial: false },
      theme,
      {},
    );
    const expanded = render(
      result,
      { expanded: true, isPartial: false },
      theme,
      {},
    );

    expect(
      collapsed
        .render(200)
        .map((line) => line.trimEnd())
        .join("\n"),
    ).toBe("Completed query.\nTwo providers responded.");
    expect(
      expanded
        .render(200)
        .map((line) => line.trimEnd())
        .join("\n"),
    ).toBe(
      "Completed query.\nTwo providers responded.\nfirst complete block\nsecond complete block",
    );
  });

  it("distinguishes partial and error summaries while preserving complete expanded error text", () => {
    const render = toolResultRenderer({
      summary: () => "Completed.",
      partial: () => "Still fetching…",
      error: () => "Request failed: retry later.",
    });
    const result = {
      content: [{ type: "text" as const, text: "full failure\ndiagnostics" }],
    };

    expect(
      render(result, { expanded: false, isPartial: true }, theme, {})
        .render(200)
        .map((line) => line.trimEnd())
        .join("\n"),
    ).toBe("Still fetching…");
    expect(
      render(result, { expanded: false, isPartial: false }, theme, {
        isError: true,
      })
        .render(200)
        .map((line) => line.trimEnd())
        .join("\n"),
    ).toBe("Request failed: retry later.");
    expect(
      render(result, { expanded: true, isPartial: false }, theme, {
        isError: true,
      })
        .render(200)
        .map((line) => line.trimEnd())
        .join("\n"),
    ).toContain("full failure\ndiagnostics");
  });
});
