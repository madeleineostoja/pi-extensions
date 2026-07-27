import { describe, expect, expectTypeOf, it, vi } from "vitest";
import type {
  PermissionPromptResult,
  PermissionPromptUI,
} from "./permission-prompt.js";
import { promptForPermission } from "./permission-prompt.js";

type FakeUI = PermissionPromptUI & {
  select: ReturnType<typeof vi.fn>;
  input: ReturnType<typeof vi.fn>;
};

function makeUI(options: {
  selected?: string;
  input?: string | undefined;
}): FakeUI {
  return {
    select: vi.fn().mockResolvedValue(options.selected),
    input: vi.fn().mockResolvedValue(options.input),
  } as FakeUI;
}

function abortError(): Error {
  const err = new Error("aborted");
  err.name = "AbortError";
  return err;
}

const choices = [
  { value: "allow", label: "Allow" },
  {
    value: "block",
    label: "Block",
    input: { title: "Reason", placeholder: "why?" },
  },
] as const;

describe("promptForPermission", () => {
  it("returns a selected choice without prompting for input", async () => {
    const ui = makeUI({ selected: "Allow" });

    await expect(
      promptForPermission({
        ui,
        title: "Run command?",
        detail: "rm -rf tmp",
        choices,
      }),
    ).resolves.toEqual({ kind: "selected", value: "allow" });

    expect(ui.select).toHaveBeenCalledWith("Run command?\nrm -rf tmp", [
      "Allow",
      "Block",
    ]);
    expect(ui.input).not.toHaveBeenCalled();
  });

  it("prompts for input when the selected choice declares input", async () => {
    const ui = makeUI({ selected: "Block", input: "too risky" });

    await expect(
      promptForPermission({ ui, title: "Run command?", choices }),
    ).resolves.toEqual({
      kind: "selected",
      value: "block",
      message: "too risky",
    });

    expect(ui.input).toHaveBeenCalledExactlyOnceWith("Reason", "why?");
  });

  it("uses an empty message when input is dismissed", async () => {
    const ui = makeUI({ selected: "Block", input: undefined });

    await expect(
      promptForPermission({ ui, title: "Run command?", choices }),
    ).resolves.toEqual({ kind: "selected", value: "block", message: "" });
  });

  it("returns aborted when select is dismissed", async () => {
    const ui = makeUI({ selected: undefined });

    await expect(
      promptForPermission({ ui, title: "Run command?", choices }),
    ).resolves.toEqual({ kind: "aborted" });
  });

  it("returns aborted when select rejects with AbortError", async () => {
    const ui = makeUI({ selected: "Allow" });
    ui.select.mockRejectedValueOnce(abortError());

    await expect(
      promptForPermission({ ui, title: "Run command?", choices }),
    ).resolves.toEqual({ kind: "aborted" });
  });

  it("returns aborted when input rejects with AbortError", async () => {
    const ui = makeUI({ selected: "Block" });
    ui.input.mockRejectedValueOnce(abortError());

    await expect(
      promptForPermission({ ui, title: "Run command?", choices }),
    ).resolves.toEqual({ kind: "aborted" });
  });

  it("rethrows non-abort select errors", async () => {
    const ui = makeUI({ selected: "Allow" });
    const err = new Error("boom");
    ui.select.mockRejectedValueOnce(err);

    await expect(
      promptForPermission({ ui, title: "Run command?", choices }),
    ).rejects.toBe(err);
  });

  it("rethrows non-abort input errors", async () => {
    const ui = makeUI({ selected: "Block" });
    const err = new Error("boom");
    ui.input.mockRejectedValueOnce(err);

    await expect(
      promptForPermission({ ui, title: "Run command?", choices }),
    ).rejects.toBe(err);
  });

  it("forwards a provided signal to select", async () => {
    const ui = makeUI({ selected: "Allow" });
    const controller = new AbortController();

    await promptForPermission({
      ui,
      signal: controller.signal,
      title: "Run command?",
      choices,
    });

    expect(ui.select).toHaveBeenCalledWith("Run command?", ["Allow", "Block"], {
      signal: controller.signal,
    });
  });

  it("preserves the literal union of choice values", async () => {
    const ui = makeUI({ selected: "Allow" });
    const result = await promptForPermission({
      ui,
      title: "Run command?",
      choices,
    });

    expectTypeOf(result).toEqualTypeOf<
      PermissionPromptResult<"allow" | "block">
    >();
  });
});
