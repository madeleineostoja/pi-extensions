import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
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
import registerGuard from "../guard/index.ts";
import { getNonoTarget } from "../guard/runtime/nono.ts";
import { within } from "./test-boundary.js";
import {
  resolveImplementRoles,
  RuntimeSubagentClient,
  type ImplementRoles,
} from "./subagents.js";
import { spawnValidatedWorker } from "./worker-invocation.js";

const directories: string[] = [];

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
      recovery: expect.objectContaining({
        type: "pipkin:implement:recovery",
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

  it.runIf(getNonoTarget() !== null)(
    "runs Guard-constrained Bash in a real managed worker without parent approvals",
    async () => {
      const root = mkdtempSync(join(homedir(), ".pipkin-managed-guard-"));
      directories.push(root);
      const workspace = join(root, "workspace");
      const sibling = join(root, "sibling-target");
      const artifacts = join(root, "artifacts");
      const protectedFile = join(workspace, ".env");
      mkdirSync(workspace);
      mkdirSync(sibling);
      mkdirSync(artifacts);
      const siblingFile = join(sibling, "target.txt");
      const artifactFile = join(artifacts, "artifact.txt");
      const workspaceFile = join(workspace, "created-by-worker");
      writeFileSync(protectedFile, "protected", { flag: "w" });
      writeFileSync(siblingFile, "sibling", { flag: "w" });
      writeFileSync(artifactFile, "artifact", { flag: "w" });
      const command = [
        "printf 'cwd='; pwd",
        `if cat ${JSON.stringify(siblingFile)}; then echo sibling-readable; else echo sibling-denied; fi`,
        `if cat ${JSON.stringify(artifactFile)}; then echo artifact-readable; else echo artifact-denied; fi`,
        `touch ${JSON.stringify(workspaceFile)} && echo workspace-write`,
      ].join("; ");
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
        { extensionFactories: [registerGuard] },
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

      expect(bash?.isError).toBe(false);
      const bashOutput = bash?.content
        .map((content) => content.text ?? "")
        .join("");
      expect(bashOutput).toContain(`cwd=${realpathSync(workspace)}`);
      expect(bashOutput).toContain("sibling-denied");
      expect(bashOutput).toContain("artifact-denied");
      expect(bashOutput).toContain("workspace-write");
      expect(existsSync(workspaceFile)).toBe(true);
      expect(protectedRead).toMatchObject({
        isError: true,
        content: [
          {
            text: expect.stringContaining("interactive TUI"),
          },
        ],
      });
      await runtime.dispose();
    },
  );

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
