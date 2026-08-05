import type { Component } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { ScrollViewport } from "./scroll-viewport.js";

function content(lines: string[]): Component {
  return { render: () => lines, invalidate: () => {} };
}

describe("ScrollViewport", () => {
  it("scrolls and clamps across content and viewport changes", () => {
    const viewport = new ScrollViewport({
      content: content(["one", "two", "three", "four"]),
      viewportHeight: 2,
    });
    viewport.render(20);
    viewport.handleInput("\x1b[B");
    expect(viewport.render(20)).toEqual(["two", "three"]);

    viewport.setContent(content(["only"]));
    expect(viewport.render(20)).toEqual(["only"]);
    expect(viewport.offset).toBe(0);

    viewport.setContent(content(["one", "two", "three"]));
    viewport.setViewportHeight(3);
    expect(viewport.render(20)).toEqual(["one", "two", "three"]);
    viewport.handleInput("\x1b[H", { homeEnd: true });
    viewport.handleInput("\x1b[F", { homeEnd: true });
    expect(viewport.isAtBottom).toBe(true);
  });

  it("retains a manual position through replacement and follows the bottom until scrolled upward", () => {
    const viewport = new ScrollViewport({
      content: content(["one", "two", "three"]),
      viewportHeight: 2,
      followBottom: true,
    });
    expect(viewport.render(20)).toEqual(["two", "three"]);

    viewport.scrollUp();
    expect(viewport.render(20)).toEqual(["one", "two"]);
    viewport.setContent(content(["one", "two", "three", "four"]));
    expect(viewport.render(20)).toEqual(["one", "two"]);

    viewport.scrollDown();
    viewport.scrollDown();
    expect(viewport.isAtBottom).toBe(true);
    viewport.setContent(content(["one", "two", "three", "four", "five"]));
    expect(viewport.render(20)).toEqual(["four", "five"]);
  });
});
