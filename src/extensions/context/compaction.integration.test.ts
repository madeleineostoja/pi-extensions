import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
  createManagedSessionHarness,
  MANAGED_TEST_CWD,
} from "#test/managed-session";
import context from "./index.ts";
import { EPOCH_TYPE } from "./policy.ts";

function observeOrdering(events: string[]) {
  return (pi: ExtensionAPI) => {
    pi.on("session_compact", () => {
      events.push("session_compact");
    });
    pi.on("context", (event) => {
      const source = event.messages.find(
        (message) =>
          message.role === "toolResult" && message.toolCallId === "source",
      );
      const text =
        source?.role === "toolResult" && source.content[0]?.type === "text"
          ? source.content[0].text
          : "";
      events.push(
        text.includes('context_recall("source")')
          ? "context:pruned"
          : "context:full",
      );
    });
  };
}

function user(content: string, timestamp: number) {
  return { role: "user" as const, content, timestamp };
}

describe("post-compaction pruning", () => {
  it("persists a known-cold epoch before the first provider request after Pi compaction", async () => {
    const events: string[] = [];
    const harness = await createManagedSessionHarness(
      [
        fauxAssistantMessage("compaction summary"),
        () => {
          events.push("provider_request");
          return fauxAssistantMessage("done");
        },
      ],
      { extensionFactories: [context, observeOrdering(events)] },
    );
    const { session } = await harness.createSession({ cwd: MANAGED_TEST_CWD });

    try {
      await session.bindExtensions({ mode: "json", uiContext: {} as never });
      const manager = session.sessionManager;
      manager.appendMessage(user("old request ".repeat(10_000), 1));
      manager.appendMessage(
        fauxAssistantMessage("old response ".repeat(10_000)),
      );
      manager.appendMessage({
        role: "toolResult",
        toolCallId: "source",
        toolName: "bash",
        content: [{ type: "text", text: "successful output\n".repeat(2_500) }],
        isError: false,
        timestamp: 2,
      });
      for (let index = 0; index < 4; index++) {
        manager.appendMessage(user(`later ${index}`, 3 + index));
      }
      session.agent.state.messages = manager.buildSessionContext().messages;

      await session.compact();
      await session.prompt("continue");

      expect(events.slice(-3)).toEqual([
        "session_compact",
        "context:pruned",
        "provider_request",
      ]);
      expect(
        manager
          .getBranch()
          .filter(
            (entry) =>
              entry.type === "custom" && entry.customType === EPOCH_TYPE,
          ),
      ).toEqual([
        expect.objectContaining({
          data: expect.objectContaining({ kind: "known-cold" }),
        }),
      ]);
    } finally {
      await (
        session as unknown as {
          _extensionRunner: { emit: (event: unknown) => Promise<unknown> };
        }
      )._extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      session.dispose();
    }
  });
});
