import { DynamicBorder, type Theme } from "@earendil-works/pi-coding-agent";
import {
  Container,
  type Component,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";

class PaddedChild implements Component {
  constructor(
    private readonly child: Component,
    private readonly paddingX: number,
  ) {}

  render(width: number): string[] {
    const padding = Math.min(this.paddingX, width);
    const contentWidth = Math.max(0, width - padding);
    return this.child
      .render(contentWidth)
      .map(
        (line) =>
          `${" ".repeat(padding)}${truncateToWidth(line, contentWidth)}`,
      );
  }

  invalidate(): void {
    this.child.invalidate();
  }
}

class PanelLabel implements Component {
  constructor(
    private readonly text: string,
    private readonly paddingX: number,
    private readonly style: (text: string) => string,
  ) {}

  render(width: number): string[] {
    const leftPadding = Math.min(this.paddingX, width);
    const text = truncateToWidth(this.text, Math.max(0, width - leftPadding));
    const rightPadding = Math.min(
      this.paddingX,
      Math.max(0, width - leftPadding - visibleWidth(text)),
    );
    return [
      `${" ".repeat(leftPadding)}${this.style(text)}${" ".repeat(rightPadding)}`,
    ];
  }

  invalidate(): void {}
}

export type PanelOptions = {
  theme: Theme;
  child: Component;
  title?: string;
  subtitle?: string;
  footer?: string;
  padding?: number;
  borderColor?: (text: string) => string;
};

export class Panel extends Container {
  constructor(options: PanelOptions) {
    super();
    const padding = options.padding ?? 1;
    const borderColor =
      options.borderColor ??
      ((text: string) => options.theme.fg("border", text));

    this.addChild(new DynamicBorder(borderColor));
    if (options.title) {
      this.addChild(
        new PanelLabel(options.title, padding, (text) =>
          options.theme.bold(options.theme.fg("accent", text)),
        ),
      );
    }
    if (options.subtitle) {
      this.addChild(
        new PanelLabel(options.subtitle, padding, (text) =>
          options.theme.fg("muted", text),
        ),
      );
    }

    this.addChild(new PaddedChild(options.child, padding));

    if (options.footer) {
      this.addChild(
        new PanelLabel(options.footer, padding, (text) =>
          options.theme.fg("dim", text),
        ),
      );
    }
    this.addChild(new DynamicBorder(borderColor));
  }
}
