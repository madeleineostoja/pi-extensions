import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import {
  matchesKey,
  truncateToWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { Panel } from "#lib/ui/panel";
import type { BtwExchange } from "./state.js";

export type BtwPanelState = {
  question: string;
  history: readonly BtwExchange[];
  status: "pending" | "answer" | "error";
  answerText: string;
  errorText: string;
  scrollOffset: number;
};

class BtwContent implements Component {
  constructor(private readonly owner: BtwPanel) {}

  render(width: number): string[] {
    const lines = this.owner.contentLines(width);
    const maxRows = this.owner.contentRows();
    const maxScroll = Math.max(0, lines.length - maxRows);
    const offset = Math.min(this.owner.state.scrollOffset, maxScroll);
    this.owner.state.scrollOffset = offset;
    const start = Math.max(0, lines.length - maxRows - offset);
    return lines.slice(start, start + maxRows);
  }

  invalidate(): void {}
}

export class BtwPanel implements Component {
  onClearHistory?: () => void;

  private readonly panel: Panel;
  private closed = false;
  private lastWidth = 80;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly done: () => void,
    public state: BtwPanelState,
    private readonly abortController: AbortController,
    private readonly maxRows = Math.max(
      6,
      Math.floor((tui.terminal.rows ?? 24) * 0.6),
    ),
  ) {
    this.panel = new Panel({
      theme,
      title: "/btw",
      child: new BtwContent(this),
      footer: "esc/q abort or close · x clear history · ↑↓/Pg/Home/End scroll",
    });
  }

  setState(patch: Partial<BtwPanelState>): void {
    if (this.closed) {
      return;
    }
    this.state = { ...this.state, ...patch };
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
    if (!this.closed) {
      this.closed = true;
      if (this.state.status === "pending") {
        this.abortController.abort();
      }
    }
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "q")) {
      this.close();
      return;
    }
    if (matchesKey(data, "x")) {
      this.state = { ...this.state, history: [], scrollOffset: 0 };
      this.onClearHistory?.();
      this.tui.requestRender();
      return;
    }
    const maxScroll = Math.max(
      0,
      this.contentLines(this.contentWidth(this.lastWidth)).length -
        this.contentRows(),
    );
    const page = this.contentRows();
    let next: number | undefined;
    if (matchesKey(data, "up") || matchesKey(data, "k")) {
      next = this.state.scrollOffset + 1;
    } else if (matchesKey(data, "down") || matchesKey(data, "j")) {
      next = this.state.scrollOffset - 1;
    } else if (matchesKey(data, "pageUp")) {
      next = this.state.scrollOffset + page;
    } else if (matchesKey(data, "pageDown")) {
      next = this.state.scrollOffset - page;
    } else if (matchesKey(data, "home")) {
      next = maxScroll;
    } else if (matchesKey(data, "end")) {
      next = 0;
    }
    if (next !== undefined) {
      this.state.scrollOffset = Math.max(0, Math.min(next, maxScroll));
      this.tui.requestRender();
    }
  }

  render(width: number): string[] {
    this.lastWidth = width;
    const lines = this.panel.render(width);
    return lines.slice(0, this.maxRows);
  }

  invalidate(): void {
    this.panel.invalidate();
  }

  contentRows(): number {
    return Math.max(1, this.maxRows - 5);
  }

  contentLines(width: number): string[] {
    const lines: string[] = [];
    if (this.state.history.length) {
      lines.push(this.theme.fg("dim", "Previous exchanges"));
      for (const exchange of this.state.history) {
        lines.push(...this.wrap(`Q  ${exchange.question}`, width, "dim"));
        lines.push(...this.wrap(`A  ${exchange.answer}`, width, "muted"));
      }
      lines.push("");
    }
    lines.push(this.theme.fg("accent", "Question"));
    lines.push(...this.wrap(this.state.question, width));
    lines.push("");
    if (this.state.status === "pending") {
      lines.push(this.theme.fg("accent", "Status · thinking…"));
    } else if (this.state.status === "answer") {
      lines.push(this.theme.bold("Answer"));
      lines.push(...this.wrap(this.state.answerText, width));
    } else {
      lines.push(this.theme.fg("error", "Error"));
      lines.push(...this.wrap(this.state.errorText, width, "error"));
    }
    return lines;
  }

  private contentWidth(width: number): number {
    return Math.max(1, width - 1);
  }

  private wrap(
    text: string,
    width: number,
    color?: "dim" | "muted" | "error",
  ): string[] {
    return wrapTextWithAnsi(text.trim(), Math.max(1, width)).map((line) =>
      truncateToWidth(color ? this.theme.fg(color, line) : line, width),
    );
  }
}
