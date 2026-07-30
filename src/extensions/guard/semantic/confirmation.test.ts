import { describe, expect, it } from "vitest";
import { createGuardRuntimeState } from "../state.js";
import { confirmBashCommand } from "./confirmation.js";

type PromptContext = Parameters<typeof confirmBashCommand>[0]["ctx"];

function context(
  select?: (choices: string[]) => string | undefined,
): PromptContext {
  return {
    cwd: "/",
    hasUI: !!select,
    signal: undefined,
    ui: {
      select: async (_title: string, choices: string[]) => select?.(choices),
      input: async () => "",
    },
  } as unknown as PromptContext;
}

describe("Guard semantic confirmation", () => {
  it("passes no-UI workers without changing semantic state", async () => {
    const state = createGuardRuntimeState();
    await expect(
      confirmBashCommand({
        command: "rm /etc/hosts",
        cwd: "/",
        state,
        ctx: context(),
      }),
    ).resolves.toBeUndefined();
    expect(state.semanticConfirmationEnabled()).toBe(true);
  });

  it("only session-disables semantic prompting after Allow all", async () => {
    const state = createGuardRuntimeState();
    await expect(
      confirmBashCommand({
        command: "rm /etc/hosts",
        cwd: "/",
        state,
        ctx: context(() => "Allow all this session"),
      }),
    ).resolves.toBeUndefined();
    expect(state.semanticConfirmationEnabled()).toBe(false);
  });

  it("resets Allow all when the session is replaced", async () => {
    const state = createGuardRuntimeState();
    await confirmBashCommand({
      command: "rm /etc/hosts",
      cwd: "/",
      state,
      ctx: context(() => "Allow all this session"),
    });
    expect(state.semanticConfirmationEnabled()).toBe(false);

    state.resetSession();

    expect(state.semanticConfirmationEnabled()).toBe(true);
  });

  it("blocks before execution when confirmation is declined", async () => {
    await expect(
      confirmBashCommand({
        command: "rm /etc/hosts",
        cwd: "/",
        state: createGuardRuntimeState(),
        ctx: context(() => "Block"),
      }),
    ).rejects.toThrow("Command blocked by user");
  });
});
