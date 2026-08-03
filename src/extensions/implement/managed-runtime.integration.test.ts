import { rmSync } from "node:fs";
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

  it("retries a malformed anchored overall handoff draft once", async () => {
    const harness = await createManagedSessionHarness([
      fauxAssistantMessage(
        fauxToolCall(
          MANAGED_COMPLETION_TOOL_NAME,
          { assessments: [], regressions: [], handoffDraft: "   " },
          { id: "invalid-completion" },
        ),
      ),
      fauxAssistantMessage(
        fauxToolCall(
          MANAGED_COMPLETION_TOOL_NAME,
          {
            assessments: [],
            regressions: [],
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
        completionKind: "anchored-overall-review" as const,
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
        handoffDraft: "Complete replacement reviewer handoff.",
      },
    });
    expect(harness.faux.state.callCount).toBe(2);
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
