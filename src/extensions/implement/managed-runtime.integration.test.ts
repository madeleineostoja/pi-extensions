import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import {
  createManagedSessionHarness,
  managedSessionContext,
  MANAGED_TEST_CWD,
  MANAGED_TEST_MODEL,
  MANAGED_TEST_PROVIDER,
} from "#test/managed-session";
import {
  MANAGED_COMPLETION_TOOL_NAME,
  SubagentRuntime,
} from "#subagents/runtime";
import { afterEach, describe, expect, it } from "vitest";
import { registerGuardCommand } from "../guard/command.ts";
import { isSupportedMac } from "../guard/enforcement/decide.ts";
import { createDirectFilesystemToolHandler } from "../guard/enforcement/handler.ts";
import { createGuardBashRuntime } from "../guard/runtime/bash.ts";
import { createGuardSessionController } from "../guard/runtime/controller.ts";
import type { NonoHealth } from "../guard/runtime/nono.ts";
import { createGuardRuntimeState } from "../guard/state.ts";
import { within } from "./test-boundary.js";
import {
  resolveImplementRoles,
  RuntimeSubagentClient,
  type ImplementRoles,
} from "./subagents.js";
import { spawnValidatedWorker } from "./worker-invocation.js";

const directories: string[] = [];

function registerGuard(pi: any, health?: NonoHealth): void {
  const supportedMac = health ? true : isSupportedMac();
  const state = createGuardRuntimeState();
  const bash = createGuardBashRuntime({ state, supportedMac });
  const session = createGuardSessionController({
    state,
    bash,
    supportedMac,
    healthProbe: health ? async () => health : undefined,
  });

  registerGuardCommand({ pi, state, supportedMac });
  pi.on("session_start", (event: any, ctx: any) => {
    const { bashTool } = session.sessionStart(event, ctx);
    if (bashTool) {
      pi.registerTool(bashTool);
    }
  });
  pi.on("session_shutdown", (_event: any, ctx: any) =>
    session.sessionShutdown(ctx),
  );
  pi.on(
    "tool_call",
    createDirectFilesystemToolHandler({ state, supportedMac }),
  );
  pi.on("user_bash", (_event: any, ctx: any) => session.userBash(ctx));
}

afterEach(() => {
  while (directories.length) {
    rmSync(directories.pop()!, { recursive: true, force: true });
  }
});

function roles(): ImplementRoles {
  const resolved = resolveImplementRoles({
    medium: {
      model: `${MANAGED_TEST_PROVIDER}/${MANAGED_TEST_MODEL}`,
      thinking: "medium",
    },
    high: {
      model: `${MANAGED_TEST_PROVIDER}/${MANAGED_TEST_MODEL}`,
      thinking: "high",
    },
  });
  if (!resolved) {
    throw new Error("Expected fixed Pipkin role mapping.");
  }
  return resolved;
}

function pi() {
  return {
    sendMessage() {},
    getActiveTools: () => ["read", "bash", "edit", "write"],
  };
}

function fakeNono(root: string): { binary: string; log: string } {
  const binary = join(root, "pipkin-nono");
  const log = join(root, "nono-log.json");
  writeFileSync(
    binary,
    `#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
const args = process.argv.slice(2);
const config = args[args.indexOf("--config") + 1];
writeFileSync(process.env.PIPKIN_MANAGED_NONO_LOG, JSON.stringify({
  args,
  manifest: JSON.parse(readFileSync(config, "utf8")),
  cwd: process.cwd(),
  environment: { PATH: process.env.PATH, PI_SESSION_FILE: process.env.PI_SESSION_FILE },
}));
const command = args.slice(args.indexOf("--") + 1);
const child = spawn(command[0], command.slice(1), {
  cwd: process.cwd(),
  env: process.env,
  stdio: "inherit",
});
child.once("error", () => process.exit(127));
child.once("close", (code) => process.exit(code ?? 1));
`,
    { mode: 0o700 },
  );
  chmodSync(binary, 0o700);
  return { binary, log };
}

