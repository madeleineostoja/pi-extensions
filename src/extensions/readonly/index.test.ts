import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { resolveChoice } from "./handler";
import readonly from "./index";
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
    readonly(api);

    let prompt = "";
    const ctx = {
      hasUI: true,
      signal: new AbortController().signal,
      ui: {
        select: async (title: string) => {
          prompt = title;
          return "Accept";
        },
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

    expect(prompt).toBe("Readonly: apply proposed edit?");
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
