import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { Panel } from "./panel.js";

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as Theme;

describe("Panel", () => {
  it("composes bounded chrome around an arbitrary child", () => {
    const child: Component = {
      invalidate: () => {},
      render: (width) => [truncateToWidth("interactive child", width)],
      handleInput: () => {},
    };
    const panel = new Panel({
      theme,
      title: "a title that is too long for this width",
      subtitle: "status",
      footer: "footer",
      child,
    });

    const lines = panel.render(12);

    expect(lines).toHaveLength(6);
    expect(lines[0]).toBe("─".repeat(12));
    expect(lines.at(-1)).toBe("─".repeat(12));
    expect(lines.join("\n")).not.toMatch(/[│╭╮╰╯]/u);
    expect(lines.every((line) => visibleWidth(line) <= 12)).toBe(true);
    expect((panel as Component).handleInput).toBeUndefined();
    expect(panel.render(1).every((line) => visibleWidth(line) <= 1)).toBe(true);
  });
});
