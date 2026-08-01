import {
  chmodSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSandboxBashRuntime } from "./bash.js";
import type { SandboxPolicy } from "./policy.js";

const directories: string[] = [];

afterEach(() => {
  while (directories.length) {
    rmSync(directories.pop()!, { force: true, recursive: true });
  }
});

function fixture() {
  const workspace = mkdtempSync(join(tmpdir(), "pipkin-sandbox-bash-"));
  directories.push(workspace);
  const executable = join(workspace, "sandbox-exec");
  writeFileSync(
    executable,
    `#!/usr/bin/env node
import { spawn } from "node:child_process";
const args = process.argv.slice(2);
const separator = args.indexOf("--");
const child = spawn(args[separator + 1], args.slice(separator + 2), { stdio: "inherit" });
child.once("close", (code) => process.exit(code ?? 1));
`,
    { mode: 0o700 },
  );
  chmodSync(executable, 0o700);
  const policy: SandboxPolicy = {
    sessionCwd: workspace,
    workspaceRoot: workspace,
    temporaryRoots: [],
    cacheRoots: [],
    writableRoots: [workspace],
  };
  return { executable, policy, workspace };
}

describe("Sandbox Bash runtime", () => {
  it("uses stdin command transport and preserves streaming cwd and environment", async () => {
    const { executable, policy, workspace } = fixture();
    const runtime = createSandboxBashRuntime({
      policy,
      enabled: () => true,
      supportedMac: true,
      sandboxExecutable: executable,
    });
    const output: string[] = [];
    await expect(
      runtime.operations.exec(
        'printf "%s:%s" "$PIPKIN_SANDBOX_TEST" "$PWD"',
        workspace,
        {
          onData: (data) => output.push(data.toString()),
          env: { PIPKIN_SANDBOX_TEST: "forwarded" },
        },
      ),
    ).resolves.toEqual({ exitCode: 0 });
    expect(output.join("")).toBe(`forwarded:${realpathSync(workspace)}`);
  });

  it("does not fall back to local execution when enabled launch fails", async () => {
    const { policy, workspace } = fixture();
    const runtime = createSandboxBashRuntime({
      policy,
      enabled: () => true,
      supportedMac: true,
      sandboxExecutable: join(workspace, "missing-sandbox-exec"),
    });
    await expect(
      runtime.operations.exec("printf local", workspace, {
        onData: () => undefined,
      }),
    ).rejects.toThrow("Sandbox: launch failed");
  });

  it("selects ordinary local operations only when explicitly off or unsupported", async () => {
    const { policy, workspace } = fixture();
    for (const options of [
      { enabled: () => false, supportedMac: true },
      { enabled: () => true, supportedMac: false },
    ]) {
      const runtime = createSandboxBashRuntime({ policy, ...options });
      const output: string[] = [];
      await expect(
        runtime.operations.exec("printf local", workspace, {
          onData: (data) => output.push(data.toString()),
        }),
      ).resolves.toEqual({ exitCode: 0 });
      expect(output.join("")).toBe("local");
    }
  });
});
