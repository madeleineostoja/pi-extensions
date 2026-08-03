import { describe, expect, it, vi } from "vitest";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { visibleWidth } from "@earendil-works/pi-tui";
import { BtwPanel } from "./panel.js";

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as Theme;

function panel(
  overrides: Partial<ConstructorParameters<typeof BtwPanel>[3]> = {},
) {
  const tui = {
    terminal: { rows: 24 },
    requestRender: vi.fn(),
  } as unknown as TUI;
  const abort = new AbortController();
  const done = vi.fn();
  return {
    abort,
    done,
    tui,
    value: new BtwPanel(
      tui,
      theme,
      done,
      {
        question: "What changed?",
        history: [],
        status: "pending",
        answerText: "",
        errorText: "",
        scrollOffset: 0,
        ...overrides,
      },
      abort,
      12,
    ),
  };
}

describe("BtwPanel", () => {
  it("uses a bounded Panel with distinct question and pending state", () => {
    const value = panel().value;
    const lines = value.render(30);

    expect(lines.some((line) => line.includes("/btw"))).toBe(true);
    expect(lines.some((line) => line.includes("Question"))).toBe(true);
    expect(lines.some((line) => line.includes("Status · thinking"))).toBe(true);
    expect(
      value.render(80).some((line) => line.includes("clear history")),
    ).toBe(false);
    expect(lines.every((line) => visibleWidth(line) <= 30)).toBe(true);
    expect(lines.join("\n")).not.toMatch(/[│╭╮╰╯]/u);
  });

  it("keeps retained history quiet and makes the answer dominant", () => {
    const value = panel({
      status: "answer",
      answerText: "Current answer",
      history: [{ question: "Earlier?", answer: "Earlier answer" }],
    }).value;
    const current = value.render(80);
    value.handleInput("\x1b[H");
    const history = value.render(80);

    expect(history.some((line) => line.includes("Earlier?"))).toBe(true);
    expect(history.some((line) => line.includes("Earlier answer"))).toBe(true);
    expect(current.some((line) => line.includes("Current answer"))).toBe(true);
  });

  it("scrolls retained history", () => {
    const value = panel({
      history: Array.from({ length: 8 }, (_, index) => ({
        question: `q${index}`,
        answer: `a${index}`,
      })),
    });

    expect(value.value.render(80).some((line) => line.includes("q0"))).toBe(
      false,
    );
    for (let index = 0; index < 20; index += 1) {
      value.value.handleInput("\x1b[A");
    }
    expect(value.value.render(80).some((line) => line.includes("q0"))).toBe(
      true,
    );
  });

  it("aborts pending work on close and ignores later state", () => {
    const value = panel();
    value.value.handleInput("\x1b");
    value.value.setState({ status: "answer", answerText: "stale" });

    expect(value.abort.signal.aborted).toBe(true);
    expect(value.done).toHaveBeenCalledOnce();
    expect(value.value.render(80).some((line) => line.includes("stale"))).toBe(
      false,
    );
  });
});
