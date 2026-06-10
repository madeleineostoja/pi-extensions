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
  it("probe resolves ok with version when pi-subagents replies", async () => {
    const events = new FakeEvents();
    const client = new EventSubagentClient(events, 10_000);
    const promise = client.probe(100);
    const request = events.emitted[0];
    expect(request).toMatchObject({ event: "subagents:rpc:ping" });
    const requestId = (request.payload as { requestId: string }).requestId;
    events.fire(`subagents:rpc:ping:reply:${requestId}`, {
      success: true,
      data: { version: 2 },
    });
    await expect(promise).resolves.toEqual({ ok: true, version: 2 });
  });

  it("probe resolves not-ok when nothing replies before the timeout", async () => {
    const events = new FakeEvents();
    const client = new EventSubagentClient(events, 10_000);
    await expect(client.probe(1)).resolves.toEqual({ ok: false });
  });

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

  it("omits model so the subagent type default can be used", async () => {
    const events = new FakeEvents();
    const client = new EventSubagentClient(events, 100);
    const promise = client.spawn({
      type: "Explore",
      prompt: "p",
      description: "d",
    });
    const request = events.emitted[0];
    expect(request.payload).toMatchObject({
      type: "Explore",
      prompt: "p",
      options: { description: "d", isBackground: true },
    });
    expect(
      (request.payload as { options: { model?: string } }).options.model,
    ).toBeUndefined();
    const requestId = (request.payload as { requestId: string }).requestId;
    events.fire(`subagents:rpc:spawn:reply:${requestId}`, {
      success: true,
      data: { id: "agent-1" },
    });
    await expect(promise).resolves.toBe("agent-1");
  });

  it("includes cwd in spawn options when set", async () => {
    const events = new FakeEvents();
    const client = new EventSubagentClient(events, 100);
    const promise = client.spawn({
      type: "general-purpose",
      prompt: "p",
      description: "d",
      cwd: "/some/path",
    });
    const request = events.emitted[0];
    expect(request.payload).toMatchObject({
      type: "general-purpose",
      prompt: "p",
      options: { description: "d", isBackground: true, cwd: "/some/path" },
    });
    const requestId = (request.payload as { requestId: string }).requestId;
    events.fire(`subagents:rpc:spawn:reply:${requestId}`, {
      success: true,
      data: { id: "agent-1" },
    });
    await expect(promise).resolves.toBe("agent-1");
  });

  it("omits cwd in spawn options when unset", async () => {
    const events = new FakeEvents();
    const client = new EventSubagentClient(events, 100);
    const promise = client.spawn({
      type: "general-purpose",
      prompt: "p",
      description: "d",
    });
    const request = events.emitted[0];
    expect(request.payload).toMatchObject({
      type: "general-purpose",
      prompt: "p",
      options: { description: "d", isBackground: true },
    });
    expect(
      Object.prototype.hasOwnProperty.call(
        (request.payload as { options: Record<string, unknown> }).options,
        "cwd",
      ),
    ).toBe(false);
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

  it("resolves immediately when waitFor receives an already-aborted signal", async () => {
    const events = new FakeEvents();
    const client = new EventSubagentClient(events, 100);
    const controller = new AbortController();
    controller.abort();

    await expect(client.waitFor("agent-1", controller.signal)).resolves.toEqual(
      {
        status: "stopped",
        error: "Stopped by user.",
      },
    );
  });

  it("supports multiple concurrent waitFor calls", async () => {
    const events = new FakeEvents();
    const client = new EventSubagentClient(events, 100);

    const p1 = client.waitFor("agent-1");
    const p2 = client.waitFor("agent-2");
    const p3 = client.waitFor("agent-3");

    // Fire in interleaved order
    events.fire("subagents:completed", { id: "agent-2", result: "second" });
    events.fire("subagents:completed", { id: "agent-1", result: "first" });
    events.fire("subagents:failed", { id: "agent-3", error: "third" });

    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
    expect(r1).toEqual({ status: "completed", result: "first" });
    expect(r2).toEqual({ status: "completed", result: "second" });
    expect(r3).toEqual({ status: "failed", error: "third" });
  });

  it("each waiter only resolves for its own agent id", async () => {
    const events = new FakeEvents();
    const client = new EventSubagentClient(events, 100);

    const p1 = client.waitFor("agent-1");
    const p2 = client.waitFor("agent-2");

    // Multiple unrelated completions before our targets
    events.fire("subagents:completed", { id: "other-1", result: "x" });
    events.fire("subagents:completed", { id: "other-2", result: "y" });
    events.fire("subagents:completed", { id: "agent-2", result: "b" });
    events.fire("subagents:completed", { id: "agent-1", result: "a" });

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toEqual({ status: "completed", result: "a" });
    expect(r2).toEqual({ status: "completed", result: "b" });
  });
});
