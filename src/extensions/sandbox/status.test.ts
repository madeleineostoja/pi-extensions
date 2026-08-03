import { describe, expect, it } from "vitest";
import { createSandboxSessionState } from "./state.js";
import {
  sandboxStatus,
  sandboxStatusLabel,
  syncSandboxStatus,
} from "./status.js";

const policy = {
  sessionCwd: "/workspace",
  workspaceRoot: "/workspace",
  temporaryRoots: [],
  cacheRoots: [],
  writableRoots: ["/workspace"],
  creationRoots: [],
} as const;

function context() {
  const statuses = new Map<string, string | undefined>();
  return {
    ctx: {
      mode: "tui",
      ui: {
        theme: {
          fg: (tone: string, text: string) => `<${tone}>${text}</${tone}>`,
        },
        setStatus: (key: string, value: string | undefined) =>
          statuses.set(key, value),
      },
    },
    statuses,
  };
}

describe("Sandbox status", () => {
  it("distinguishes enabled, explicit off, and unavailable states", () => {
    const state = createSandboxSessionState();
    state.reset(policy);
    expect(sandboxStatus(state, true)).toBe("on");
    expect(sandboxStatusLabel("on")).toBe("sandbox");
    state.setEnabled(false);
    expect(sandboxStatus(state, true)).toBe("off");
    expect(sandboxStatusLabel("off")).toBe("sandbox off");
    expect(sandboxStatus(state, false)).toBe("unavailable");
    expect(sandboxStatusLabel("unavailable")).toBe("sandbox unavailable");
  });

  it("uses the Sandbox footer key and expected tones", () => {
    const state = createSandboxSessionState();
    const { ctx, statuses } = context();
    state.reset(policy);
    syncSandboxStatus(ctx as never, state, true);
    expect(statuses.get("pipkin:status:0100:sandbox")).toBe(
      "<success>󰒃</success> <muted>sandbox</muted>",
    );
    state.setEnabled(false);
    syncSandboxStatus(ctx as never, state, true);
    expect(statuses.get("pipkin:status:0100:sandbox")).toBe(
      "<warning>󰒃</warning> <warning>sandbox off</warning>",
    );
  });
});
