import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { resolveChoice } from "./handler";
import { registerReadonlyMode } from "./mode";
import {
  extractToolPath,
  formatReadonlyTarget,
  formatDenyTitle,
  parseReadonlyArgs,
} from "./utils";

type ToolCallHandler = (
  event: { toolName: string; input: unknown },
  ctx: ExtensionContext,
) => Promise<unknown>;

describe("Readonly", () => {
  it("leaves proposed changes to the registered tool renderer", async () => {
    let toolCall: ToolCallHandler | undefined;
    const api = {
      registerShortcut: () => {},
      registerCommand: () => {},
      on: (event: string, handler: unknown) => {
        if (event === "tool_call") {
          toolCall = handler as ToolCallHandler;
        }
      },
    } as unknown as ExtensionAPI;
    registerReadonlyMode(api);

    let prompt = "";
    const ctx = {
      hasUI: true,
      signal: new AbortController().signal,
      ui: {
        select: async (title: string) => {
          prompt = title;
          return "Allow";
        },
        custom: async () => undefined,
        input: async () => undefined,
      },
    } as unknown as ExtensionContext;

    await toolCall?.(
      {
        toolName: "edit",
        input: {
          path: "src/index.ts",
          edits: [{ oldText: "before", newText: "proposed\n\u001b[2Jsource" }],
        },
      },
      ctx,
    );

    expect(prompt).toBe("Readonly: apply edit to src/index.ts?");
    expect(prompt).not.toContain("proposed");
  });

  it("bounds and normalizes target paths before prompting", async () => {
    let toolCall: ToolCallHandler | undefined;
    registerReadonlyMode({
      registerShortcut: () => {},
      registerCommand: () => {},
      on: (event: string, handler: unknown) => {
        if (event === "tool_call") {
          toolCall = handler as ToolCallHandler;
        }
      },
    } as unknown as ExtensionAPI);

    const prompts: string[] = [];
    const denyPrompts: {
      title: string;
      placeholder: string | undefined;
    }[] = [];
    const ctx = {
      hasUI: true,
      signal: new AbortController().signal,
      ui: {
        select: async (title: string) => {
          prompts.push(title);
          return "Deny";
        },
        custom: async () => undefined,
        input: async (title: string, placeholder?: string) => {
          denyPrompts.push({ title, placeholder });
          return "";
        },
      },
    } as unknown as ExtensionContext;

    await toolCall?.(
      {
        toolName: "edit",
        input: { path: `src/${"very-long-directory/".repeat(10)}target.ts` },
      },
      ctx,
    );
    await toolCall?.(
      {
        toolName: "write",
        input: { path: "src/unsafe\u0000target\nfile.ts" },
      },
      ctx,
    );
    await toolCall?.(
      {
        toolName: "edit",
        input: { path: `${"a".repeat(118)}😀${"b".repeat(10)}` },
      },
      ctx,
    );

    expect(prompts[0]).toMatch(/^Readonly: apply edit to .+…\?$/);
    expect(prompts[0]!.length).toBeLessThanOrEqual(160);
    expect(prompts[1]).toBe(
      "Readonly: apply write to src/unsafe target file.ts?",
    );
    expect(prompts[1]).not.toMatch(/\p{C}/u);
    expect(denyPrompts[1]).toEqual({
      title: "Deny the change — src/unsafe target file.ts",
      placeholder: "give a reason",
    });
    expect(prompts[2]).toBe(`Readonly: apply edit to ${"a".repeat(118)}…?`);
    expect(prompts[2]!.length).toBeLessThanOrEqual(160);
    expect(prompts[2]).not.toMatch(/\p{C}/u);
  });

  it("clears its namespaced status at shutdown", async () => {
    let shutdown:
      | ((event: unknown, ctx: ExtensionContext) => Promise<unknown>)
      | undefined;
    registerReadonlyMode({
      registerShortcut: () => {},
      registerCommand: () => {},
      on: (event: string, handler: unknown) => {
        if (event === "session_shutdown") {
          shutdown = handler as (
            event: unknown,
            ctx: ExtensionContext,
          ) => Promise<unknown>;
        }
      },
    } as unknown as ExtensionAPI);
    const setStatus = vi.fn();

    await shutdown?.({}, {
      mode: "tui",
      ui: {
        setStatus,
        theme: { fg: (_tone: string, text: string) => text },
      },
    } as unknown as ExtensionContext);

    expect(setStatus).toHaveBeenCalledWith(
      "pipkin:status:0100:readonly",
      undefined,
    );
  });

  it("keeps approval context concise and command semantics stable", () => {
    expect(extractToolPath({ path: "src/index.ts" })).toBe("src/index.ts");
    expect(formatReadonlyTarget("src/unsafe\nfile.ts")).toBe(
      "src/unsafe file.ts",
    );
    expect(formatDenyTitle("src/index.ts")).toBe(
      "Deny the change — src/index.ts",
    );
    expect(parseReadonlyArgs("on")).toEqual({ kind: "set", value: true });
    expect(parseReadonlyArgs("off")).toEqual({ kind: "set", value: false });
    expect(resolveChoice({ choice: "Allow", message: "" })).toEqual({
      block: false,
    });
    expect(resolveChoice({ choice: "Allow for session", message: "" })).toEqual(
      { block: false, disable: true },
    );
    expect(resolveChoice({ choice: "Deny", message: "try again" })).toEqual({
      block: true,
      reason:
        "Edit not applied. User denied the proposed change for this reason:\n\ntry again\n\nTake this reason into account before retrying.",
    });
  });
});
