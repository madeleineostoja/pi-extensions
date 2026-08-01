import { describe, expect, it } from "vitest";
import type { SandboxPolicy } from "./policy.js";
import {
  SANDBOX_EXECUTABLE,
  SANDBOX_PROFILE,
  sandboxArguments,
  sandboxParameters,
  sandboxProfile,
} from "./seatbelt.js";

const policy: SandboxPolicy = {
  sessionCwd: "/workspace",
  workspaceRoot: "/workspace",
  temporaryRoots: ["/temporary"],
  cacheRoots: ["/home/user/cache/store"],
  writableRoots: ["/workspace", "/temporary", "/home/user/cache/store"],
  creationRoots: ["/home/user/cache"],
};

describe("Sandbox Seatbelt profile", () => {
  it("is deny-default with narrowed process, device, shared-memory, and network compatibility", () => {
    expect(SANDBOX_PROFILE).toContain("(deny default)");
    expect(SANDBOX_PROFILE).toContain("(allow file-read*)");
    expect(SANDBOX_PROFILE).toContain("(allow network*)");
    expect(SANDBOX_PROFILE).toContain("(allow process-exec)");
    expect(SANDBOX_PROFILE).toContain(
      '(global-name "com.apple.system.opendirectoryd.libinfo")',
    );
    expect(SANDBOX_PROFILE).toContain(
      '(allow file-ioctl (regex #"^/dev/ttys[0-9]+"))',
    );
    expect(SANDBOX_PROFILE).toContain(
      '(ipc-posix-name-regex #"^/__KMP_REGISTERED_LIB_[0-9]+$")',
    );
    expect(SANDBOX_PROFILE).not.toContain('(import "system.sb")');
    expect(SANDBOX_PROFILE).not.toContain("(allow file-ioctl)\n");
    expect(SANDBOX_PROFILE).not.toContain("(allow ipc-posix-shm)\n");
  });

  it("generates parameterized recursive and exact creation authority", () => {
    const profile = sandboxProfile(policy);
    expect(profile).toContain('(literal (param "root0"))');
    expect(profile).toContain('(subpath (param "root0"))');
    expect(profile).toContain('(literal (param "create0"))');
    expect(profile).not.toContain("/workspace");
    expect(profile).not.toContain("/home/user/cache");
  });

  it("uses stable, separate parameter arguments and stdin shell launch", () => {
    const args = sandboxArguments({
      policy,
      shell: { shell: "/bin/bash", args: ["-s"] },
    });
    expect(SANDBOX_EXECUTABLE).toBe("/usr/bin/sandbox-exec");
    expect(args.slice(0, 8)).toEqual([
      "-D",
      "root0=/workspace",
      "-D",
      "root1=/temporary",
      "-D",
      "root2=/home/user/cache/store",
      "-D",
      "create0=/home/user/cache",
    ]);
    expect(args).toEqual(
      expect.arrayContaining(["-p", sandboxProfile(policy), "/bin/bash", "-s"]),
    );
    expect(
      args.filter((value, index) => args[index - 1] === "-D"),
    ).toHaveLength(4);
  });

  it("rejects malformed roots and unrelated creation grants before launch", () => {
    expect(() => sandboxParameters(["relative"])).toThrow(
      "invalid writable roots",
    );
    expect(() => sandboxParameters(["/one", "/one"])).toThrow(
      "invalid writable roots",
    );
    expect(() =>
      sandboxArguments({
        policy: { ...policy, creationRoots: ["/unrelated"] },
        shell: { shell: "/bin/bash", args: ["-s"] },
      }),
    ).toThrow("invalid writable roots");
  });
});
