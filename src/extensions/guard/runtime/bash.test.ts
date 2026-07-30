import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  existsSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FixedCapabilities } from "../capabilities.js";
import { createGuardRuntimeState } from "../state.js";
import { createGuardBashRuntime } from "./bash.js";

const directories: string[] = [];

afterEach(() => {
  while (directories.length) {
    rmSync(directories.pop()!, { recursive: true, force: true });
  }
});

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

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pipkin-guard-bash-"));
  directories.push(root);
  const workspace = join(root, "workspace");
  const outside = join(root, "outside.txt");
  const log = join(root, "log.json");
  const childPid = join(root, "child.pid");
  const configPath = join(root, "config-path");
  const binary = join(root, "pipkin-nono");
  mkdirSync(workspace);
  writeFileSync(outside, "outside");
  writeFileSync(
    binary,
    `#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const config = args[args.indexOf("--config") + 1];
if (process.env.PIPKIN_GUARD_BASH_MODE === "hold") {
  const child = (await import("node:child_process")).spawn(process.execPath, ["-e", "setInterval(() => {}, 1_000)"], { stdio: "ignore" });
  writeFileSync(process.env.PIPKIN_GUARD_BASH_CHILD_PID, String(child.pid));
  writeFileSync(process.env.PIPKIN_GUARD_BASH_CONFIG, config);
  setInterval(() => process.stdout.write("guard output\\n"), 10);
} else {
  writeFileSync(process.env.PIPKIN_GUARD_BASH_LOG, JSON.stringify({ manifest: JSON.parse(readFileSync(config, "utf8")), cwd: process.cwd(), session: process.env.PI_SESSION_FILE }));
  process.stdout.write("guard output\\n");
}
`,
    { mode: 0o700 },
  );
  chmodSync(binary, 0o700);
  const state = createGuardRuntimeState();
  const fixed: FixedCapabilities = {
    cwd: workspace,
    grants: [
      { path: workspace, access: "read", kind: "directory", effects: [] },
      { path: workspace, access: "write", kind: "directory", effects: [] },
    ],
  };
  state.setFixedCapabilities(fixed);
  state.setBackendHealth({ kind: "healthy", path: binary });
  return { binary, childPid, configPath, log, outside, state, workspace };
}

