import { getMarkdownTheme, type Theme } from "@earendil-works/pi-coding-agent";
import {
  Markdown,
  matchesKey,
  type Component,
  type TUI,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { Panel } from "#lib/ui/panel";
import { ScrollViewport } from "#lib/ui/scroll-viewport";
import type { BtwPromotion } from "./promotion.js";

export type BtwPanelState = {
  question: string;
  status: "pending" | "answer" | "error";
  answerText: string;
  errorText: string;
};

class BtwBody implements Component {
  constructor(
    private readonly state: BtwPanelState,
    private readonly theme: Theme,
  ) {}

  render(width: number): string[] {
    const questionWidth = Math.max(1, width - 2);
    const question = wrapTextWithAnsi(
      this.state.question.trim(),
      questionWidth,
    ).map((line) => this.theme.fg("muted", `│ ${line}`));
    const lines = [...question, ""];
    if (this.state.status === "pending") {
      return [...lines, this.theme.fg("muted", "Thinking…")];
    }
    if (this.state.status === "error") {
      return [
        ...lines,
        ...wrapTextWithAnsi(this.state.errorText, Math.max(1, width)).map(
          (line) => this.theme.fg("error", line),
        ),
      ];
    }
    return [
      ...lines,
      ...new Markdown(this.state.answerText, 0, 0, getMarkdownTheme()).render(
        width,
      ),
    ];
  }

  invalidate(): void {}
}

class BtwContent implements Component {
  constructor(private readonly owner: BtwPanel) {}

  render(width: number): string[] {
    return [
      ...this.owner.scroll.render(width),
      this.owner.theme.fg(
        "dim",
        this.owner.state.status === "pending"
          ? "esc abort"
          : this.owner.state.status === "answer"
            ? "s send to session · esc close"
            : "esc close",
      ),
    ];
  }

  invalidate(): void {
    this.owner.scroll.invalidate();
  }
}

export class BtwPanel implements Component {
  readonly scroll: ScrollViewport;
  private readonly panel: Panel;
  private closed = false;
  private promoted = false;

  constructor(
    private readonly tui: TUI,
    readonly theme: Theme,
    private readonly done: () => void,
    public state: BtwPanelState,
    private readonly abortController: AbortController,
    private readonly promote: (exchange: BtwPromotion) => void,
    maxRows = Math.max(6, Math.floor((tui.terminal.rows ?? 24) * 0.6)),
  ) {
    const contentRows = Math.max(1, maxRows - 4);
    this.scroll = new ScrollViewport({
      content: new BtwBody(state, theme),
      viewportHeight: contentRows,
      followBottom: true,
    });
    this.panel = new Panel({
      theme,
      title: "/btw",
      child: new BtwContent(this),
    });
  }

  setState(patch: Partial<BtwPanelState>): void {
    if (this.closed) {
      return;
    }
    this.state = { ...this.state, ...patch };
    this.scroll.setContent(new BtwBody(this.state, this.theme));
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
    this.close();
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape")) {
      this.close();
      return;
    }
    if (this.state.status === "answer" && data === "s") {
      if (this.promoted) {
        return;
      }
      this.promoted = true;
      this.promote({
        question: this.state.question,
        answer: this.state.answerText,
      });
      this.close();
      return;
    }
    if (matchesKey(data, "up") || matchesKey(data, "down")) {
      this.scroll.handleInput(data);
      this.tui.requestRender();
    }
  }

  render(width: number): string[] {
    return this.panel.render(width);
  }

  invalidate(): void {
    this.panel.invalidate();
  }
}
