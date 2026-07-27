import { describe, expect, it, vi } from "vitest";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { BtwOverlay } from "./overlay.js";
import type { BtwExchange } from "./state.js";

function makeTheme(): Theme {
  return {
    fg: (color: string, text: string) => `[${color}]${text}[/${color}]`,
    bg: (_color: string, text: string) => text,
    bold: (text: string) => `**${text}**`,
    italic: (text: string) => `_${text}_`,
    underline: (text: string) => `__${text}__`,
    inverse: (text: string) => text,
    strikethrough: (text: string) => text,
    getFgAnsi: (_color: string) => "",
    getBgAnsi: (_color: string) => "",
    getColorMode: () => "truecolor",
    getThinkingBorderColor: () => (text: string) => text,
    getBashModeBorderColor: () => (text: string) => text,
  } as unknown as Theme;
}

function makeTui(rows = 24) {
  return {
    terminal: { rows },
    requestRender: vi.fn(),
  } as unknown as TUI;
}

function makeState(
  overrides: Partial<{
    question: string;
    history: BtwExchange[];
    status: "pending" | "answer" | "error";
    answerText: string;
    errorText: string;
    scrollOffset: number;
  }> = {},
) {
  return {
    question: "what is this?",
    history: [],
    status: "pending" as const,
    answerText: "",
    errorText: "",
    scrollOffset: 0,
    ...overrides,
  };
}

