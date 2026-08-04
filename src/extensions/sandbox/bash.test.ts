import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { createBashToolDefinition } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import {
  createSandboxBashDefinition,
  createSandboxBashRuntime,
} from "./bash.js";
import type { SandboxDenialObserver } from "./denial-observer.js";
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

async function waitForProcessExit(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (!processExists(pid)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for process ${pid} to exit`);
}

function executionEnv(values: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { ...process.env, ...values };
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
if (process.env.PIPKIN_SANDBOX_BACKEND_SILENT_EXIT === "true") {
  process.exit(71);
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
    dependencyRoots: [],
    writableRoots: [workspace],
    creationRoots: [],
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
          env: executionEnv({ PIPKIN_SANDBOX_TEST: "forwarded" }),
        },
      ),
    ).resolves.toEqual({ exitCode: 0 });
    expect(output.join("")).toBe(`forwarded:${realpathSync(workspace)}`);
  });

  it("disables optional Git locks only for protected launches unless explicitly configured", async () => {
    const { executable, policy, workspace } = fixture();
    const protectedRuntime = createSandboxBashRuntime({
      policy,
      enabled: () => true,
      supportedMac: true,
      sandboxExecutable: executable,
    });
    const inheritedEnv = executionEnv();
    delete inheritedEnv.GIT_OPTIONAL_LOCKS;
    for (const [env, expected] of [
      [inheritedEnv, "0"],
      [executionEnv({ GIT_OPTIONAL_LOCKS: "1" }), "1"],
    ] as const) {
      const output: string[] = [];
      await protectedRuntime.operations.exec(
        'printf "%s" "${GIT_OPTIONAL_LOCKS-unset}"',
        workspace,
        {
          onData: (data) => output.push(data.toString()),
          env,
        },
      );
      expect(output.join("")).toBe(expected);
    }

    const localRuntime = createSandboxBashRuntime({
      policy,
      enabled: () => false,
      supportedMac: true,
    });
    const localOutput: string[] = [];
    await localRuntime.operations.exec(
      'printf "%s" "${GIT_OPTIONAL_LOCKS-unset}"',
      workspace,
      {
        onData: (data) => localOutput.push(data.toString()),
        env: inheritedEnv,
      },
    );
    expect(localOutput.join("")).toBe("unset");
  });

  it("appends an active kernel denial to native Bash output", async () => {
    const { executable, policy, workspace } = fixture();
    const observer: SandboxDenialObserver = {
      start: () => undefined,
      registerBashInvocation(_marker, onWriteDenial) {
        onWriteDenial?.({
          process: "touch",
          pid: 42,
          operation: "file-write-create",
          path: "/tmp/blocked",
        });
        return () => undefined;
      },
      dispose: async () => undefined,
    };
    const output: Buffer[] = [];
    const runtime = createSandboxBashRuntime({
      policy,
      enabled: () => true,
      supportedMac: true,
      sandboxExecutable: executable,
      denialObserver: observer,
    });
    await runtime.operations.exec("printf done", workspace, {
      onData: (data) => output.push(data),
    });
    expect(Buffer.concat(output).toString()).toContain(
      "the active repository-write Sandbox blocked file-write-create /tmp/blocked",
    );
    expect(Buffer.concat(output).toString()).toContain("allowed writable root");
  });

  it("registers a unique kernel-report marker for each protected Bash invocation", async () => {
    const { executable, policy, workspace } = fixture();
    const markers: string[] = [];
    const releases: string[] = [];
    const observer: SandboxDenialObserver = {
      start: () => undefined,
      registerBashInvocation(marker) {
        markers.push(marker);
        return () => releases.push(marker);
      },
      dispose: async () => undefined,
    };
    const runtime = createSandboxBashRuntime({
      policy,
      enabled: () => true,
      supportedMac: true,
      sandboxExecutable: executable,
      denialObserver: observer,
    });
    for (const command of ["printf first", "printf second"]) {
      await runtime.operations.exec(command, workspace, {
        onData: () => undefined,
      });
    }
    expect(markers).toHaveLength(2);
    expect(new Set(markers).size).toBe(2);
    expect(
      markers.every((marker) => /^PIPKIN_[A-Fa-f0-9]+$/.test(marker)),
    ).toBe(true);
    expect(releases).toEqual(markers);
  });

  it("mirrors Pi native Bash metadata while replacing execution", async () => {
    const { executable, policy, workspace } = fixture();
    const runtime = createSandboxBashRuntime({
      policy,
      enabled: () => true,
      supportedMac: true,
      sandboxExecutable: executable,
    });
    const sandbox = createSandboxBashDefinition(workspace, runtime);
    const native = createBashToolDefinition(workspace);

    expect(sandbox).toMatchObject({
      name: native.name,
      label: native.label,
      description: native.description,
      parameters: native.parameters,
      promptSnippet: native.promptSnippet,
      promptGuidelines: native.promptGuidelines,
    });
  });

  it("preserves Pi Bash partial updates and final result semantics", async () => {
    const { executable, policy, workspace } = fixture();
    const runtime = createSandboxBashRuntime({
      policy,
      enabled: () => true,
      supportedMac: true,
      sandboxExecutable: executable,
    });
    const definition = createSandboxBashDefinition(workspace, runtime);
    const updates: Array<{ content: Array<{ type: string; text?: string }> }> =
      [];
    const result = await definition.execute(
      "sandbox-call",
      { command: "printf first; sleep 0.15; printf second" },
      undefined,
      (update) => updates.push(update),
      {
        sessionManager: {
          getSessionFile: () => undefined,
          getSessionId: () => "test-session",
        },
      } as never,
    );
    expect(updates[0]).toEqual({ content: [], details: undefined });
    expect(updates.some((update) => update.content[0]?.text === "first")).toBe(
      true,
    );
    expect(result).toMatchObject({
      content: [{ type: "text", text: "firstsecond" }],
    });
  });

  it("preserves shell startup output without exposing the launch marker", async () => {
    const { executable, policy, workspace } = fixture();
    const bashEnv = join(workspace, "bash-env");
    writeFileSync(bashEnv, "printf startup\n");
    const runtime = createSandboxBashRuntime({
      policy,
      enabled: () => true,
      supportedMac: true,
      sandboxExecutable: executable,
    });
    const output: string[] = [];
    await expect(
      runtime.operations.exec("printf command", workspace, {
        onData: (data) => output.push(data.toString()),
        env: executionEnv({ BASH_ENV: bashEnv }),
      }),
    ).resolves.toEqual({ exitCode: 0 });
    expect(output.join("")).toBe("startupcommand");
    expect(output.join("")).not.toContain("__PIPKIN_SANDBOX_LAUNCHED__");
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

  it("bounds idle output draining after the sandbox process exits", async () => {
    const { policy, workspace } = fixture();
    const child = new EventEmitter();
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    Object.assign(child, { stdin, stdout, stderr });
    const runtime = createSandboxBashRuntime({
      policy,
      enabled: () => true,
      supportedMac: true,
      outputDrainTimeoutMs: 20,
      spawn: () => {
        queueMicrotask(() => {
          stdout.write("__PIPKIN_SANDBOX_LAUNCHED__\ndone");
          child.emit("exit", 0);
          setTimeout(() => stdout.write(" and"), 10);
          setTimeout(() => stdout.write(" drained"), 25);
        });
        return child as never;
      },
    });
    const output: string[] = [];
    await expect(
      runtime.operations.exec("printf ignored", workspace, {
        onData: (data) => output.push(data.toString()),
      }),
    ).resolves.toEqual({ exitCode: 0 });
    expect(output.join("")).toBe("done and drained");
    expect(stdout.destroyed).toBe(true);
    expect(stderr.destroyed).toBe(true);
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

  it("preserves Pi's prepared execution environment", async () => {
    const { executable, policy, workspace } = fixture();
    const inheritedSessionId = process.env.PI_SESSION_ID;
    process.env.PI_SESSION_ID = "inherited-session";
    try {
      const runtime = createSandboxBashRuntime({
        policy,
        enabled: () => true,
        supportedMac: true,
        sandboxExecutable: executable,
      });
      await expect(
        runtime.operations.exec('test -z "$PI_SESSION_ID"', workspace, {
          onData: () => undefined,
          env: { PATH: process.env.PATH ?? "" },
        }),
      ).resolves.toEqual({ exitCode: 0 });
    } finally {
      if (inheritedSessionId === undefined) {
        delete process.env.PI_SESSION_ID;
      } else {
        process.env.PI_SESSION_ID = inheritedSessionId;
      }
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
        env: executionEnv({ PIPKIN_SANDBOX_BACKEND_REJECT: "true" }),
      }),
    ).rejects.toThrow("sandbox-exec rejected the launch");
  });

  it("reports a silent exit before shell startup as a Sandbox launch failure", async () => {
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
        env: executionEnv({ PIPKIN_SANDBOX_BACKEND_SILENT_EXIT: "true" }),
      }),
    ).rejects.toThrow(
      "Sandbox: sandbox-exec exited before shell startup: exit code 71",
    );
  });

  it("rejects invalid and already-aborted protected operations before launch", async () => {
    const { policy, workspace } = fixture();
    const runtime = createSandboxBashRuntime({
      policy,
      enabled: () => true,
      supportedMac: true,
      sandboxExecutable: join(workspace, "missing-sandbox-exec"),
    });
    for (const timeout of [0, -1, Infinity, 2_147_483.648]) {
      await expect(
        runtime.operations.exec("printf never", workspace, {
          onData: () => undefined,
          timeout,
        }),
      ).rejects.toThrow("Invalid timeout");
    }
    const controller = new AbortController();
    controller.abort();
    await expect(
      runtime.operations.exec("printf never", workspace, {
        onData: () => undefined,
        signal: controller.signal,
      }),
    ).rejects.toThrow("aborted");
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

  it("terminates protected descendants during disposal", async () => {
    const { executable, policy, workspace } = fixture();
    const childPid = join(workspace, "protected-child.pid");
    const runtime = createSandboxBashRuntime({
      policy,
      enabled: () => true,
      supportedMac: true,
      sandboxExecutable: executable,
    });
    const childProgram = `const { writeFileSync } = require("node:fs"); writeFileSync(process.env.PIPKIN_SANDBOX_CHILD_PID, String(process.pid)); setInterval(() => {}, 1_000);`;
    const run = runtime.operations.exec(
      `${JSON.stringify(process.execPath)} -e ${JSON.stringify(childProgram)}`,
      workspace,
      {
        onData: () => undefined,
        env: executionEnv({ PIPKIN_SANDBOX_CHILD_PID: childPid }),
      },
    );
    await waitForFile(childPid);
    const pid = Number(
      (await import("node:fs")).readFileSync(childPid, "utf8"),
    );
    await runtime.dispose();
    await expect(run).rejects.toThrow("aborted");
    await waitForProcessExit(pid);
    await expect(runtime.dispose()).resolves.toBeUndefined();
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
        env: executionEnv({ PIPKIN_SANDBOX_CHILD_PID: childPid }),
      },
    );
    await waitForFile(childPid);
    const pid = Number(
      (await import("node:fs")).readFileSync(childPid, "utf8"),
    );
    await runtime.dispose();
    await expect(run).rejects.toThrow("aborted");
    await waitForProcessExit(pid);
    await expect(runtime.dispose()).resolves.toBeUndefined();
    await expect(
      runtime.operations.exec("printf after", workspace, {
        onData: () => undefined,
      }),
    ).rejects.toThrow("shutting down");
  });

  it("rejects failed macOS initialization until Sandbox is explicitly off", async () => {
    const { workspace } = fixture();
    let enabled = true;
    const runtime = createSandboxBashRuntime({
      enabled: () => enabled,
      supportedMac: true,
      unavailableReason: "Sandbox: policy resolution failed.",
    });
    await expect(
      runtime.operations.exec("printf blocked", workspace, {
        onData: () => undefined,
      }),
    ).rejects.toThrow("policy resolution failed");
    enabled = false;
    const output: string[] = [];
    await expect(
      runtime.operations.exec("printf local", workspace, {
        onData: (data) => output.push(data.toString()),
      }),
    ).resolves.toEqual({ exitCode: 0 });
    expect(output.join("")).toBe("local");
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

  it("uses the same repository-read-only profile for ordinary and managed launches", async () => {
    const { executable, policy, workspace } = fixture();
    const arguments_: string[][] = [];
    const runtime = createSandboxBashRuntime({
      policy: {
        ...policy,
        temporaryRoots: ["/tmp"],
        writableRoots: [workspace, "/tmp"],
      },
      enabled: () => true,
      repositoryReadOnly: () => true,
      supportedMac: true,
      sandboxExecutable: executable,
      spawn: (command, args, options) => {
        arguments_.push([...args]);
        return spawn(command, args, options);
      },
    });
    const ctx = {
      sessionManager: {
        getSessionId: () => "shared-session",
        getSessionFile: () => undefined,
      },
    } as never;
    const definition = createSandboxBashDefinition(workspace, runtime);

    await definition.execute(
      "foreground-readonly",
      { command: "printf foreground" },
      undefined,
      undefined,
      ctx,
    );
    const lease = await runtime.startManaged({
      toolCallId: "managed-readonly",
      command: "printf managed",
      cwd: workspace,
      ctx,
      signal: undefined,
      onOutput: () => undefined,
    });
    await lease.completion;

    expect(arguments_).toHaveLength(2);
    for (const args of arguments_) {
      const profile = args[args.indexOf("-p") + 1]!;
      expect(args).toEqual(
        expect.arrayContaining([
          "-D",
          "root0=/tmp",
          "-D",
          `protected0=${workspace}`,
        ]),
      );
      expect(profile).toContain('(literal (param "protected0"))');
      expect(profile).toContain('(subpath (param "protected0"))');
    }
    expect(arguments_[0]!.filter((value) => value.startsWith("root"))).toEqual(
      arguments_[1]!.filter((value) => value.startsWith("root")),
    );
    expect(
      arguments_[0]!.filter((value) => value.startsWith("protected")),
    ).toEqual(arguments_[1]!.filter((value) => value.startsWith("protected")));
  });

  it("gives public Bash and managed leases the same protected environment", async () => {
    const { executable, policy, workspace } = fixture();
    const runtime = createSandboxBashRuntime({
      policy,
      enabled: () => true,
      supportedMac: true,
      sandboxExecutable: executable,
    });
    const ctx = {
      model: { provider: "test-provider", id: "test-model" },
      thinkingLevel: "high",
      sessionManager: {
        getSessionId: () => "shared-session",
        getSessionFile: () => join(workspace, "session.jsonl"),
      },
    } as never;
    const sessionFile = join(workspace, "session.jsonl");
    const command = `test "$PI_SESSION_FILE" = ${JSON.stringify(sessionFile)} && printf "%s|%s|%s|%s|%s" "$GIT_OPTIONAL_LOCKS" "$PI_SESSION_ID" "$PI_PROVIDER" "$PI_MODEL" "$PI_REASONING_LEVEL"`;
    const definition = createSandboxBashDefinition(workspace, runtime);
    const foreground = await definition.execute(
      "foreground-call",
      { command },
      undefined,
      undefined,
      ctx,
    );
    const managedOutput: Buffer[] = [];
    const lease = await runtime.startManaged({
      toolCallId: "managed-call",
      command,
      cwd: workspace,
      ctx,
      signal: undefined,
      onOutput: ({ data }) => managedOutput.push(data),
    });
    await lease.completion;
    const expected = "0|shared-session|test-provider|test-model|high";
    expect(
      foreground.content[0]?.type === "text" ? foreground.content[0].text : "",
    ).toBe(expected);
    expect(Buffer.concat(managedOutput).toString()).toBe(expected);
  });

  it("starts managed local execution only after launch and preserves tagged streams", async () => {
    const { workspace } = fixture();
    const runtime = createSandboxBashRuntime({
      enabled: () => true,
      supportedMac: false,
    });
    const output: Array<{ stream: string; text: string }> = [];
    const lease = await runtime.startManaged({
      toolCallId: "managed-call",
      command: "printf out; printf err >&2",
      cwd: workspace,
      ctx: {
        sessionManager: {
          getSessionId: () => "managed-session",
          getSessionFile: () => undefined,
        },
      } as never,
      signal: undefined,
      onOutput: (event) =>
        output.push({
          stream: event.stream,
          text: event.data.toString(),
        }),
    });
    await expect(lease.completion).resolves.toMatchObject({
      exitCode: 0,
      termination: "natural",
      outputComplete: true,
    });
    expect(lease.pid).toBeGreaterThan(0);
    expect(output).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ stream: "stdout", text: "out" }),
        expect.objectContaining({ stream: "stderr", text: "err" }),
      ]),
    );
  });

  it("gives SIGKILL a fresh deadline when a managed child ignores SIGTERM", async () => {
    const { executable, policy, workspace } = fixture();
    const readyPath = join(workspace, "managed-ready");
    const runtime = createSandboxBashRuntime({
      policy,
      enabled: () => true,
      supportedMac: true,
      sandboxExecutable: executable,
      terminationWaitMs: 100,
    });
    const program = `const { writeFileSync } = require("node:fs"); process.on("SIGTERM", () => {}); writeFileSync(${JSON.stringify(readyPath)}, String(process.pid)); setInterval(() => {}, 1_000);`;
    const lease = await runtime.startManaged({
      toolCallId: "managed-stop",
      command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(program)}`,
      cwd: workspace,
      ctx: {
        sessionManager: {
          getSessionId: () => "managed-session",
          getSessionFile: () => undefined,
        },
      } as never,
      signal: undefined,
      onOutput: () => undefined,
    });
    await waitForFile(readyPath);
    const pid = Number(readFileSync(readyPath, "utf8"));
    await expect(lease.stop()).resolves.toMatchObject({
      termination: "stopped",
      outputComplete: true,
    });
    expect(processExists(pid)).toBe(false);
  });

  it("terminates a live managed process tree during runtime disposal", async () => {
    const { workspace } = fixture();
    const readyPath = join(workspace, "managed-tree");
    const runtime = createSandboxBashRuntime({
      enabled: () => false,
      supportedMac: false,
      terminationWaitMs: 250,
    });
    const descendant = "setInterval(() => {}, 1_000)";
    const program = `const { spawn } = require("node:child_process"); const { writeFileSync } = require("node:fs"); const child = spawn(process.execPath, ["-e", ${JSON.stringify(descendant)}], { stdio: "ignore" }); writeFileSync(${JSON.stringify(readyPath)}, process.pid + ":" + child.pid); setInterval(() => {}, 1_000);`;
    const lease = await runtime.startManaged({
      toolCallId: "managed-shutdown",
      command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(program)}`,
      cwd: workspace,
      ctx: {
        sessionManager: {
          getSessionId: () => "managed-session",
          getSessionFile: () => undefined,
        },
      } as never,
      signal: undefined,
      onOutput: () => undefined,
    });
    await waitForFile(readyPath);
    const [parentPid, descendantPid] = readFileSync(readyPath, "utf8")
      .split(":")
      .map(Number);
    await expect(runtime.dispose()).resolves.toBeUndefined();
    await expect(lease.completion).resolves.toMatchObject({
      termination: "shutdown",
    });
    expect(processExists(parentPid)).toBe(false);
    expect(processExists(descendantPid)).toBe(false);
    await expect(runtime.dispose()).resolves.toBeUndefined();
  });

  it("rejects managed spawn failure without an uncaught child error", async () => {
    const { workspace } = fixture();
    const runtime = createSandboxBashRuntime({
      enabled: () => true,
      supportedMac: false,
      spawn: () => {
        const child = new EventEmitter();
        Object.assign(child, {
          stdin: new PassThrough(),
          stdout: new PassThrough(),
          stderr: new PassThrough(),
        });
        queueMicrotask(() => child.emit("error", new Error("missing shell")));
        return child as never;
      },
    });
    await expect(
      runtime.startManaged({
        toolCallId: "managed-call",
        command: "printf never",
        cwd: workspace,
        ctx: {
          sessionManager: {
            getSessionId: () => "session",
            getSessionFile: () => undefined,
          },
        } as never,
        signal: undefined,
        onOutput: () => undefined,
      }),
    ).rejects.toThrow("launch failed");
  });
});
