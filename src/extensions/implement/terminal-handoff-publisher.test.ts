import { describe, expect, it } from "vitest";
import { createTerminalHandoffPublisher } from "./terminal-handoff-publisher.js";
import type { RunState } from "./store.js";

type SentMessage = { content: unknown; options: { triggerTurn?: boolean } };

function terminalState(phase: RunState["phase"]): RunState {
  return { phase, run: { id: "run-1" } } as RunState;
}

function terminalEvent(
  kind: "run_completed" | "run_incomplete" | "run_failed",
) {
  return kind === "run_completed"
    ? { kind, targetSha: "target", targetTreeSha: "tree" }
    : { kind };
}

describe("terminal handoff publisher", () => {
  it("sends one rendered custom handoff immediately when the session is idle", () => {
    const messages: SentMessage[] = [];
    const publisher = createTerminalHandoffPublisher(
      {
        sendMessage(message, options) {
          messages.push({ content: message.content, options: options ?? {} });
        },
      },
      (state) => `handoff:${state.phase}`,
    );
    const idle = { isIdle: () => true };

    publisher.capture(
      terminalState("completed"),
      terminalEvent("run_completed"),
      idle,
    );
    publisher.capture(
      terminalState("completed"),
      terminalEvent("run_completed"),
      idle,
    );
    publisher.flush(idle);

    expect(messages).toEqual([
      { content: "handoff:completed", options: { triggerTurn: true } },
    ]);
    expect(publisher.hasPending()).toBe(false);
  });

  it("defers busy delivery until an idle settle and preserves the rendered text", () => {
    const messages: SentMessage[] = [];
    const publisher = createTerminalHandoffPublisher(
      {
        sendMessage(message, options) {
          messages.push({ content: message.content, options: options ?? {} });
        },
      },
      () => "captured before cleanup",
    );
    const busy = { isIdle: () => false };
    const idle = { isIdle: () => true };

    publisher.capture(
      terminalState("completed"),
      terminalEvent("run_completed"),
      busy,
    );
    publisher.flush(busy);
    publisher.flush(idle);
    publisher.flush(idle);

    expect(messages).toEqual([
      { content: "captured before cleanup", options: { triggerTurn: true } },
    ]);
    expect(publisher.hasPending()).toBe(false);
  });

  it("retains a failed send for a later idle retry and blocks until it succeeds", () => {
    let attempts = 0;
    const publisher = createTerminalHandoffPublisher(
      {
        sendMessage() {
          attempts += 1;
          if (attempts === 1) {
            throw new Error("session unavailable");
          }
        },
      },
      () => "retry me",
    );
    const idle = { isIdle: () => true };

    publisher.capture(
      terminalState("incomplete"),
      terminalEvent("run_incomplete"),
      idle,
    );

    expect(publisher.hasPending()).toBe(true);
    publisher.flush(idle);

    expect(attempts).toBe(2);
    expect(publisher.hasPending()).toBe(false);
  });

  it("clears pending delivery and makes late callbacks inert after disposal", () => {
    const messages: SentMessage[] = [];
    const publisher = createTerminalHandoffPublisher(
      {
        sendMessage(message, options) {
          messages.push({ content: message.content, options: options ?? {} });
        },
      },
      () => "discarded",
    );
    const busy = { isIdle: () => false };
    const idle = { isIdle: () => true };

    publisher.capture(
      terminalState("failed"),
      terminalEvent("run_failed"),
      busy,
    );
    publisher.dispose();
    publisher.dispose();
    publisher.flush(idle);
    publisher.capture(
      terminalState("failed"),
      terminalEvent("run_failed"),
      idle,
    );

    expect(messages).toEqual([]);
    expect(publisher.hasPending()).toBe(false);
  });
});