describe("BtwOverlay", () => {
  it("renders pending state with title and footer", () => {
    const tui = makeTui(40);
    const overlay = new BtwOverlay(
      tui,
      makeTheme(),
      vi.fn(),
      makeState(),
      new AbortController(),
      24,
    );

    const lines = overlay.render(80);

    expect(lines.some((line) => line.includes("/btw"))).toBe(true);
    expect(lines.some((line) => line.includes("what is this?"))).toBe(true);
    expect(lines.some((line) => line.includes("Thinking..."))).toBe(true);
    expect(lines.some((line) => line.includes("esc/q: abort"))).toBe(true);
    expect(lines.length).toBeLessThanOrEqual(24);
  });

  it("renders answer state", () => {
    const overlay = new BtwOverlay(
      makeTui(40),
      makeTheme(),
      vi.fn(),
      makeState({ status: "answer", answerText: "This is the answer." }),
      new AbortController(),
      24,
    );

    const lines = overlay.render(80);

    expect(lines.some((line) => line.includes("This is the answer."))).toBe(
      true,
    );
    expect(lines.length).toBeLessThanOrEqual(24);
  });

  it("renders error state", () => {
    const overlay = new BtwOverlay(
      makeTui(40),
      makeTheme(),
      vi.fn(),
      makeState({ status: "error", errorText: "model error" }),
      new AbortController(),
      24,
    );

    const lines = overlay.render(80);

    expect(lines.some((line) => line.includes("model error"))).toBe(true);
    expect(lines.length).toBeLessThanOrEqual(24);
  });

  it("shows dimmed earlier entries when history exists", () => {
    const history: BtwExchange[] = [{ question: "previous?", answer: "Yes." }];
    const overlay = new BtwOverlay(
      makeTui(40),
      makeTheme(),
      vi.fn(),
      makeState({ history, status: "answer", answerText: "Current answer." }),
      new AbortController(),
      24,
    );

    const lines = overlay.render(80);

    expect(
      lines.some(
        (line) => line.includes("[dim]") && line.includes("previous?"),
      ),
    ).toBe(true);
    expect(
      lines.some((line) => line.includes("[muted]") && line.includes("Yes.")),
    ).toBe(true);
    expect(lines.some((line) => line.includes("Current answer."))).toBe(true);
  });

  it("esc dismisses and aborts pending request", () => {
    const done = vi.fn();
    const abort = new AbortController();
    const overlay = new BtwOverlay(
      makeTui(40),
      makeTheme(),
      done,
      makeState(),
      abort,
      24,
    );

    overlay.handleInput("\x1B");

    expect(abort.signal.aborted).toBe(true);
    expect(done).toHaveBeenCalled();
  });

  it("esc dismisses without aborting after completion", () => {
    const done = vi.fn();
    const abort = new AbortController();
    const overlay = new BtwOverlay(
      makeTui(40),
      makeTheme(),
      done,
      makeState({ status: "answer", answerText: "done" }),
      abort,
      24,
    );

    overlay.handleInput("\x1B");

    expect(abort.signal.aborted).toBe(false);
    expect(done).toHaveBeenCalled();
  });

  it("esc dismisses without aborting after error", () => {
    const done = vi.fn();
    const abort = new AbortController();
    const overlay = new BtwOverlay(
      makeTui(40),
      makeTheme(),
      done,
      makeState({ status: "error", errorText: "failed" }),
      abort,
      24,
    );

    overlay.handleInput("\x1B");

    expect(abort.signal.aborted).toBe(false);
    expect(done).toHaveBeenCalled();
  });

  it("x clears earlier history and rerenders without entries", () => {
    const tui = makeTui(40);
    const history: BtwExchange[] = [{ question: "previous?", answer: "Yes." }];
    const overlay = new BtwOverlay(
      tui,
      makeTheme(),
      vi.fn(),
      makeState({ history }),
      new AbortController(),
      24,
    );
    const onClearHistory = vi.fn();
    overlay.onClearHistory = onClearHistory;

    expect(overlay.render(80).some((line) => line.includes("previous?"))).toBe(
      true,
    );

    overlay.handleInput("x");

    expect(onClearHistory).toHaveBeenCalled();
    expect(overlay.render(80).some((line) => line.includes("previous?"))).toBe(
      false,
    );
    expect(tui.requestRender).toHaveBeenCalled();
  });

  it("x clears history with Kitty CSI-u input", () => {
    const tui = makeTui(40);
    const history: BtwExchange[] = [{ question: "previous?", answer: "Yes." }];
    const overlay = new BtwOverlay(
      tui,
      makeTheme(),
      vi.fn(),
      makeState({ history }),
      new AbortController(),
      24,
    );
    const onClearHistory = vi.fn();
    overlay.onClearHistory = onClearHistory;

    expect(overlay.render(80).some((line) => line.includes("previous?"))).toBe(
      true,
    );

    overlay.handleInput("\u001b[120u");

    expect(onClearHistory).toHaveBeenCalled();
    expect(overlay.render(80).some((line) => line.includes("previous?"))).toBe(
      false,
    );
    expect(tui.requestRender).toHaveBeenCalled();
  });

  it("default view keeps current exchange visible when history overflows", () => {
    const history: BtwExchange[] = Array.from({ length: 10 }, (_, i) => ({
      question: `q${i}`,
      answer: `a${i}`,
    }));
    const overlay = new BtwOverlay(
      makeTui(40),
      makeTheme(),
      vi.fn(),
      makeState({ history, status: "answer", answerText: "final answer" }),
      new AbortController(),
      10,
    );

    const lines = overlay.render(80);

    expect(lines.some((line) => line.includes("final answer"))).toBe(true);
    expect(lines.some((line) => line.includes("q0"))).toBe(false);
    expect(lines.length).toBeLessThanOrEqual(10);
  });

  it("arrow scrolling reveals earlier history and returns to current exchange", () => {
    const history: BtwExchange[] = Array.from({ length: 4 }, (_, i) => ({
      question: `q${i}`,
      answer: `a${i}`,
    }));
    const overlay = new BtwOverlay(
      makeTui(40),
      makeTheme(),
      vi.fn(),
      makeState({ history, status: "answer", answerText: "final answer" }),
      new AbortController(),
      10,
    );

    const initial = overlay.render(80);
    expect(initial.some((line) => line.includes("final answer"))).toBe(true);
    expect(initial.some((line) => line.includes("q0"))).toBe(false);

    for (let i = 0; i < 20; i++) {
      overlay.handleInput("\x1B[A");
    }
    const scrolledUp = overlay.render(80);
    expect(scrolledUp.some((line) => line.includes("q0"))).toBe(true);
    expect(scrolledUp).not.toEqual(initial);

    for (let i = 0; i < 20; i++) {
      overlay.handleInput("\x1B[B");
    }
    const scrolledDown = overlay.render(80);
    expect(scrolledDown.some((line) => line.includes("final answer"))).toBe(
      true,
    );
  });

  it("clamps scroll offset to the actual max scroll range", () => {
    const history: BtwExchange[] = Array.from({ length: 2 }, (_, i) => ({
      question: `q${i}`,
      answer: `a${i}`,
    }));
    const overlay = new BtwOverlay(
      makeTui(40),
      makeTheme(),
      vi.fn(),
      makeState({ history, status: "answer", answerText: "final answer" }),
      new AbortController(),
      6,
    );

    overlay.render(80);
    for (let i = 0; i < 10; i++) {
      overlay.handleInput("\x1B[A");
    }

    expect(overlay.state.scrollOffset).toBe(8);

    for (let i = 0; i < 10; i++) {
      overlay.handleInput("\x1B[B");
    }

    expect(overlay.state.scrollOffset).toBe(0);
  });

  it("does not exceed maxRows when content is short", () => {
    const overlay = new BtwOverlay(
      makeTui(40),
      makeTheme(),
      vi.fn(),
      makeState(),
      new AbortController(),
      10,
    );

    const lines = overlay.render(80);

    expect(lines.length).toBeLessThanOrEqual(10);
    expect(lines.some((line) => line.includes("esc/q: abort"))).toBe(true);
  });

  it("default maxRows respects 60% of terminal rows", () => {
    const overlay = new BtwOverlay(
      makeTui(40),
      makeTheme(),
      vi.fn(),
      makeState(),
      new AbortController(),
    );

    const lines = overlay.render(80);

    expect(lines.length).toBeLessThanOrEqual(24);
  });
});
