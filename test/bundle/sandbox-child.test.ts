import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createEventBus,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import {
  createManagedSessionHarness,
  managedSessionContext,
  MANAGED_TEST_MODEL,
  MANAGED_TEST_PROVIDER,
} from "#test/managed-session";
import { executeSandboxBash } from "#sandbox/bash";
import { bindSandboxBashExecutor } from "../../src/extensions/sandbox/bash-binding.ts";
import context from "../../src/extensions/context/index.ts";
import sandbox from "../../src/extensions/sandbox/index.ts";
import {
  bindSandboxHost,
  prepareSandboxChild,
} from "../../src/extensions/sandbox/runtime.ts";
import { SubagentRuntime } from "../../src/extensions/subagents/runtime.ts";
import { RuntimeSubagentClient } from "../../src/extensions/implement/subagents.ts";
import { afterEach, describe, expect, it } from "vitest";

const directories: string[] = [];

function captureChildSandboxMode(value: { mode?: boolean }) {
  return (pi: ExtensionAPI): void => {
    pi.on("session_start", () => {
      const probeBus = createEventBus();
      const pending = prepareSandboxChild(pi.events, probeBus);
      if (!pending) {
        return;
      }
      const probe = bindSandboxHost(probeBus, () => true);
      value.mode = probe.inheritedEnabled;
      probe.dispose();
      pending.dispose();
    });
  };
}

afterEach(async () => {
  while (directories.length) {
    rmSync(directories.pop()!, { force: true, recursive: true });
  }
});

describe("Sandbox child binding", () => {
  it("uses the managed child host for outcomes and revokes it after the parent handoff", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "pipkin-sandbox-child-"));
    directories.push(workspace);
    const canonicalWorkspace = realpathSync(workspace);
    const parentBus = createEventBus();
    const parentMode = bindSandboxHost(parentBus, () => false);
    const parentExecutor = bindSandboxBashExecutor(parentBus, async () => ({
      content: [{ type: "text" as const, text: "parent executor" }],
      details: undefined,
    }));
    const childSandbox = {} as { mode?: boolean };
    const harness = await createManagedSessionHarness(
      [
        fauxAssistantMessage(
          fauxToolCall(
            "bash_outcome",
            {
              command:
                'printf \'child retained:%s:%s\' "$PWD" "$PI_SESSION_ID"',
            },
            { id: "child-outcome" },
          ),
        ),
        fauxAssistantMessage(
          fauxToolCall(
            "context_recall",
            { id: "child-outcome" },
            { id: "child-recall" },
          ),
        ),
        fauxAssistantMessage("child handoff"),
      ],
      {
        extensionFactories: [
          sandbox,
          context,
          captureChildSandboxMode(childSandbox),
        ],
      },
    );
    const runtime = new SubagentRuntime(
      {
        events: parentBus,
        getActiveTools: () => ["bash", "bash_outcome", "context_recall"],
      } as never,
      {
        createSession: harness.createSession,
        modelPresets: {
          low: {
            model: `${MANAGED_TEST_PROVIDER}/${MANAGED_TEST_MODEL}`,
            thinking: "low",
          },
        },
      },
    );
    const client = new RuntimeSubagentClient(
      runtime.pi,
      { ...managedSessionContext(harness), cwd: "/parent-workspace" } as never,
      "parent-run",
    );

    try {
      await expect(
        executeSandboxBash(parentBus, {
          toolCallId: "parent-marker",
          params: { command: "printf parent" },
          signal: undefined,
          onUpdate: undefined,
          ctx: {} as never,
        }),
      ).resolves.toMatchObject({
        content: [{ type: "text", text: "parent executor" }],
      });

      const handle = await client.spawn({
        type: "pipkin:implement:reviewer",
        prompt: "inspect the child binding",
        description: "child binding",
        cwd: workspace,
        role: "reviewer",
        readOnly: true,
      });
      const handoff = await client.waitFor(handle);
      const child = runtime.snapshot(handle);
      const session = harness.sessions[0]!;
      const childBus = harness.eventBuses[0]!;

      expect(handoff).toEqual({ status: "completed", result: "child handoff" });
      expect(child).toMatchObject({
        status: "completed",
        cwd: workspace,
        owner: {
          kind: "pipkin:implement",
          runId: "parent-run",
          role: "reviewer",
        },
      });
      expect(session.messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            role: "toolResult",
            toolCallId: "child-outcome",
            toolName: "bash_outcome",
            isError: false,
          }),
          expect.objectContaining({
            role: "toolResult",
            toolCallId: "child-recall",
            toolName: "context_recall",
            content: [
              expect.objectContaining({
                type: "text",
                text: `child retained:${canonicalWorkspace}:${session.sessionId}`,
              }),
            ],
            isError: false,
          }),
        ]),
      );
      expect(childBus).not.toBe(parentBus);
      expect(childSandbox.mode).toBe(false);
      await expect(
        executeSandboxBash(childBus, {
          toolCallId: "child-after-shutdown",
          params: { command: "printf child" },
          signal: undefined,
          onUpdate: undefined,
          ctx: {} as never,
        }),
      ).rejects.toThrow("unavailable");
    } finally {
      await runtime.dispose();
      parentExecutor.dispose();
      parentMode.dispose();
    }
  });
});
