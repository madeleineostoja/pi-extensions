import { describe, expect, it } from "vitest";
import { createSandboxSessionController } from "./lifecycle.js";
import { createSandboxSessionState } from "./state.js";

const policy = {
  sessionCwd: "/workspace",
  workspaceRoot: "/workspace",
  temporaryRoots: [],
  cacheRoots: [],
  writableRoots: ["/workspace"],
} as const;

function context() {
  const statuses = new Map<string, string | undefined>();
  return {
    cwd: "/workspace",
    mode: "tui",
    ui: {
      theme: { fg: (_tone: string, text: string) => text },
      setStatus: (key: string, value: string | undefined) =>
        statuses.set(key, value),
    },
    statuses,
  };
}

describe("Sandbox lifecycle", () => {
  it("registers an enabled Bash owner after resolving one immutable policy", async () => {
    const state = createSandboxSessionState();
    const controller = createSandboxSessionController({
      state,
      supportedMac: true,
      resolvePolicy: async () => policy,
    });
    const ctx = context();
    const bash = await controller.sessionStart({} as never, ctx as never);
    expect(bash.name).toBe("bash");
    expect(state.enabled()).toBe(true);
    expect(state.policy()).toBe(policy);
    expect(ctx.statuses.get("pipkin.sandbox")).toContain("sandbox");
    await controller.sessionShutdown(ctx as never);
    expect(ctx.statuses.get("pipkin.sandbox")).toBeUndefined();
  });

  it("keeps macOS Bash fail-closed when policy resolution fails", async () => {
    const state = createSandboxSessionState();
    const controller = createSandboxSessionController({
      state,
      supportedMac: true,
      resolvePolicy: async () => {
        throw new Error("Git failed");
      },
    });
    const ctx = context();
    const bash = await controller.sessionStart({} as never, ctx as never);
    expect(bash.name).toBe("bash");
    expect(state.policy()).toBeUndefined();
    expect(state.unavailableReason()).toContain("Git failed");
    expect(ctx.statuses.get("pipkin.sandbox")).toContain("unavailable");
    expect(state.enabled()).toBe(true);
    await controller.sessionShutdown(ctx as never);
  });

  it("initializes a child policy independently after a parent turns Sandbox off", async () => {
    const parent = createSandboxSessionState();
    parent.reset(policy);
    parent.setEnabled(false);
    const child = createSandboxSessionState();
    const childPolicy = { ...policy, sessionCwd: "/workspace/child" };
    const controller = createSandboxSessionController({
      state: child,
      supportedMac: true,
      resolvePolicy: async () => childPolicy,
    });
    const ctx = { ...context(), cwd: "/workspace/child" };
    await controller.sessionStart({} as never, ctx as never);
    expect(parent.enabled()).toBe(false);
    expect(child.enabled()).toBe(true);
    expect(child.policy()).toBe(childPolicy);
    await controller.sessionShutdown(ctx as never);
  });

  it("uses local Bash and unavailable status on Linux without policy resolution", async () => {
    const state = createSandboxSessionState();
    const controller = createSandboxSessionController({
      state,
      supportedMac: false,
      resolvePolicy: async () => {
        throw new Error("should not resolve");
      },
    });
    const ctx = context();
    const bash = await controller.sessionStart({} as never, ctx as never);
    expect(bash.name).toBe("bash");
    expect(state.policy()).toBeUndefined();
    expect(ctx.statuses.get("pipkin.sandbox")).toContain("unavailable");
    await controller.sessionShutdown(ctx as never);
  });
});
