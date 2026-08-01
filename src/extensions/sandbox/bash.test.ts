import {
  chmodSync,
  existsSync,
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

async function waitForFile(path: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (existsSync(path)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${path}`);
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

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
if (process.env.PIPKIN_SANDBOX_BACKEND_REJECT === "true") {
  process.stderr.write("sandbox-exec: invalid profile\\n");
  process.exit(70);
}
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

  it("transports multiline and large commands without exposing the launch marker", async () => {
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
        `printf first
yes x | head -c 16384
printf last`,
        workspace,
        { onData: (data) => output.push(data.toString()) },
      ),
    ).resolves.toEqual({ exitCode: 0 });
    const text = output.join("");
    expect(text.startsWith("first")).toBe(true);
    expect(text.endsWith("last")).toBe(true);
    expect(text).not.toContain("__PIPKIN_SANDBOX_LAUNCHED__");
    expect(text.length).toBeGreaterThan(16_384);
  });

  it("preserves ordinary nonzero shell exits, including sandbox-exec statuses", async () => {
    const { executable, policy, workspace } = fixture();
    const runtime = createSandboxBashRuntime({
      policy,
      enabled: () => true,
      supportedMac: true,
      sandboxExecutable: executable,
    });
    for (const code of [1, 64, 65, 70]) {
      const output: string[] = [];
      await expect(
        runtime.operations.exec(
          `printf exit-${code}; exit ${code}`,
          workspace,
          {
            onData: (data) => output.push(data.toString()),
          },
        ),
      ).resolves.toEqual({ exitCode: code });
      expect(output.join("")).toBe(`exit-${code}`);
    }
  });

  it("reports an early sandbox-exec rejection without local fallback", async () => {
    const { executable, policy, workspace } = fixture();
    const runtime = createSandboxBashRuntime({
      policy,
      enabled: () => true,
      supportedMac: true,
      sandboxExecutable: executable,
    });
    await expect(
      runtime.operations.exec("printf local", workspace, {
        onData: () => undefined,
        env: { PIPKIN_SANDBOX_BACKEND_REJECT: "true" },
      }),
    ).rejects.toThrow("sandbox-exec rejected the launch");
  });

  it("terminates protected operations on timeout and abort", async () => {
    const { executable, policy, workspace } = fixture();
    const runtime = createSandboxBashRuntime({
      policy,
      enabled: () => true,
      supportedMac: true,
      sandboxExecutable: executable,
    });
    await expect(
      runtime.operations.exec("sleep 10", workspace, {
        onData: () => undefined,
        timeout: 0.01,
      }),
    ).rejects.toThrow("timeout:0.01");
    const controller = new AbortController();
    const aborted = runtime.operations.exec("sleep 10", workspace, {
      onData: () => undefined,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 10);
    await expect(aborted).rejects.toThrow("aborted");
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

  it("terminates local operations during disposal and rejects later calls", async () => {
    const { policy, workspace } = fixture();
    const childPid = join(workspace, "child.pid");
    const runtime = createSandboxBashRuntime({
      policy,
      enabled: () => false,
      supportedMac: true,
    });
    const childProgram = `const { writeFileSync } = require("node:fs"); writeFileSync(process.env.PIPKIN_SANDBOX_CHILD_PID, String(process.pid)); setInterval(() => {}, 1_000);`;
    const run = runtime.operations.exec(
      `${JSON.stringify(process.execPath)} -e ${JSON.stringify(childProgram)}`,
      workspace,
      {
        onData: () => undefined,
        env: { PIPKIN_SANDBOX_CHILD_PID: childPid },
      },
    );
    await waitForFile(childPid);
    const pid = Number(
      (await import("node:fs")).readFileSync(childPid, "utf8"),
    );
    await runtime.dispose();
    await expect(run).rejects.toThrow("aborted");
    expect(processExists(pid)).toBe(false);
    await expect(runtime.dispose()).resolves.toBeUndefined();
    await expect(
      runtime.operations.exec("printf after", workspace, {
        onData: () => undefined,
      }),
    ).rejects.toThrow("shutting down");
  });

  it("rejects failed macOS initialization until Sandbox is explicitly off", async () => {
    const { workspace } = fixture();
    const runtime = createSandboxBashRuntime({
      enabled: () => true,
      supportedMac: true,
      unavailableReason: "Sandbox: policy resolution failed.",
    });
    await expect(
      runtime.operations.exec("printf blocked", workspace, {
        onData: () => undefined,
      }),
    ).rejects.toThrow("policy resolution failed");
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
