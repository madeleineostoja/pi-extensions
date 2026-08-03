import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { resolveChoice } from "./handler";
import { registerReadonlyMode } from "./mode";
import { extractToolPath, formatSteerTitle, parseReadonlyArgs } from "./utils";

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
          return "Accept";
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
          edits: [{ oldText: "before", newText: "proposed" }],
        },
      },
      ctx,
    );

    expect(prompt).toContain(
      "Readonly: apply proposed edit?\n\nProposed edit for src/index.ts:",
    );
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
      "pipkin:status:0200:readonly",
      undefined,
    );
  });

  it("keeps approval context concise and command semantics stable", () => {
    expect(extractToolPath({ path: "src/index.ts" })).toBe("src/index.ts");
    expect(formatSteerTitle("src/index.ts")).toBe(
      "Steer the agent — src/index.ts",
    );
    expect(parseReadonlyArgs("on")).toEqual({ kind: "set", value: true });
    expect(parseReadonlyArgs("off")).toEqual({ kind: "set", value: false });
    expect(
      resolveChoice({ choice: "Accept for this session", message: "" }),
    ).toEqual({ block: false, disable: true });
  });
});