describe("Guard Bash runtime", () => {
  it("uses current reachability grants in an unrestricted Nono manifest and preserves factory environment", async () => {
    const { log, outside, state, workspace } = fixture();
    state.addGrant({
      path: outside,
      access: "read",
      kind: "file",
      effects: ["outside-boundary"],
    });
    state.addGrant({
      path: join(workspace, ".env"),
      access: "read",
      kind: "file",
      effects: ["protected-read"],
    });
    const runtime = createGuardBashRuntime({ state, supportedMac: true });
    const output: string[] = [];
    const previous = process.env.PIPKIN_GUARD_BASH_LOG;
    process.env.PIPKIN_GUARD_BASH_LOG = log;
    try {
      await expect(
        runtime.agentOperations.exec("echo guarded", workspace, {
          onData: (data) => output.push(data.toString()),
          env: { ...process.env, PI_SESSION_FILE: "/session.jsonl" },
        }),
      ).resolves.toEqual({ exitCode: 0 });
    } finally {
      if (previous === undefined) {
        delete process.env.PIPKIN_GUARD_BASH_LOG;
      } else {
        process.env.PIPKIN_GUARD_BASH_LOG = previous;
      }
    }
    expect(output.join("")).toContain("guard output");
    const logged = JSON.parse(readFileSync(log, "utf8")) as {
      manifest: {
        filesystem: { grants: Array<{ path: string }> };
        network: unknown;
      };
      cwd: string;
      session: string;
    };
    expect(logged.cwd).toBe(realpathSync(workspace));
    expect(logged.session).toBe("/session.jsonl");
    expect(logged.manifest.network).toEqual({ mode: "unrestricted" });
    expect(
      logged.manifest.filesystem.grants.map((grant) => grant.path),
    ).toContain(outside);
    expect(
      logged.manifest.filesystem.grants.map((grant) => grant.path),
    ).not.toContain(join(workspace, ".env"));
  });

  it("rejects invalid timeouts before staging or starting Nono", async () => {
    const { configPath, log, state, workspace } = fixture();
    const runtime = createGuardBashRuntime({ state, supportedMac: true });
    const execution = {
      onData: () => undefined,
      env: {
        ...process.env,
        PIPKIN_GUARD_BASH_LOG: log,
        PIPKIN_GUARD_BASH_CONFIG: configPath,
      },
    };

    for (const timeout of [0, -1, 2_147_483.648]) {
      await expect(
        runtime.agentOperations.exec("echo guarded", workspace, {
          ...execution,
          timeout,
        }),
      ).rejects.toThrow("Invalid timeout");
    }
    expect(existsSync(log)).toBe(false);
    expect(existsSync(configPath)).toBe(false);
  });

  it("waits for abort, timeout, and shutdown termination before cleaning staging", async () => {
    const { childPid, configPath, state, workspace } = fixture();
    const runtime = createGuardBashRuntime({ state, supportedMac: true });
    const environment = {
      ...process.env,
      PIPKIN_GUARD_BASH_MODE: "hold",
      PIPKIN_GUARD_BASH_CHILD_PID: childPid,
      PIPKIN_GUARD_BASH_CONFIG: configPath,
    };

    const aborted = new AbortController();
    const abortRun = runtime.agentOperations.exec("echo guarded", workspace, {
      onData: () => undefined,
      env: environment,
      signal: aborted.signal,
    });
    await waitForFile(childPid);
    const abortChild = Number(readFileSync(childPid, "utf8"));
    const abortStaging = dirname(readFileSync(configPath, "utf8"));
    aborted.abort();
    await expect(abortRun).rejects.toThrow("aborted");
    expect(processExists(abortChild)).toBe(false);
    expect(existsSync(abortStaging)).toBe(false);

    rmSync(childPid, { force: true });
    const timeoutRun = runtime.agentOperations.exec("echo guarded", workspace, {
      onData: () => undefined,
      env: environment,
      timeout: 1,
    });
    await waitForFile(childPid);
    const timeoutChild = Number(readFileSync(childPid, "utf8"));
    const timeoutStaging = dirname(readFileSync(configPath, "utf8"));
    await expect(timeoutRun).rejects.toThrow("timeout:1");
    expect(processExists(timeoutChild)).toBe(false);
    expect(existsSync(timeoutStaging)).toBe(false);

    rmSync(childPid, { force: true });
    const shutdownRun = runtime.agentOperations.exec(
      "echo guarded",
      workspace,
      {
        onData: () => undefined,
        env: environment,
      },
    );
    await waitForFile(childPid);
    const shutdownChild = Number(readFileSync(childPid, "utf8"));
    const shutdownStaging = dirname(readFileSync(configPath, "utf8"));
    await runtime.dispose();
    await expect(shutdownRun).rejects.toThrow("aborted");
    expect(processExists(shutdownChild)).toBe(false);
    expect(existsSync(shutdownStaging)).toBe(false);
    await expect(runtime.dispose()).resolves.toBeUndefined();
  });

  it("blocks agent Bash but retains trusted local user Bash while Nono is tools-only or the boundary is off", async () => {
    const { state, workspace } = fixture();
    state.setBackendHealth({ kind: "tools-only", reason: "missing" });
    const runtime = createGuardBashRuntime({ state, supportedMac: true });
    await expect(
      runtime.agentOperations.exec("echo blocked", workspace, {
        onData: () => undefined,
      }),
    ).rejects.toThrow("Bash is unavailable");
    for (const boundaryEnabled of [true, false]) {
      state.setBoundaryEnabled(boundaryEnabled);
      const output: string[] = [];
      await expect(
        runtime.userOperations.exec("printf user", workspace, {
          onData: (data) => output.push(data.toString()),
        }),
      ).resolves.toEqual({ exitCode: 0 });
      expect(output.join("")).toBe("user");
    }
  });
});
