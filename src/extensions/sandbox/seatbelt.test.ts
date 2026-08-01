import { describe, expect, it } from "vitest";
import type { SandboxPolicy } from "./policy.js";
import {
  SANDBOX_EXECUTABLE,
  SANDBOX_PROFILE,
  sandboxArguments,
  sandboxParameters,
} from "./seatbelt.js";

const policy: SandboxPolicy = {
  sessionCwd: "/workspace",
  workspaceRoot: "/workspace",
  temporaryRoots: ["/temporary"],
  cacheRoots: [],
  writableRoots: ["/workspace", "/temporary"],
};

describe("Sandbox Seatbelt profile", () => {
  it("is deny-default while retaining read, network, and process compatibility", () => {
    expect(SANDBOX_PROFILE).toContain("(deny default)");
    expect(SANDBOX_PROFILE).toContain("(allow file-read*)");
    expect(SANDBOX_PROFILE).toContain("(allow network*)");
    expect(SANDBOX_PROFILE).toContain("(allow process-exec)");
    expect(SANDBOX_PROFILE).toContain(
      '(global-name "com.apple.system.opendirectoryd.libinfo")',
    );
    expect(SANDBOX_PROFILE).not.toContain("(allow mach-lookup)");
    expect(SANDBOX_PROFILE).toContain('(literal (param "root0"))');
    expect(SANDBOX_PROFILE).toContain('(subpath (param "root0"))');
    expect(SANDBOX_PROFILE).not.toContain("/workspace");
  });

  it("uses stable, separate parameter arguments and stdin shell launch", () => {
    const args = sandboxArguments({
      policy,
      shell: { shell: "/bin/bash", args: ["-s"] },
    });
    expect(SANDBOX_EXECUTABLE).toBe("/usr/bin/sandbox-exec");
    expect(args.slice(0, 4)).toEqual([
      "-D",
      "root0=/workspace",
      "-D",
      "root1=/temporary",
    ]);
    expect(args).toEqual(
      expect.arrayContaining(["-p", SANDBOX_PROFILE, "/bin/bash", "-s"]),
    );
    const parameterValues = args
      .filter((value, index) => args[index - 1] === "-D")
      .map((value) => value.slice(value.indexOf("=") + 1));
    expect(parameterValues).toHaveLength(16);
    expect(
      parameterValues.every((value) => policy.writableRoots.includes(value)),
    ).toBe(true);
  });

  it("rejects malformed roots before launch", () => {
    expect(() => sandboxParameters(["relative"])).toThrow(
      "invalid writable roots",
    );
    expect(() => sandboxParameters(["/one", "/one"])).toThrow(
      "invalid writable roots",
    );
  });
});
