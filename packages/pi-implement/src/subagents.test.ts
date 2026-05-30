import { describe, expect, it } from "vitest";
import { EventSubagentClient, subagentResultText } from "./subagents.js";

type Handler = (payload: unknown) => void;

class FakeEvents {
  handlers = new Map<string, Handler[]>();
  emitted: Array<{ event: string; payload: unknown }> = [];

  on(event: string, handler: Handler) {
    const handlers = this.handlers.get(event) ?? [];
    handlers.push(handler);
    this.handlers.set(event, handlers);
    return () => {
      this.handlers.set(
        event,
        (this.handlers.get(event) ?? []).filter(
          (candidate) => candidate !== handler,
        ),
      );
    };
  }

  emit(event: string, payload: unknown) {
    this.emitted.push({ event, payload });
  }

  fire(event: string, payload: unknown) {
    for (const handler of this.handlers.get(event) ?? []) {
      handler(payload);
    }
  }
}

describe("EventSubagentClient", () => {
  it("spawns with background options and model", async () => {
    const events = new FakeEvents();
    const client = new EventSubagentClient(events, 100);
    const promise = client.spawn({
      type: "general-purpose",
      prompt: "p",
      description: "d",
      model: "p/m",
    });
    const request = events.emitted[0];
    expect(request).toMatchObject({ event: "subagents:rpc:spawn" });
    expect(request.payload).toMatchObject({
      type: "general-purpose",
      prompt: "p",
      options: { description: "d", isBackground: true, model: "p/m" },
    });
    const requestId = (request.payload as { requestId: string }).requestId;
    events.fire(`subagents:rpc:spawn:reply:${requestId}`, {
      success: true,
      data: { id: "agent-1" },
    });
    await expect(promise).resolves.toBe("agent-1");
  });

  it("waits for matching completion and ignores unrelated agents", async () => {
    const events = new FakeEvents();
    const client = new EventSubagentClient(events, 100);
    const promise = client.waitFor("agent-1");
    events.fire("subagents:completed", { id: "other", result: "wrong" });
    events.fire("subagents:completed", { id: "agent-1", result: "ok" });
    await expect(promise).resolves.toEqual({
      status: "completed",
      result: "ok",
    });
  });

  it("extracts structured completion result text", async () => {
    const events = new FakeEvents();
    const client = new EventSubagentClient(events, 100);
    const promise = client.waitFor("agent-1");
    events.fire("subagents:completed", {
      id: "agent-1",
      result: { content: [{ type: "text", text: "ok" }] },
    });
    await expect(promise).resolves.toEqual({
      status: "completed",
      result: "ok",
    });
  });

  it("normalizes nested subagent output", () => {
    expect(subagentResultText({ output: { text: "done" } })).toBe("done");
    expect(subagentResultText([{ text: "a" }, { text: "b" }])).toBe("a\nb");
  });

  it("returns stopped when aborted", async () => {
    const events = new FakeEvents();
    const client = new EventSubagentClient(events, 100);
    const controller = new AbortController();
    const promise = client.waitFor("agent-1", controller.signal);

    controller.abort();

    await expect(promise).resolves.toEqual({
      status: "stopped",
      error: "Stopped by user.",
    });
  });
});
