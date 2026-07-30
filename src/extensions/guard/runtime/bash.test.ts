import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pipkin-guard-bash-"));
  directories.push(root);
  const workspace = join(root, "workspace");
  const outside = join(root, "outside.txt");
  const log = join(root, "log.json");
  const binary = join(root, "pipkin-nono");
  mkdirSync(workspace);
  writeFileSync(outside, "outside");
  writeFileSync(
    binary,
    `#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const config = args[args.indexOf("--config") + 1];
writeFileSync(process.env.PIPKIN_GUARD_BASH_LOG, JSON.stringify({ manifest: JSON.parse(readFileSync(config, "utf8")), cwd: process.cwd(), session: process.env.PI_SESSION_FILE }));
process.stdout.write("guard output\\n");
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
  return { binary, log, outside, state, workspace };
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

  it("blocks agent Bash but retains trusted local user Bash while Nono is tools-only", async () => {
    const { state, workspace } = fixture();
    state.setBackendHealth({ kind: "tools-only", reason: "missing" });
    const runtime = createGuardBashRuntime({ state, supportedMac: true });
    await expect(
      runtime.agentOperations.exec("echo blocked", workspace, {
        onData: () => undefined,
      }),
    ).rejects.toThrow("Bash is unavailable");
    const output: string[] = [];
    await expect(
      runtime.userOperations.exec("printf user", workspace, {
        onData: (data) => output.push(data.toString()),
      }),
    ).resolves.toEqual({ exitCode: 0 });
    expect(output.join("")).toBe("user");
  });
});
