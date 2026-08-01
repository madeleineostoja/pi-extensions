import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSandboxSessionState } from "./state.js";
import { createSandboxToolGate } from "./tool-gate.js";

const directories: string[] = [];

afterEach(() => {
  while (directories.length) {
    rmSync(directories.pop()!, { force: true, recursive: true });
  }
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pipkin-sandbox-gate-"));
  directories.push(root);
  const workspace = join(root, "workspace");
  const outside = join(root, "outside");
  mkdirSync(workspace);
  mkdirSync(outside);
  const state = createSandboxSessionState();
  state.reset({
    sessionCwd: realpathSync(workspace),
    workspaceRoot: realpathSync(workspace),
    temporaryRoots: [],
    cacheRoots: [],
    writableRoots: [realpathSync(workspace)],
    creationRoots: [],
  });
  return {
    outside: realpathSync(outside),
    state,
    workspace: realpathSync(workspace),
  };
}

describe("Sandbox direct-tool gate", () => {
  it("blocks enabled macOS direct writes outside the effective workspace target", () => {
    const { outside, state, workspace } = fixture();
    const gate = createSandboxToolGate({ state, supportedMac: true });
    expect(
      gate({ toolName: "write", input: { path: "inside.txt" } }, {} as never),
    ).toBeUndefined();
    expect(
      gate(
        { toolName: "edit", input: { path: join(outside, "outside.txt") } },
        {} as never,
      ),
    ).toEqual({
      block: true,
      reason: `Sandbox: direct writes must stay in the workspace. Effective target: ${join(outside, "outside.txt")}`,
    });
    expect(workspace).toBe(state.policy()?.workspaceRoot);
  });

  it("does not gate Linux or explicitly disabled macOS sessions", () => {
    const { outside, state } = fixture();
    const event = { toolName: "write", input: { path: join(outside, "file") } };
    expect(
      createSandboxToolGate({ state, supportedMac: false })(event, {} as never),
    ).toBeUndefined();
    state.setEnabled(false);
    expect(
      createSandboxToolGate({ state, supportedMac: true })(event, {} as never),
    ).toBeUndefined();
  });

  it("fails closed after macOS policy initialization failure", () => {
    const state = createSandboxSessionState();
    state.reset(
      undefined,
      "Sandbox: initialization failed: Git resolution failed.",
    );
    expect(
      createSandboxToolGate({ state, supportedMac: true })(
        { toolName: "write", input: { path: "file" } },
        {} as never,
      ),
    ).toEqual({
      block: true,
      reason: "Sandbox: initialization failed: Git resolution failed.",
    });
  });
});
