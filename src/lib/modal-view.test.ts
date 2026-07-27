import { describe, expect, it } from "vitest";
import { renderModalView } from "./modal-view.js";

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

function render(maxRows: number) {
  return renderModalView({
    theme,
    width: 40,
    maxRows,
    title: "Modal",
    status: { label: "running", kind: "running" },
    subtitle: "subtitle",
    contentLines: ["one", "two", "three"],
    scrollOffset: 0,
    footerControls: "esc: close",
  }).lines;
}

describe("renderModalView", () => {
  it("never renders more rows than maxRows", () => {
    for (let maxRows = 1; maxRows <= 10; maxRows++) {
      expect(render(maxRows).length).toBeLessThanOrEqual(maxRows);
    }
  });

  it("keeps normal modal chrome when there is enough room", () => {
    const lines = render(10);

    expect(lines[0]).toContain("╭");
    expect(lines.some((line) => line.includes("Modal"))).toBe(true);
    expect(lines.some((line) => line.includes("subtitle"))).toBe(true);
    expect(lines.some((line) => line.includes("esc: close"))).toBe(true);
    expect(lines.at(-1)).toContain("╰");
  });
});
