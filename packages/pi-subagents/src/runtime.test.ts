import { describe, expect, it } from "vitest";
import { getSubagentRuntime, SubagentRuntime } from "./runtime.js";

type Message = {
  customType?: string;
  content: string;
  display?: boolean;
};

function fakePi() {
  const messages: Message[] = [];
  return {
    messages,
    pi: {
      sendMessage: (message: Message) => messages.push(message),
    },
  };
}

describe("SubagentRuntime", () => {
  it("returns a singleton runtime per pi instance", () => {
    const { pi } = fakePi();

    expect(getSubagentRuntime(pi as never)).toBe(
      getSubagentRuntime(pi as never),
    );
  });

  it("models queued, running, and completed snapshots with metadata", async () => {
    const { pi } = fakePi();
    const runtime = new SubagentRuntime(pi as never);
    const queued = runtime.queue({
      owner: "pi-implement",
      type: "General",
      description: "Do work",
      cwd: "/workspace",
      model: "provider/model",
      thinking: "high",
      extensionBinding: "bound",
      sandboxMode: "workspace-write",
    });

    expect(queued).toMatchObject({
      id: "subagent-1",
      status: "queued",
      owner: "pi-implement",
      type: "General",
      description: "Do work",
      cwd: "/workspace",
      model: "provider/model",
      thinking: "high",
      extensionBinding: "bound",
      sandboxMode: "workspace-write",
    });
    expect(queued.timestamps.queuedAt).toEqual(expect.any(String));

    const running = runtime.start(queued.id);
    expect(running.status).toBe("running");
    expect(running.timestamps.startedAt).toEqual(expect.any(String));

    const waiting = runtime.wait(queued.id);
    const completed = runtime.complete(queued.id, { text: "done" });
    await expect(waiting).resolves.toEqual(completed);
    expect(completed).toMatchObject({
      status: "completed",
      result: { text: "done" },
    });
    expect(completed.timestamps.completedAt).toEqual(expect.any(String));
    expect(runtime.snapshot(queued.id)).toEqual(completed);
    expect(runtime.snapshots()).toEqual([completed]);
  });

  it("models failed and stopped terminal states", () => {
    const { pi } = fakePi();
    const runtime = new SubagentRuntime(pi as never);
    const failed = runtime.queue({
      owner: "owner",
      type: "Internal",
      description: "fail",
      cwd: "/workspace",
    });
    const stopped = runtime.queue({
      owner: "owner",
      type: "Internal",
      description: "stop",
      cwd: "/workspace",
    });

    expect(runtime.fail(failed.id, new Error("boom"))).toMatchObject({
      status: "failed",
      error: "boom",
      extensionBinding: "unbound",
    });
    expect(runtime.stop(stopped.id, "cancelled")).toMatchObject({
      status: "stopped",
      error: "cancelled",
    });
  });

  it("uses public config defaults for model and thinking metadata", () => {
    const { pi } = fakePi();
    const runtime = new SubagentRuntime(pi as never, {
      publicConfig: {
        models: {
          General: undefined,
          Explore: "provider/explore",
          Review: undefined,
        },
        thinking: { General: undefined, Explore: "low", Review: undefined },
      },
    });

    expect(
      runtime.queue({
        owner: "public-tool",
        type: "Explore",
        description: "map the codebase",
        cwd: "/workspace",
      }),
    ).toMatchObject({
      model: "provider/explore",
      thinking: "low",
    });
  });
});
