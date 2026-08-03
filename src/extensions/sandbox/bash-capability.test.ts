import { afterEach, describe, expect, it, vi } from "vitest";

const key = Symbol.for("pipkin:sandbox:bash");
const original = (globalThis as Record<symbol, unknown>)[key];

afterEach(() => {
  const globalScope = globalThis as Record<symbol, unknown>;
  if (original === undefined) {
    delete globalScope[key];
  } else {
    globalScope[key] = original;
  }
});

describe("Sandbox Bash capability", () => {
  it("rendezvouses across independent loader instances while isolating hosts", async () => {
    const { executeSandboxBash } = await import("./bash-capability.js");
    vi.resetModules();
    const { bindSandboxBashExecutor } = await import("./bash-binding.js");
    const firstHost = {} as never;
    const secondHost = {} as never;
    const first = bindSandboxBashExecutor(firstHost, async () => ({
      content: [{ type: "text", text: "first" }],
      details: undefined,
    }));
    const replacement = bindSandboxBashExecutor(firstHost, async () => ({
      content: [{ type: "text", text: "replacement" }],
      details: undefined,
    }));
    bindSandboxBashExecutor(secondHost, async () => ({
      content: [{ type: "text", text: "second" }],
      details: undefined,
    }));
    first.dispose();

    await expect(
      executeSandboxBash(firstHost, {
        toolCallId: "call",
        params: { command: "true" },
        signal: undefined,
        onUpdate: undefined,
        ctx: {} as never,
      }),
    ).resolves.toMatchObject({
      content: [{ type: "text", text: "replacement" }],
    });
    await expect(
      executeSandboxBash({} as never, {
        toolCallId: "call",
        params: { command: "true" },
        signal: undefined,
        onUpdate: undefined,
        ctx: {} as never,
      }),
    ).rejects.toThrow("unavailable");

    replacement.dispose();
    await expect(
      executeSandboxBash(firstHost, {
        toolCallId: "call",
        params: { command: "true" },
        signal: undefined,
        onUpdate: undefined,
        ctx: {} as never,
      }),
    ).rejects.toThrow("unavailable");
  });
});
