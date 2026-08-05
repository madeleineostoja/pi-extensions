import {
  getMarkdownTheme,
  keyHint,
  rawKeyHint,
  type KeybindingsManager,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  Markdown,
  matchesKey,
  type Component,
  type TUI,
  truncateToWidth,
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

export class BtwPanel implements Component {
  readonly scroll: ScrollViewport;
  private readonly panel: Panel;
  private closed = false;
  private promoted = false;

  constructor(
    private readonly tui: TUI,
    readonly theme: Theme,
    private readonly keybindings: Pick<KeybindingsManager, "matches">,
    private readonly done: () => void,
    public state: BtwPanelState,
    private readonly abortController: AbortController,
    private readonly promote: (exchange: BtwPromotion) => void,
    maxRows = Math.max(6, Math.floor((tui.terminal.rows ?? 24) * 0.6)),
  ) {
    const contentRows = Math.max(1, maxRows - 5);
    this.scroll = new ScrollViewport({
      content: new BtwBody(state, theme),
      viewportHeight: contentRows,
      followBottom: true,
    });
    this.panel = new Panel({
      theme,
      title: "/btw",
      child: this.scroll,
      footer: {
        render: (width) => [this.hintLine(width)],
        invalidate() {},
      },
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
    if (this.#matches(data, "tui.select.cancel", "escape")) {
      this.close();
      return;
    }
    if (this.state.status === "answer" && matchesKey(data, "s")) {
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
    const up = this.#matches(data, "tui.select.up", "up");
    const down = this.#matches(data, "tui.select.down", "down");
    if (up || down) {
      this.scroll.handleInput(up ? "\x1b[A" : "\x1b[B");
      this.tui.requestRender();
    }
  }

  #matches(
    data: string,
    binding: Parameters<KeybindingsManager["matches"]>[1],
    key: Parameters<typeof matchesKey>[1],
  ): boolean {
    return typeof this.keybindings?.matches === "function"
      ? this.keybindings.matches(data, binding)
      : matchesKey(data, key);
  }

  hintLine(width: number): string {
    const action =
      this.state.status === "pending"
        ? keyHint("tui.select.cancel", "abort")
        : this.state.status === "answer"
          ? `${rawKeyHint("s", "send")}  ${keyHint("tui.select.cancel", "close")}`
          : keyHint("tui.select.cancel", "close");
    return truncateToWidth(action, width);
  }

  render(width: number): string[] {
    return this.panel.render(width);
  }

  invalidate(): void {
    this.panel.invalidate();
  }
}
