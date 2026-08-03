import { createEventBus } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { ACTIVITY_CHANNEL } from "#ui/activity";
import { bindSandboxBashExecutor } from "../sandbox/bash-binding.js";
import type { SandboxExecutionTerminal } from "../sandbox/bash-capability.js";
import { ProcessSessionLifecycle } from "./lifecycle.js";

function terminal(): SandboxExecutionTerminal {
  return {
    exitCode: 0,
    signal: null,
    termination: "natural",
    outputComplete: true,
  };
}

describe("ProcessSessionLifecycle", () => {
  it("starts activity only for the top-level interactive TUI lifecycle", async () => {
    const events = createEventBus();
    const activityEvents: unknown[] = [];
    events.on(ACTIVITY_CHANNEL, (event) => activityEvents.push(event));
    const lifecycle = new ProcessSessionLifecycle({
      events,
      getActiveTools: () => ["bash"],
    } as never);

    await lifecycle.sessionStart(
      {} as never,
      {
        mode: "print",
        hasUI: false,
      } as never,
    );
    expect(activityEvents).toEqual([]);
    await lifecycle.sessionShutdown();

    await lifecycle.sessionStart(
      {} as never,
      {
        mode: "tui",
        hasUI: true,
      } as never,
    );
    expect(activityEvents).toEqual([
      expect.objectContaining({ source: "processes", operation: "replace" }),
    ]);
    await lifecycle.sessionShutdown();
    expect(activityEvents).toContainEqual(
      expect.objectContaining({ source: "processes", operation: "clear" }),
    );
  });

  it("replaces disposed session state with a fresh process-id generation", async () => {
    const events = {} as never;
    const binding = bindSandboxBashExecutor(
      events,
      async () => ({ content: [], details: undefined }),
      async () => ({
        pid: 1,
        completion: Promise.resolve(terminal()),
        stop: async () => terminal(),
      }),
    );
    const lifecycle = new ProcessSessionLifecycle({
      events,
      getActiveTools: () => ["bash"],
    } as never);
    const input = {
      command: "true",
      description: "test process",
      cwd: "/tmp",
      ctx: {} as never,
      signal: undefined,
      toolCallId: "call",
    };
    try {
      await lifecycle.sessionStart({} as never, {} as never);
      await expect(lifecycle.runtime().start(input)).resolves.toMatchObject({
        id: "process-1",
      });
      await lifecycle.sessionShutdown();
      expect(() => lifecycle.runtime()).toThrow("not active");
      await lifecycle.sessionStart({} as never, {} as never);
      await expect(lifecycle.runtime().start(input)).resolves.toMatchObject({
        id: "process-1",
      });
      await lifecycle.sessionShutdown();
    } finally {
      binding.dispose();
    }
  });
});