describe("Implement managed runtime integration", () => {
  it("maps every fixed Pipkin role to its central preset", () => {
    expect(roles()).toEqual({
      planner: expect.objectContaining({
        type: "pipkin:implement:planner",
        thinking: "high",
      }),
      reviewer: expect.objectContaining({
        type: "pipkin:implement:reviewer",
        thinking: "high",
      }),
      implementer: expect.objectContaining({
        type: "pipkin:implement:implementer",
        thinking: "medium",
      }),
    });
  });

  it("runs a typed reviewer completion through a real managed child", async () => {
    const harness = await createManagedSessionHarness([
      fauxAssistantMessage(
        fauxToolCall(
          MANAGED_COMPLETION_TOOL_NAME,
          {
            verdict: "approved",
            publicationCommitSubject: "feat: publish workstream",
          },
          { id: "completion" },
        ),
      ),
    ]);
    const extension = pi();
    const runtime = new SubagentRuntime(extension as never, {
      createSession: harness.createSession,
    });
    const context = managedSessionContext(harness);
    const client = new RuntimeSubagentClient(
      extension as never,
      context as never,
      "run-1",
    );
    const handle = await spawnValidatedWorker({
      packet: {
        role: "reviewer" as const,
        completionKind: "initial-review" as const,
        identity: "run-1/work/candidate",
        workspace: { path: MANAGED_TEST_CWD },
      },
      subagents: client,
      roles: roles(),
      taskId: "work",
      description: "Review candidate",
      render: () => "Review the assigned candidate.",
    });
    const result = await within(
      "managed reviewer completion",
      client.waitFor(handle),
      {
        diagnostics: () =>
          `managed sessions=${harness.sessions.length}; runtime=${runtime.snapshot(handle)?.status ?? "missing"}`,
      },
    );
    const snapshot = runtime.snapshot(handle);

    expect(result).toEqual({
      status: "completed",
      result: {
        verdict: "approved",
        publicationCommitSubject: "feat: publish workstream",
      },
    });
    expect(snapshot).toMatchObject({
      status: "completed",
      owner: {
        kind: "pipkin:implement",
        runId: "run-1",
        role: "reviewer",
        taskId: "work",
      },
      type: "pipkin:implement:reviewer",
      model: `${MANAGED_TEST_PROVIDER}/${MANAGED_TEST_MODEL}`,
      thinking: "high",
    });
    expect(harness.sessions).toHaveLength(1);
    await runtime.dispose();
  });

  it("runs Guard Bash in a managed worker through the fake Nono integration", async () => {
    const root = mkdtempSync(join(tmpdir(), "pipkin-managed-guard-"));
    directories.push(root);
    const workspace = join(root, "workspace");
    const protectedFile = join(workspace, ".env");
    const workspaceFile = join(workspace, "created-by-worker");
    mkdirSync(workspace);
    writeFileSync(protectedFile, "protected");
    const nono = fakeNono(root);
    const command = [
      "printf 'cwd='; pwd",
      `touch ${JSON.stringify(workspaceFile)} && echo workspace-write`,
    ].join("; ");
    const previousLog = process.env.PIPKIN_MANAGED_NONO_LOG;
    process.env.PIPKIN_MANAGED_NONO_LOG = nono.log;
    try {
      const harness = await createManagedSessionHarness(
        [
          fauxAssistantMessage(
            fauxToolCall("bash", { command }, { id: "bash" }),
          ),
          fauxAssistantMessage(
            fauxToolCall("read", { path: protectedFile }, { id: "protected" }),
          ),
          fauxAssistantMessage(
            fauxToolCall(
              MANAGED_COMPLETION_TOOL_NAME,
              {
                verdict: "approved",
                publicationCommitSubject: "feat: publish workstream",
              },
              { id: "completion" },
            ),
          ),
        ],
        {
          extensionFactories: [
            (extension) =>
              registerGuard(extension, { kind: "healthy", path: nono.binary }),
          ],
        },
      );
      const extension = pi();
      const runtime = new SubagentRuntime(extension as never, {
        createSession: harness.createSession,
      });
      const client = new RuntimeSubagentClient(
        extension as never,
        managedSessionContext(harness) as never,
        "run-guard",
      );
      const handle = await spawnValidatedWorker({
        packet: {
          role: "reviewer" as const,
          completionKind: "initial-review" as const,
          identity: "run-guard/work/candidate",
          workspace: { path: workspace },
        },
        subagents: client,
        roles: roles(),
        taskId: "work",
        description: "Run Guard Bash",
        render: () => "Run the requested Bash check, then complete the review.",
      });
      const result = await within(
        "managed Guard Bash completion",
        client.waitFor(handle),
        {
          diagnostics: () => `managed sessions=${harness.sessions.length}`,
        },
      );

      expect(result).toEqual({
        status: "completed",
        result: {
          verdict: "approved",
          publicationCommitSubject: "feat: publish workstream",
        },
      });
      expect(harness.sessions).toHaveLength(1);
      const toolResults = harness.sessions[0]!.messages.filter(
        (message) => message.role === "toolResult",
      ) as Array<{
        toolCallId: string;
        content: Array<{ type: string; text?: string }>;
        isError: boolean;
      }>;
      const bash = toolResults.find((message) => message.toolCallId === "bash");
      const protectedRead = toolResults.find(
        (message) => message.toolCallId === "protected",
      );
      const invocation = JSON.parse(readFileSync(nono.log, "utf8")) as {
        args: string[];
        manifest: {
          filesystem: { grants: Array<{ path: string; access: string }> };
        };
        cwd: string;
        environment: { PATH?: string; PI_SESSION_FILE?: string };
      };

      expect(bash?.isError).toBe(false);
      expect(
        bash?.content.map((content) => content.text ?? "").join(""),
      ).toContain(`cwd=${realpathSync(workspace)}`);
      expect(existsSync(workspaceFile)).toBe(true);
      expect(invocation.cwd).toBe(realpathSync(workspace));
      expect(invocation.args.slice(0, 4)).toEqual([
        "run",
        "--config",
        expect.stringMatching(/pipkin-nono-manifest\.json$/),
        "--",
      ]);
      expect(invocation.args[4]).toBeTruthy();
      expect(invocation.manifest.filesystem.grants).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: realpathSync(workspace),
            access: "readwrite",
            type: "directory",
          }),
          expect.objectContaining({
            path: "/bin",
            access: "read",
            type: "directory",
          }),
          expect.objectContaining({
            path: "/usr",
            access: "read",
            type: "directory",
          }),
        ]),
      );
      expect(invocation.environment.PATH).toBeTruthy();
      expect(protectedRead).toMatchObject({
        isError: true,
        content: [
          {
            text: expect.stringContaining("interactive TUI"),
          },
        ],
      });
      await runtime.dispose();
    } finally {
      if (previousLog === undefined) {
        delete process.env.PIPKIN_MANAGED_NONO_LOG;
      } else {
        process.env.PIPKIN_MANAGED_NONO_LOG = previousLog;
      }
    }
  });

  it("passes a large rendered prompt to a managed child", async () => {
    const harness = await createManagedSessionHarness([
      fauxAssistantMessage(
        fauxToolCall(
          MANAGED_COMPLETION_TOOL_NAME,
          {
            verdict: "approved",
            publicationCommitSubject: "feat: publish workstream",
          },
          { id: "completion" },
        ),
      ),
    ]);
    const extension = pi();
    const runtime = new SubagentRuntime(extension as never, {
      createSession: harness.createSession,
    });
    const client = new RuntimeSubagentClient(
      extension as never,
      managedSessionContext(harness) as never,
      "run-1",
    );

    const handle = await spawnValidatedWorker({
      packet: {
        role: "reviewer" as const,
        completionKind: "initial-review" as const,
        identity: "run-1/work/candidate",
        workspace: { path: MANAGED_TEST_CWD },
      },
      subagents: client,
      roles: roles(),
      taskId: "work",
      description: "Review candidate",
      render: () => "x".repeat(524_289),
    });

    await expect(client.waitFor(handle)).resolves.toEqual({
      status: "completed",
      result: {
        verdict: "approved",
        publicationCommitSubject: "feat: publish workstream",
      },
    });
    expect(harness.sessions).toHaveLength(1);
    expect(harness.faux.state.callCount).toBe(1);
    await runtime.dispose();
  });
});
