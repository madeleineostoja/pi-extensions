import { beforeAll, describe, expect, it, vi } from "vitest";
import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
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
  const promote = vi.fn();
  return {
    abort,
    done,
    promote,
    tui,
    value: new BtwPanel(
      tui,
      theme,
      done,
      {
        question: "What changed?",
        status: "pending",
        answerText: "",
        errorText: "",
        ...overrides,
      },
      abort,
      promote,
      12,
    ),
  };
}

beforeAll(() => initTheme("dark", false));

describe("BtwPanel", () => {
  it("renders a wrapped muted quote question and pending state", () => {
    const value = panel({
      question: "What changed in this very long implementation today?",
    }).value;
    const lines = value.render(20);

    expect(lines.some((line) => line.includes("/btw"))).toBe(true);
    expect(lines.filter((line) => line.includes("│")).length).toBeGreaterThan(
      1,
    );
    expect(lines.some((line) => line.includes("Thinking"))).toBe(true);
    expect(lines.every((line) => visibleWidth(line) <= 20)).toBe(true);
  });

  it("renders Markdown answers in a shared scroll view", () => {
    const answer = Array.from(
      { length: 20 },
      (_, index) => `- **line ${index}**`,
    ).join("\n");
    const value = panel({ status: "answer", answerText: answer }).value;

    expect(value.render(40).some((line) => line.includes("line 19"))).toBe(
      true,
    );
    for (let index = 0; index < 20; index += 1) {
      value.handleInput("\x1b[A");
    }
    expect(value.render(40).some((line) => line.includes("line 0"))).toBe(true);
  });

  it("promotes a completed exchange once and closes the panel", () => {
    const fixture = panel({ status: "answer", answerText: "**Answer**" });

    fixture.value.handleInput("s");
    fixture.value.handleInput("s");

    expect(fixture.promote).toHaveBeenCalledOnce();
    expect(fixture.promote).toHaveBeenCalledWith({
      question: "What changed?",
      answer: "**Answer**",
    });
    expect(fixture.done).toHaveBeenCalledOnce();
  });

  it("aborts pending work on close and ignores late state", () => {
    const fixture = panel();
    fixture.value.handleInput("\x1b");
    fixture.value.setState({ status: "answer", answerText: "stale" });

    expect(fixture.abort.signal.aborted).toBe(true);
    expect(fixture.done).toHaveBeenCalledOnce();
    expect(
      fixture.value.render(80).some((line) => line.includes("stale")),
    ).toBe(false);
  });
});
