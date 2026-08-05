import { describe, expect, it, vi } from "vitest";
import { WideSelectList } from "./wide-select-list.js";

const ansiPattern = new RegExp(
  `${String.fromCodePoint(27)}\\[[0-?]*[ -/]*[@-~]`,
  "g",
);
const plain = (text: string) => text.replace(ansiPattern, "");

function list(
  entries: ConstructorParameters<typeof WideSelectList<string>>[0]["entries"],
) {
  return new WideSelectList({
    entries,
    maxVisible: 3,
    selectedPrefix: (text) => `<${text}>`,
  });
}

describe("WideSelectList", () => {
  it("renders an owner-provided empty state", () => {
    const current = new WideSelectList<string>({
      entries: [],
      maxVisible: 3,
      selectedPrefix: (text) => text,
      empty: { text: "No managed processes." },
    });

    expect(current.render(80)).toEqual(["No managed processes."]);
    current.handleInput("\r");
    expect(current.getSelectedItem()).toBeUndefined();
  });

  it("skips sections and preserves a stable selection or nearest item", () => {
    const current = list([
      { kind: "section", label: "Active" },
      { kind: "item", value: "a", data: "a", elastic: "first" },
      { kind: "section", label: "Retained" },
      { kind: "item", value: "b", data: "b", elastic: "second" },
    ]);

    current.handleInput("\x1b[B");
    expect(current.getSelectedItem()?.value).toBe("b");
    current.setSelectedValue("missing", 2);
    expect(current.getSelectedItem()?.value).toBe("b");
  });

  it("allocates fixed, elastic, and final fields without styling muted fields as primary", () => {
    const muted = vi.fn((text: string) => text);
    const current = list([
      {
        kind: "item",
        value: "agent",
        data: "agent",
        prefix: "  ● ",
        fixed: [{ text: "Explore", width: 8 }],
        elastic: "a long description",
        right: "1m 24s",
        elasticStyle: muted,
        rightStyle: muted,
      },
    ]);

    const line = plain(current.render(48)[0]!);
    expect(line).toContain("<› >");
    expect(line).toContain("Explore ");
    expect(line.trimEnd().endsWith("1m 24s")).toBe(true);
    expect(muted).toHaveBeenCalledWith(expect.any(String), true);
  });

  it("scrolls selected rows into view while keeping labels non-selectable", () => {
    const current = list([
      { kind: "section", label: "Active" },
      ...["one", "two", "three", "four"].map((value) => ({
        kind: "item" as const,
        value,
        data: value,
        elastic: value,
      })),
    ]);

    current.handleInput("\x1b[B");
    current.handleInput("\x1b[B");
    current.handleInput("\x1b[B");
    expect(current.getSelectedItem()?.value).toBe("four");
    expect(current.render(30).join("\n")).toContain("four");
    expect(current.render(30).join("\n")).not.toContain("Active");
  });
});
