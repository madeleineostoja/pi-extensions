import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { matchesKey, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import {
  isModalCloseInput,
  nextModalScrollOffset,
  renderModalView,
} from "@pi-extensions/lib";
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
  private closed = false;

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

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    if (this.state.status === "pending") {
      this.abortController.abort();
    }
    this.done();
  }

  dispose(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    if (this.state.status === "pending") {
      this.abortController.abort();
    }
  }

  handleInput(data: string): void {
    if (isModalCloseInput(data) || matchesKey(data, "q")) {
      this.close();
      return;
    }
    if (matchesKey(data, "x")) {
      this.state = { ...this.state, history: [], scrollOffset: 0 };
      this.onClearHistory?.();
      this.tui.requestRender();
      return;
    }

    const contentLines = this.getContentLines(
      this.contentWidth(this.lastWidth),
    );
    const maxScroll = Math.max(0, contentLines.length - this.getContentRows());
    const nextScroll = nextModalScrollOffset(
      data,
      this.state.scrollOffset,
      maxScroll,
      this.getContentRows(),
    );
    if (nextScroll !== undefined) {
      this.setState({ scrollOffset: nextScroll });
      return;
    }
  }

  render(width: number): string[] {
    this.lastWidth = width;
    this.clampScrollOffset();
    const contentLines = this.getContentLines(this.contentWidth(width));
    const rendered = renderModalView({
      theme: this.theme,
      width,
      maxRows: this.maxRows,
      title: "/btw",
      status: this.status(),
      subtitle: this.state.question,
      contentLines,
      scrollOffset: this.state.scrollOffset,
      footerControls: this.footerControls(),
    });
    this.state.scrollOffset = rendered.scrollOffset;
    return rendered.lines;
  }

  private status() {
    if (this.state.status === "pending") {
      return { label: "thinking", kind: "pending" as const };
    }
    if (this.state.status === "answer") {
      return { label: "answer", kind: "completed" as const };
    }
    return { label: "error", kind: "failed" as const };
  }

  private footerControls(): string {
    const close =
      this.state.status === "pending" ? "esc/q: abort" : "esc/q: close";
    return `${close} · x: clear history · ↑↓/kj scroll · Pg/Home/End`;
  }

  private clampScrollOffset(): void {
    const maxScroll = Math.max(
      0,
      this.getContentLines(this.contentWidth(this.lastWidth)).length -
        this.getContentRows(),
    );
    this.state.scrollOffset = Math.min(this.state.scrollOffset, maxScroll);
  }

  private getContentRows(): number {
    return Math.max(1, this.maxRows - 7);
  }

  private contentWidth(width: number): number {
    return Math.max(1, width - 4);
  }

  private getContentLines(width: number): string[] {
    const contentLines: string[] = [];

    for (const ex of this.state.history) {
      contentLines.push(...this.wrap(`Q: ${ex.question}`, width, "dim"));
      contentLines.push(...this.wrap(`  → ${ex.answer}`, width, "muted"));
    }

    contentLines.push(this.theme.fg("accent", "[Question]"));
    contentLines.push(...this.wrap(this.state.question, width));

    if (this.state.status === "pending") {
      contentLines.push("", this.theme.fg("accent", "Thinking..."));
    } else if (this.state.status === "answer") {
      contentLines.push("", this.theme.bold("[Answer]"));
      contentLines.push(...this.wrap(this.state.answerText, width));
    } else {
      contentLines.push("", this.theme.fg("error", "[Error]"));
      contentLines.push(...this.wrap(this.state.errorText, width, "error"));
    }

    return contentLines;
  }

  private wrap(
    text: string,
    width: number,
    color?: "dim" | "muted" | "error",
  ): string[] {
    return wrapTextWithAnsi(text.trim(), Math.max(1, width)).map((line) =>
      color ? this.theme.fg(color, line) : line,
    );
  }
}
