import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  ContentLengthDecoder,
  encodeMessage,
  JsonRpcConnection,
  RequestCancelledError,
  RequestTimeoutError,
} from "./protocol.js";

class FakeProcess extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  kill = vi.fn(() => true);
}
function frame(value: object): Buffer {
  return encodeMessage(value);
}

describe("Content-Length JSON-RPC protocol", () => {
  it("decodes split and combined frames", () => {
    const decoder = new ContentLengthDecoder();
    const both = Buffer.concat([
      frame({ id: 1, result: "one" }),
      frame({ id: 2, result: "two" }),
    ]);
    expect(decoder.push(both.subarray(0, 11))).toEqual([]);
    expect(decoder.push(both.subarray(11))).toEqual([
      { jsonrpc: "2.0", id: 1, result: "one" },
      { jsonrpc: "2.0", id: 2, result: "two" },
    ]);
  });
  it("multiplexes concurrent responses and propagates errors", async () => {
    const child = new FakeProcess();
    const connection = new JsonRpcConnection(child);
    const writes: Buffer[] = [];
    child.stdin.on("data", (value) => writes.push(Buffer.from(value)));
    const first = connection.request("first");
    const second = connection.request("second");
    await vi.waitFor(() => expect(writes).toHaveLength(2));
    const ids = writes.map(
      (value) => new ContentLengthDecoder().push(value)[0].id as number,
    );
    child.stdout.write(
      Buffer.concat([
        frame({ id: ids[1], result: "second" }),
        frame({ id: ids[0], error: { code: -1, message: "bad" } }),
      ]),
    );
    await expect(second).resolves.toBe("second");
    await expect(first).rejects.toThrow("bad");
  });
  it("cancels timed out, pre-aborted, and aborted requests", async () => {
    const child = new FakeProcess();
    const connection = new JsonRpcConnection(child);
    const writes: Buffer[] = [];
    child.stdin.on("data", (value) => writes.push(Buffer.from(value)));
    await expect(
      connection.request("slow", {}, { timeoutMs: 1 }),
    ).rejects.toBeInstanceOf(RequestTimeoutError);
    const preAborted = new AbortController();
    preAborted.abort();
    await expect(
      connection.request("pre-abort", {}, { signal: preAborted.signal }),
    ).rejects.toBeInstanceOf(RequestCancelledError);
    const controller = new AbortController();
    const request = connection.request(
      "abort",
      {},
      { signal: controller.signal },
    );
    controller.abort();
    await expect(request).rejects.toBeInstanceOf(RequestCancelledError);
    expect(
      writes.map((value) => new ContentLengthDecoder().push(value)[0].method),
    ).toContain("$/cancelRequest");
  });
  it("rejects pending work on crash and safely rejects server edits", async () => {
    const child = new FakeProcess();
    const connection = new JsonRpcConnection(child);
    const writes: Buffer[] = [];
    child.stdin.on("data", (value) => writes.push(Buffer.from(value)));
    const pending = connection.request("slow");
    child.emit("exit", 1, null);
    await expect(pending).rejects.toThrow("exited");
    const live = new FakeProcess();
    const liveWrites: Buffer[] = [];
    live.stdin.on("data", (value) => liveWrites.push(Buffer.from(value)));
    const serverConnection = new JsonRpcConnection(live);
    expect(serverConnection.closed).toBe(false);
    live.stdout.write(
      frame({ id: 4, method: "workspace/applyEdit", params: { edit: {} } }),
    );
    await vi.waitFor(() => expect(liveWrites).toHaveLength(1));
    const reply = new ContentLengthDecoder().push(liveWrites[0])[0];
    expect(reply.result).toEqual({
      applied: false,
      failureReason: "pi-lsp is read-only",
    });
  });
  it("does not throw when cancellation or a server reply races a close", async () => {
    const child = new FakeProcess();
    const connection = new JsonRpcConnection(child, async () => {
      child.emit("exit", 1, null);
      return null;
    });
    const controller = new AbortController();
    const request = connection.request(
      "slow",
      {},
      { signal: controller.signal },
    );
    child.emit("exit", 1, null);
    controller.abort();
    await expect(request).rejects.toThrow("exited");
    child.stdout.write(frame({ id: 2, method: "unknown" }));
    await new Promise((resolve) => setImmediate(resolve));
    expect(connection.closed).toBe(true);
  });
});
