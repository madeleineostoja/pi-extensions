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
import { canonicalizeTarget, type FixedCapabilities } from "../capabilities.js";
import { createGuardRuntimeState } from "../state.js";
import {
  decideDirectFilesystemTool,
  prepareExplicitFilesystemGrant,
} from "./decide.js";
import { filesystemScope } from "./tool-gate.js";

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
      { path: canonicalCwd, access: "read", kind: "directory", effects: [] },
      { path: canonicalCwd, access: "write", kind: "directory", effects: [] },
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
) {
  return decideDirectFilesystemTool({
    tool,
    input: path === undefined ? {} : { path },
    cwd,
    supportedMac,
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
      expect(decide(runtime, workspace, tool, outsideFile).kind).toBe(
        "approval-required",
      );
    }
    for (const tool of ["write", "edit"] as const) {
      expect(decide(runtime, workspace, tool, inside).kind).toBe("allow");
      expect(decide(runtime, workspace, tool, outsideFile).kind).toBe(
        "approval-required",
      );
    }
  });

  it("uses Pi-compatible aliases and canonical paths, including a symlink escape", () => {
    const { workspace, outside } = fixture();
    const runtime = state(workspace);
    const file = join(outside, "a file.txt");
    writeFileSync(file, "outside");
    symlinkSync(outside, join(workspace, "escape"));

    expect(
      canonicalizeTarget(`@file://${file.replace(/ /g, "\u00a0")}`, workspace),
    ).toBe(canonicalizeTarget(file, workspace));
    expect(decide(runtime, workspace, "read", "escape/a file.txt").kind).toBe(
      "approval-required",
    );
  });

  it("keeps missing mutations exact and never promotes them to a parent", () => {
    const { workspace, outside } = fixture();
    const runtime = state(workspace);
    const target = join(outside, "new", "file.txt");
    const result = decide(runtime, workspace, "write", target);
    expect(result).toMatchObject({
      kind: "approval-required",
      grant: {
        path: canonicalizeTarget(target, workspace),
        kind: "file",
        access: "write",
      },
    });
  });

  it("combines outside and protected effects while keeping in-root protected files separate", () => {
    const { workspace, outside } = fixture();
    const runtime = state(workspace);
    const inside = join(workspace, ".env.example");
    const outsideEnv = join(outside, "secret");
    writeFileSync(inside, "inside");
    writeFileSync(outsideEnv, "outside");
    symlinkSync(outsideEnv, join(workspace, ".env.link"));

    expect(decide(runtime, workspace, "read", inside)).toMatchObject({
      kind: "approval-required",
      outsideBoundary: false,
      protectedRead: true,
      grant: { effects: ["protected-read"] },
    });
    expect(decide(runtime, workspace, "read", ".env.link")).toMatchObject({
      kind: "approval-required",
      outsideBoundary: true,
      protectedRead: true,
      grant: { effects: ["outside-boundary", "protected-read"] },
    });
  });

  it("retains protected explicit reads without a macOS reachability boundary", () => {
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
      outsideBoundary: false,
      protectedRead: true,
    });
  });

  it("does not inspect broad directory grep for protected descendants", () => {
    const { workspace } = fixture();
    const runtime = state(workspace);
    writeFileSync(join(workspace, ".env"), "secret");
    expect(decide(runtime, workspace, "grep").kind).toBe("allow");
  });

  it("records protected explicit directory read grants as exact subtrees", () => {
    const { root, workspace, outside } = fixture();
    const runtime = state(workspace);
    const home = join(root, "home");
    const ssh = join(home, ".ssh");
    const credential = join(ssh, "id_rsa");
    mkdirSync(home);
    mkdirSync(ssh);
    writeFileSync(credential, "secret");

    const protectedGrant = prepareExplicitFilesystemGrant({
      path: "~/.ssh",
      cwd: workspace,
      access: "read",
      supportedMac: true,
      state: runtime,
      pathCompatibility: { homeDir: home },
    })!;
    expect(protectedGrant).toMatchObject({
      path: canonicalizeTarget(ssh, workspace),
      kind: "directory",
      effects: ["outside-boundary", "protected-read"],
    });
    expect(filesystemScope(protectedGrant)).toBe(
      `${canonicalizeTarget(ssh, workspace)}/**`,
    );
    const canonicalCredential = canonicalizeTarget(credential, workspace);
    const canonicalSibling = canonicalizeTarget(
      join(home, "sibling"),
      workspace,
    );
    runtime.addGrant(protectedGrant);
    expect(runtime.allowsReachability(canonicalCredential, "read")).toBe(true);
    expect(runtime.allowsProtectedRead(canonicalCredential)).toBe(true);
    expect(runtime.allowsReachability(canonicalSibling, "read")).toBe(false);
    expect(runtime.allowsProtectedRead(canonicalSibling)).toBe(false);

    const ordinary = prepareExplicitFilesystemGrant({
      path: outside,
      cwd: workspace,
      access: "read",
      supportedMac: true,
      state: runtime,
    });
    expect(ordinary).toMatchObject({
      kind: "directory",
      effects: ["outside-boundary"],
    });
  });

  it("only prepares existing exact files or directory scopes for explicit grants", () => {
    const { workspace, outside } = fixture();
    const runtime = state(workspace);
    const file = join(outside, "file.txt");
    writeFileSync(file, "outside");

    expect(
      prepareExplicitFilesystemGrant({
        path: file,
        cwd: workspace,
        access: "read",
        supportedMac: true,
        state: runtime,
      }),
    ).toMatchObject({
      path: canonicalizeTarget(file, workspace),
      kind: "file",
      effects: ["outside-boundary"],
    });
    expect(
      prepareExplicitFilesystemGrant({
        path: join(outside, "missing"),
        cwd: workspace,
        access: "read",
        supportedMac: true,
        state: runtime,
      }),
    ).toBeNull();
    expect(
      prepareExplicitFilesystemGrant({
        path: file,
        cwd: workspace,
        access: "read",
        supportedMac: false,
        state: runtime,
      }),
    ).toBeNull();
  });
});
