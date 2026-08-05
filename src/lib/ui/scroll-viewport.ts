import {
  matchesKey,
  truncateToWidth,
  type Component,
} from "@earendil-works/pi-tui";

export type ScrollViewportOptions = {
  content: Component;
  viewportHeight: number;
  followBottom?: boolean;
};

type ContentReplacement = {
  offsetDelta?: number;
};

/** A feature-owned scroll position over replaceable rendered content. */
export class ScrollViewport implements Component {
  #content: Component;
  #viewportHeight: number;
  #offset = 0;
  #followingBottom: boolean;
  #lastLines: string[] = [];

  constructor(options: ScrollViewportOptions) {
    this.#content = options.content;
    this.#viewportHeight = options.viewportHeight;
    this.#followingBottom = options.followBottom === true;
  }

  get offset(): number {
    return this.#offset;
  }

  get isAtBottom(): boolean {
    return this.#offset >= this.#maximumOffset();
  }

  setContent(content: Component, replacement: ContentReplacement = {}): void {
    this.#content = content;
    if (!this.#followingBottom) {
      this.#offset += replacement.offsetDelta ?? 0;
    }
    this.#clamp();
  }

  setViewportHeight(height: number): void {
    this.#viewportHeight = Math.max(1, height);
    this.#clamp();
  }

  scrollUp(): void {
    this.#followingBottom = false;
    this.#offset = Math.max(0, this.#offset - 1);
  }

  scrollDown(): void {
    this.#offset = Math.min(this.#maximumOffset(), this.#offset + 1);
    if (this.isAtBottom) {
      this.#followingBottom = true;
    }
  }

  scrollToStart(): void {
    this.#followingBottom = false;
    this.#offset = 0;
  }

  scrollToEnd(): void {
    this.#offset = this.#maximumOffset();
    this.#followingBottom = true;
  }

  handleInput(data: string, options: { homeEnd?: boolean } = {}): void {
    if (matchesKey(data, "up")) {
      this.scrollUp();
    } else if (matchesKey(data, "down")) {
      this.scrollDown();
    } else if (options.homeEnd && matchesKey(data, "home")) {
      this.scrollToStart();
    } else if (options.homeEnd && matchesKey(data, "end")) {
      this.scrollToEnd();
    }
  }

  render(width: number): string[] {
    this.#lastLines = this.#content
      .render(width)
      .map((line) => truncateToWidth(line, Math.max(1, width), "…", false));
    if (this.#followingBottom) {
      this.#offset = this.#maximumOffset();
    } else {
      this.#clamp();
    }
    return this.#lastLines.slice(
      this.#offset,
      this.#offset + this.#viewportHeight,
    );
  }

  invalidate(): void {
    this.#content.invalidate();
  }

  #maximumOffset(): number {
    return Math.max(0, this.#lastLines.length - this.#viewportHeight);
  }

  #clamp(): void {
    this.#offset = Math.min(Math.max(0, this.#offset), this.#maximumOffset());
  }
}
