import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  canonicalizeTarget,
  type FixedCapabilities,
  type PiPathCompatibility,
} from "../capabilities.js";
import { createGuardRuntimeState } from "../state.js";
import { decideDirectFilesystemTool } from "./decide.js";

const directories: string[] = [];
afterEach(() => {
  while (directories.length) {
    rmSync(directories.pop()!, { recursive: true, force: true });
  }
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pipkin-guard-direct-"));
  directories.push(root);
  const workspace = join(root, "workspace");
  const outside = join(root, "outside");
  mkdirSync(workspace);
  mkdirSync(outside);
  return { root, workspace, outside };
}

function state(cwd: string) {
  const runtime = createGuardRuntimeState();
  const canonicalCwd = canonicalizeTarget(cwd, cwd);
  const fixed: FixedCapabilities = {
    cwd: canonicalCwd,
    grants: [
      { path: canonicalCwd, access: "read", kind: "directory" },
      { path: canonicalCwd, access: "write", kind: "directory" },
    ],
  };
  runtime.setFixedCapabilities(fixed);
  return runtime;
}

function decide(
  runtime: ReturnType<typeof createGuardRuntimeState>,
  cwd: string,
  tool: "read" | "grep" | "find" | "ls" | "write" | "edit",
  path?: string,
  supportedMac = true,
  pathCompatibility?: PiPathCompatibility,
) {
  return decideDirectFilesystemTool({
    tool,
    input: path === undefined ? {} : { path },
    cwd,
    supportedMac,
    pathCompatibility,
    state: runtime,
  });
}

describe("direct filesystem decisions", () => {
  it("gates every direct tool by its fixed read or write capability", () => {
    const { workspace, outside } = fixture();
    const runtime = state(workspace);
    const inside = join(workspace, "inside.txt");
    const outsideFile = join(outside, "outside.txt");
    writeFileSync(inside, "inside");
    writeFileSync(outsideFile, "outside");

    for (const tool of ["read", "grep", "find", "ls"] as const) {
      expect(decide(runtime, workspace, tool, inside).kind).toBe("allow");
      expect(decide(runtime, workspace, tool, outsideFile)).toMatchObject({
        kind: "approval-required",
        access: "read",
        outsideSandbox: true,
      });
    }
    for (const tool of ["write", "edit"] as const) {
      expect(decide(runtime, workspace, tool, inside).kind).toBe("allow");
      expect(decide(runtime, workspace, tool, outsideFile)).toMatchObject({
        kind: "approval-required",
        access: "write",
        outsideSandbox: true,
      });
    }
  });

  it("uses canonical paths for symlink escapes and Pi-compatible aliases", () => {
    const { workspace, outside } = fixture();
    const runtime = state(workspace);
    const file = join(outside, "a file.txt");
    writeFileSync(file, "outside");
    symlinkSync(outside, join(workspace, "escape"));

    expect(
      decide(runtime, workspace, "read", "escape/a file.txt"),
    ).toMatchObject({
      kind: "approval-required",
      target: canonicalizeTarget(file, workspace),
      outsideSandbox: true,
    });
    expect(
      decide(runtime, workspace, "read", "~/a file.txt", true, {
        homeDir: outside,
      }),
    ).toMatchObject({ target: canonicalizeTarget(file, workspace) });
  });

  it("allows one-shot approval for a missing mutation target", () => {
    const { workspace, outside } = fixture();
    const runtime = state(workspace);
    const target = join(outside, "new", "file.txt");

    expect(decide(runtime, workspace, "write", target)).toMatchObject({
      kind: "approval-required",
      target: canonicalizeTarget(target, workspace),
      access: "write",
    });
    expect(decide(runtime, workspace, "read", target)).toMatchObject({
      kind: "deny",
      reason: expect.stringContaining("unavailable"),
    });
  });

  it("combines outside-sandbox and protected-read reasons", () => {
    const { workspace, outside } = fixture();
    const runtime = state(workspace);
    const inside = join(workspace, ".env.example");
    const outsideEnv = join(outside, "secret");
    writeFileSync(inside, "inside");
    writeFileSync(outsideEnv, "outside");
    symlinkSync(outsideEnv, join(workspace, ".env.link"));

    expect(decide(runtime, workspace, "read", inside)).toMatchObject({
      kind: "approval-required",
      outsideSandbox: false,
      protectedRead: true,
    });
    expect(decide(runtime, workspace, "read", ".env.link")).toMatchObject({
      kind: "approval-required",
      outsideSandbox: true,
      protectedRead: true,
    });
  });

  it("retains protected explicit reads without a macOS sandbox", () => {
    const { workspace, outside } = fixture();
    const runtime = state(workspace);
    const plain = join(outside, "plain.txt");
    const protectedFile = join(workspace, ".env");
    writeFileSync(plain, "plain");
    writeFileSync(protectedFile, "secret");

    expect(decide(runtime, workspace, "read", plain, false).kind).toBe("allow");
    expect(
      decide(runtime, workspace, "read", protectedFile, false),
    ).toMatchObject({
      kind: "approval-required",
      outsideSandbox: false,
      protectedRead: true,
    });
  });

  it("classifies canonical home credential aliases", () => {
    const { root, workspace, outside } = fixture();
    const home = join(root, "home");
    const ssh = join(outside, "ssh");
    mkdirSync(home);
    mkdirSync(ssh);
    writeFileSync(join(ssh, "id_ed25519"), "secret");
    symlinkSync(ssh, join(home, ".ssh"));
    symlinkSync(ssh, join(workspace, "ssh-alias"));

    expect(
      decide(
        state(workspace),
        workspace,
        "read",
        join(workspace, "ssh-alias", "id_ed25519"),
        false,
        { homeDir: home },
      ),
    ).toMatchObject({
      kind: "approval-required",
      outsideSandbox: false,
      protectedRead: true,
    });
  });

  it("does not inspect broad directory grep for protected descendants", () => {
    const { workspace } = fixture();
    const runtime = state(workspace);
    writeFileSync(join(workspace, ".env"), "secret");
    expect(decide(runtime, workspace, "grep").kind).toBe("allow");
  });
});
