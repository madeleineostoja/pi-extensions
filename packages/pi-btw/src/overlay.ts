import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import {
  Key,
  matchesKey,
  truncateToWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { BtwExchange } from "./state.js";

export type BtwOverlayState = {
  question: string;
  history: readonly BtwExchange[];
  status: "pending" | "answer" | "error";
  answerText: string;
  errorText: string;
  scrollOffset: number;
};

export class BtwOverlay implements Component {
  onClearHistory?: () => void;

  private lastWidth = 80;

  constructor(
    private tui: TUI,
    private theme: Theme,
    private done: () => void,
    public state: BtwOverlayState,
    private abortController: AbortController,
    private maxRows = Math.floor((tui.terminal.rows ?? 24) * 0.6),
  ) {}

  setState(patch: Partial<BtwOverlayState>): void {
    this.state = { ...this.state, ...patch };
    this.clampScrollOffset();
    this.tui.requestRender();
  }

  invalidate(): void {
    this.clampScrollOffset();
    this.tui.requestRender();
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      if (this.state.status === "pending") {
        this.abortController.abort();
      }
      this.done();
      return;
    }
    if (matchesKey(data, "x")) {
      this.state = { ...this.state, history: [], scrollOffset: 0 };
      this.onClearHistory?.();
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, Key.up)) {
      this.setState({ scrollOffset: this.state.scrollOffset + 1 });
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.setState({ scrollOffset: Math.max(0, this.state.scrollOffset - 1) });
      return;
    }
  }

  render(width: number): string[] {
    this.lastWidth = width;
    this.clampScrollOffset();
    const maxContentRows = this.getMaxContentRows();
    const title = `${this.theme.fg("accent", "/btw")} ${this.theme.bold(
      truncateToWidth(
        this.state.question,
        Math.max(0, width - 8),
        "...",
        false,
      ),
    )}`;
    const footer = this.theme.fg(
      "muted",
      "esc: dismiss | x: clear history | ↑/↓: scroll",
    );

    const contentLines = this.getContentLines(width);
    const maxScroll = Math.max(0, contentLines.length - maxContentRows);
    const start = Math.max(0, maxScroll - this.state.scrollOffset);
    const visible = contentLines.slice(start, start + maxContentRows);

    return [title, ...visible, footer];
  }

  private clampScrollOffset(): void {
    const maxScroll = Math.max(
      0,
      this.getContentLines(this.lastWidth).length - this.getMaxContentRows(),
    );
    this.state.scrollOffset = Math.min(this.state.scrollOffset, maxScroll);
  }

  private getMaxContentRows(): number {
    return Math.max(1, this.maxRows - 2);
  }

  private getContentLines(width: number): string[] {
    const contentLines: string[] = [];

    for (const ex of this.state.history) {
      const q = truncateToWidth(
        ex.question,
        Math.max(0, width - 4),
        "...",
        false,
      );
      const a = truncateToWidth(
        ex.answer,
        Math.max(0, width - 8),
        "...",
        false,
      );
      contentLines.push(this.theme.fg("dim", `Q: ${q}`));
      contentLines.push(this.theme.fg("muted", `  -> ${a}`));
    }

    if (this.state.status === "pending") {
      contentLines.push(this.theme.fg("accent", "Thinking..."));
    } else if (this.state.status === "answer") {
      contentLines.push(
        ...wrapTextWithAnsi(this.state.answerText, Math.max(1, width - 2)).map(
          (line) => ` ${line}`,
        ),
      );
    } else {
      contentLines.push(
        ...wrapTextWithAnsi(this.state.errorText, Math.max(1, width - 2)).map(
          (line) => this.theme.fg("error", ` ${line}`),
        ),
      );
    }

    return contentLines;
  }
}
