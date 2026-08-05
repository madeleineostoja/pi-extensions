import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";
import {
  matchesKey,
  truncateToWidth,
  type Component,
  visibleWidth,
} from "@earendil-works/pi-tui";

export type WideListField = {
  text: string;
  width: number;
  style?: (text: string, selected: boolean) => string;
};

export type WideListSection = {
  kind: "section";
  label: string;
  style?: (text: string) => string;
};

export type WideListItem<T> = {
  kind: "item";
  value: string;
  data: T;
  prefix?: string;
  prefixWidth?: number;
  fixed?: readonly WideListField[];
  elastic: string;
  right?: string;
  style?: (text: string, selected: boolean) => string;
  elasticStyle?: (text: string, selected: boolean) => string;
  rightStyle?: (text: string, selected: boolean) => string;
};

export type WideListEntry<T> = WideListSection | WideListItem<T>;

export type WideSelectListOptions<T> = {
  entries: readonly WideListEntry<T>[];
  maxVisible: number;
  selectedPrefix: (text: string) => string;
  empty?: { text: string; style?: (text: string) => string };
  keybindings?: Pick<KeybindingsManager, "matches">;
  onSelect?: (item: WideListItem<T>) => void;
};

/** A non-searchable selectable list with feature-owned column content and styles. */
export class WideSelectList<T> implements Component {
  #entries: readonly WideListEntry<T>[];
  #selectedIndex = -1;
  #scrollOffset = 0;
  #onSelect: ((item: WideListItem<T>) => void) | undefined;

  constructor(private readonly options: WideSelectListOptions<T>) {
    this.#entries = options.entries;
    this.#onSelect = options.onSelect;
    this.#selectedIndex = this.#firstSelectable();
  }

  getSelectedItem(): WideListItem<T> | undefined {
    const entry = this.#entries[this.#selectedIndex];
    return entry?.kind === "item" ? entry : undefined;
  }

  setSelectedValue(value: string | undefined, fallbackIndex = 0): void {
    const stable = this.#entries.findIndex(
      (entry) => entry.kind === "item" && entry.value === value,
    );
    this.#selectedIndex =
      stable >= 0 ? stable : this.#nearestSelectable(fallbackIndex);
    this.#ensureVisible();
  }

  handleInput(data: string): void {
    const matches = (
      binding: Parameters<KeybindingsManager["matches"]>[1],
      key: Parameters<typeof matchesKey>[1],
    ) =>
      this.options.keybindings?.matches(data, binding) ?? matchesKey(data, key);
    if (matches("tui.select.up", "up")) {
      this.#move(-1);
    } else if (matches("tui.select.down", "down")) {
      this.#move(1);
    } else if (matches("tui.select.confirm", "enter")) {
      const selected = this.getSelectedItem();
      if (selected) {
        this.#onSelect?.(selected);
      }
    }
  }

  render(width: number): string[] {
    if (this.#entries.length === 0 && this.options.empty) {
      const text = truncateToWidth(this.options.empty.text, width);
      return [this.options.empty.style?.(text) ?? text];
    }
    this.#ensureVisible();
    const visible = this.#entries.slice(
      this.#scrollOffset,
      this.#scrollOffset + this.options.maxVisible,
    );
    return visible.map((entry, index) => {
      const absoluteIndex = this.#scrollOffset + index;
      return entry.kind === "section"
        ? truncateToWidth(entry.style?.(entry.label) ?? entry.label, width)
        : renderWideListItem(
            entry,
            absoluteIndex === this.#selectedIndex,
            width,
            this.options.selectedPrefix,
          );
    });
  }

  invalidate(): void {}

  #move(direction: -1 | 1): void {
    let index = this.#selectedIndex;
    while (true) {
      index += direction;
      if (index < 0 || index >= this.#entries.length) {
        return;
      }
      if (this.#entries[index]?.kind === "item") {
        this.#selectedIndex = index;
        this.#ensureVisible();
        return;
      }
    }
  }

  #firstSelectable(): number {
    return this.#entries.findIndex((entry) => entry.kind === "item");
  }

  #nearestSelectable(index: number): number {
    if (this.#entries.length === 0) {
      return -1;
    }
    for (let distance = 0; distance < this.#entries.length; distance += 1) {
      for (const candidate of [index + distance, index - distance]) {
        if (
          candidate >= 0 &&
          candidate < this.#entries.length &&
          this.#entries[candidate]?.kind === "item"
        ) {
          return candidate;
        }
      }
    }
    return -1;
  }

  #ensureVisible(): void {
    if (this.#selectedIndex < 0) {
      this.#scrollOffset = 0;
      return;
    }
    const maxOffset = Math.max(
      0,
      this.#entries.length - this.options.maxVisible,
    );
    if (this.#selectedIndex < this.#scrollOffset) {
      this.#scrollOffset = this.#selectedIndex;
    } else if (
      this.#selectedIndex >=
      this.#scrollOffset + this.options.maxVisible
    ) {
      this.#scrollOffset = this.#selectedIndex - this.options.maxVisible + 1;
    }
    this.#scrollOffset = Math.min(this.#scrollOffset, maxOffset);
  }
}

export function renderWideListItem<T>(
  item: WideListItem<T>,
  selected: boolean,
  width: number,
  selectedPrefix: (text: string) => string,
): string {
  const marker = selected ? selectedPrefix("› ") : "  ";
  const rawPrefix = item.prefix ?? "";
  const prefixWidth = item.prefixWidth ?? visibleWidth(rawPrefix);
  const prefix = `${truncateToWidth(rawPrefix, prefixWidth)}${" ".repeat(
    Math.max(0, prefixWidth - visibleWidth(rawPrefix)),
  )}`;
  const fixed = item.fixed ?? [];
  const fixedWidth = fixed.reduce((total, field) => total + field.width + 1, 0);
  const rightWidth = item.right ? visibleWidth(item.right) + 1 : 0;
  const reserved = visibleWidth(marker) + prefixWidth + fixedWidth + rightWidth;
  const elasticWidth = Math.max(0, width - reserved);
  const fields = fixed.map((field) => {
    const text = truncateToWidth(field.text, field.width);
    const padded = `${text}${" ".repeat(Math.max(0, field.width - visibleWidth(text)))}`;
    return field.style?.(padded, selected) ?? padded;
  });
  const elastic = truncateToWidth(item.elastic, elasticWidth);
  const elasticPadded = `${elastic}${" ".repeat(
    Math.max(0, elasticWidth - visibleWidth(elastic)),
  )}`;
  const line = [
    marker,
    prefix,
    ...fields.flatMap((field) => [field, " "]),
    item.elasticStyle?.(elasticPadded, selected) ??
      item.style?.(elasticPadded, selected) ??
      elasticPadded,
    item.right
      ? ` ${item.rightStyle?.(item.right, selected) ?? item.right}`
      : "",
  ].join("");
  return truncateToWidth(line, Math.max(0, width));
}
