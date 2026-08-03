import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
import { within } from "./test-boundary.js";
import {
  resolveImplementRoles,
  RuntimeSubagentClient,
  type ImplementRoles,
} from "./subagents.js";
import { spawnValidatedWorker } from "./worker-invocation.js";
import { registerRecordTool } from "../papercuts/record-tool.js";
import { createPapercutStatusController } from "../papercuts/status.js";

const directories: string[] = [];

function recordPapercutExtension(
  pi: Parameters<typeof registerRecordTool>[0],
): void {
  registerRecordTool(pi, createPapercutStatusController());
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
            findings: [],
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
        findings: [],
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
      cwd: MANAGED_TEST_CWD,
      model: `${MANAGED_TEST_PROVIDER}/${MANAGED_TEST_MODEL}`,
      thinking: "high",
    });
    expect(harness.sessions).toHaveLength(1);
    await runtime.dispose();
  });

  it("retries a malformed whole-plan handoff draft once", async () => {
    const harness = await createManagedSessionHarness([
      fauxAssistantMessage(
        fauxToolCall(
          MANAGED_COMPLETION_TOOL_NAME,
          { findings: [], handoffDraft: "   " },
          { id: "invalid-completion" },
        ),
      ),
      fauxAssistantMessage(
        fauxToolCall(
          MANAGED_COMPLETION_TOOL_NAME,
          { findings: [], handoffDraft: "Complete reviewer handoff." },
          { id: "valid-completion" },
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
        completionKind: "initial-overall-review" as const,
        identity: "run-1/whole-plan/current",
        workspace: { path: MANAGED_TEST_CWD },
      },
      subagents: client,
      roles: roles(),
      taskId: "whole-plan",
      description: "Review complete run",
      render: () => "Review the complete run.",
    });

    await expect(client.waitFor(handle)).resolves.toEqual({
      status: "completed",
      result: { findings: [], handoffDraft: "Complete reviewer handoff." },
    });
    expect(harness.faux.state.callCount).toBe(2);
    expect(harness.sessions[0]?.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "toolResult",
          toolCallId: "invalid-completion",
          isError: true,
        }),
      ]),
    );
    await runtime.dispose();
  });

  it("retries a malformed initial anchored overall completion once", async () => {
    const harness = await createManagedSessionHarness([
      fauxAssistantMessage(
        fauxToolCall(
          MANAGED_COMPLETION_TOOL_NAME,
          {
            assessments: [],
            regressions: [],
            publicationCommitSubject: "fix: publish overall repair",
            handoffDraft: "   ",
          },
          { id: "invalid-completion" },
        ),
      ),
      fauxAssistantMessage(
        fauxToolCall(
          MANAGED_COMPLETION_TOOL_NAME,
          {
            assessments: [],
            regressions: [],
            publicationCommitSubject: "fix: publish overall repair",
            handoffDraft: "Complete replacement reviewer handoff.",
          },
          { id: "valid-completion" },
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
        completionKind: "initial-anchored-overall-review" as const,
        identity: "run-1/whole-plan/repaired",
        workspace: { path: MANAGED_TEST_CWD },
      },
      subagents: client,
      roles: roles(),
      taskId: "whole-plan",
      description: "Review repaired complete run",
      render: () => "Review the repaired complete run.",
    });

    await expect(client.waitFor(handle)).resolves.toEqual({
      status: "completed",
      result: {
        assessments: [],
        regressions: [],
        publicationCommitSubject: "fix: publish overall repair",
        handoffDraft: "Complete replacement reviewer handoff.",
      },
    });
    expect(harness.faux.state.callCount).toBe(2);
    await runtime.dispose();
  });

  it("records directly from an owned worktree after its removal", async () => {
    const root = mkdtempSync(join(tmpdir(), "pipkin-implement-papercut-"));
    directories.push(root);
    const workspace = join(
      root,
      ".pi",
      "pipkin",
      "implement",
      "worktrees",
      "run-1",
      "task",
    );
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["config", "user.email", "test@example.com"], {
      cwd: root,
    });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
    writeFileSync(join(root, "README.md"), "fixture\n");
    execFileSync("git", ["add", "README.md"], { cwd: root });
    execFileSync("git", ["commit", "-qm", "fixture"], { cwd: root });
    mkdirSync(dirname(workspace), { recursive: true });
    execFileSync("git", ["worktree", "add", "-qb", "task", workspace], {
      cwd: root,
    });
    const harness = await createManagedSessionHarness(
      [
        fauxAssistantMessage(
          fauxToolCall(
            "record_papercut",
            {
              key: "owned-worktree-detour",
              title: "Owned worktree detour",
              task: "Implement an unrelated task",
              incident:
                "The assigned validation convention required undocumented discovery.",
              evidence:
                "The repository scripts established the required command.",
              workarounds: ["Inspected the repository scripts."],
              taskOutcome: "Safely continued the assigned implementation.",
            },
            { id: "record" },
          ),
        ),
        fauxAssistantMessage(
          fauxToolCall(
            MANAGED_COMPLETION_TOOL_NAME,
            {
              outcome: "changed",
              summary: "Completed the assignment.",
              verification: ["Checked the assigned result."],
            },
            { id: "completion" },
          ),
        ),
      ],
      { extensionFactories: [recordPapercutExtension] },
    );
    const extension = {
      sendMessage() {},
      getActiveTools: () => [
        "read",
        "bash",
        "bash_outcome",
        "context_recall",
        "edit",
        "write",
        "Agent",
        "get_subagent_result",
        "steer_subagent",
        "record_papercut",
      ],
    };
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
        completionKind: "implementer" as const,
        identity: "run-1/task",
        workspace: { path: workspace },
      },
      subagents: client,
      roles: roles(),
      taskId: "task",
      description: "Implement task",
      render: () => "Implement the assigned task.",
    });
    await expect(client.waitFor(handle)).resolves.toMatchObject({
      status: "completed",
    });

    execFileSync("git", ["worktree", "remove", "--force", workspace], {
      cwd: root,
    });
    const registry = join(root, ".pi", "pipkin", "papercuts.json");
    expect(existsSync(registry)).toBe(true);
    expect(JSON.parse(readFileSync(registry, "utf8"))).toMatchObject({
      records: [expect.objectContaining({ key: "owned-worktree-detour" })],
    });
    await runtime.dispose();
  });

  it("passes a large rendered prompt to a managed child", async () => {
    const harness = await createManagedSessionHarness([
      fauxAssistantMessage(
        fauxToolCall(
          MANAGED_COMPLETION_TOOL_NAME,
          {
            findings: [],
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
        findings: [],
        publicationCommitSubject: "feat: publish workstream",
      },
    });
    expect(harness.sessions).toHaveLength(1);
    expect(harness.faux.state.callCount).toBe(1);
    await runtime.dispose();
  });
});
