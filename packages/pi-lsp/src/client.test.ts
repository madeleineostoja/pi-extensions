import { EventEmitter } from "node:events";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LspClient } from "./client.js";
import {
  ContentLengthDecoder,
  encodeMessage,
  JsonRpcConnection,
} from "./protocol.js";

class Fake extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
}

const dirs: string[] = [];
function temp(): string {
  const value = mkdtempSync(join(tmpdir(), "pi-lsp-"));
  dirs.push(value);
  return value;
}
afterEach(() => {
  while (dirs.length) {
    rmSync(dirs.pop()!, { recursive: true, force: true });
  }
});
function setup(workspace = process.cwd()) {
  const process = new Fake();
  const client = new LspClient(new JsonRpcConnection(process), workspace);
  const requests: Array<{
    id: number;
    method: string;
    params: Record<string, unknown>;
  }> = [];
  process.stdin.on("data", (data) => {
    const value = new ContentLengthDecoder().push(Buffer.from(data))[0];
    if (value.method) {
      requests.push(
        value as {
          id: number;
          method: string;
          params: Record<string, unknown>;
        },
      );
    }
  });
  return { process, client, requests };
}

describe("document synchronization and diagnostics", () => {
  it("opens then sends monotonic full changes before requests", async () => {
    const dir = temp();
    const file = join(dir, "sample.ts");
    writeFileSync(file, "const a = 1\n");
    const { client, requests } = setup(dir);
    await client.synchronize(file, "typescript");
    writeFileSync(file, "const a = 2\n");
    await client.synchronize(file, "typescript");
    expect(requests.map((request) => request.method)).toEqual([
      "textDocument/didOpen",
      "textDocument/didChange",
    ]);
    expect(
      (requests[1].params.textDocument as { version: number }).version,
    ).toBe(2);
  });

  it("advertises versioned publish diagnostics", async () => {
    const dir = realpathSync(temp());
    const { client, process, requests } = setup(dir);
    const initialization = client.initialize(pathToFileURL(dir).href);
    await vi.waitFor(() => expect(requests.at(-1)?.method).toBe("initialize"));
    expect(requests.at(-1)?.params.capabilities).toMatchObject({
      textDocument: { publishDiagnostics: { versionSupport: true } },
    });
    process.stdout.write(
      encodeMessage({ id: requests.at(-1)!.id, result: { capabilities: {} } }),
    );
    await initialization;
  });

  it("uses pull full and unchanged reports and respects refresh invalidation", async () => {
    const dir = temp();
    const file = join(dir, "sample.rb");
    writeFileSync(file, "x = 1\n");
    const { client, process, requests } = setup(dir);
    const diagnostic = client.diagnostics(file, "ruby", {
      diagnosticProvider: {},
    });
    await vi.waitFor(() =>
      expect(requests.at(-1)?.method).toBe("textDocument/diagnostic"),
    );
    process.stdout.write(
      encodeMessage({
        id: requests.at(-1)!.id,
        result: {
          kind: "full",
          resultId: "a",
          items: [{ message: "bad", severity: 2, range: {} }],
        },
      }),
    );
    expect((await diagnostic).diagnostics).toHaveLength(1);
    const unchanged = client.diagnostics(file, "ruby", {
      diagnosticProvider: {},
    });
    await vi.waitFor(() =>
      expect(requests.at(-1)?.params.previousResultId).toBe("a"),
    );
    process.stdout.write(
      encodeMessage({
        id: requests.at(-1)!.id,
        result: { kind: "unchanged", resultId: "a" },
      }),
    );
    expect((await unchanged).diagnostics).toHaveLength(1);
    process.stdout.write(
      encodeMessage({
        id: 99,
        method: "workspace/diagnostic/refresh",
      }),
    );
    const refreshed = client.diagnostics(file, "ruby", {
      diagnosticProvider: {},
    });
    await vi.waitFor(() =>
      expect(requests.at(-1)?.params.previousResultId).toBeUndefined(),
    );
    process.stdout.write(
      encodeMessage({
        id: requests.at(-1)!.id,
        result: { kind: "full", items: [] },
      }),
    );
    await refreshed;
  });

  it("does not let stale pull responses overwrite the current document snapshot", async () => {
    const dir = temp();
    const file = join(dir, "sample.rb");
    writeFileSync(file, "first");
    const { client, process, requests } = setup(dir);
    const first = client.diagnostics(file, "ruby", { diagnosticProvider: {} });
    await vi.waitFor(() =>
      expect(requests.at(-1)?.method).toBe("textDocument/diagnostic"),
    );
    const firstRequest = requests.at(-1)!;
    writeFileSync(file, "second");
    const second = client.diagnostics(file, "ruby", { diagnosticProvider: {} });
    await vi.waitFor(() =>
      expect(requests.at(-1)?.id).not.toBe(firstRequest.id),
    );
    const secondRequest = requests.at(-1)!;
    process.stdout.write(
      encodeMessage({
        id: secondRequest.id,
        result: { kind: "full", resultId: "second", items: [] },
      }),
    );
    process.stdout.write(
      encodeMessage({
        id: firstRequest.id,
        result: { kind: "full", resultId: "first", items: [] },
      }),
    );
    await expect(second).resolves.toMatchObject({ fresh: true });
    await expect(first).resolves.toMatchObject({ fresh: false, stale: true });

    const current = client.diagnostics(file, "ruby", {
      diagnosticProvider: {},
    });
    await vi.waitFor(() =>
      expect(requests.at(-1)?.params.previousResultId).toBe("second"),
    );
    process.stdout.write(
      encodeMessage({
        id: requests.at(-1)!.id,
        result: { kind: "unchanged", resultId: "second" },
      }),
    );
    await expect(current).resolves.toMatchObject({ fresh: true });
  });

  it("accepts versionless push diagnostics for the synchronized snapshot", async () => {
    const dir = temp();
    const file = join(dir, "sample.ts");
    writeFileSync(file, "one");
    const { client, process } = setup(dir);
    const document = await client.synchronize(file, "typescript");
    process.stdout.write(
      encodeMessage({
        method: "textDocument/publishDiagnostics",
        params: {
          uri: document.uri,
          diagnostics: [{ message: "valid", range: {} }],
        },
      }),
    );
    await expect(
      client.diagnostics(file, "typescript", {}),
    ).resolves.toMatchObject({
      fresh: true,
      diagnostics: [expect.objectContaining({ message: "valid" })],
    });
  });

  it("never treats versionless diagnostics after a change as fresh", async () => {
    const dir = temp();
    const file = join(dir, "sample.ts");
    writeFileSync(file, "one");
    const { client, process, requests } = setup(dir);
    const first = await client.synchronize(file, "typescript");
    writeFileSync(file, "two");
    const diagnostics = client.diagnostics(
      file,
      "typescript",
      {},
      { timeoutMs: 25 },
    );
    await vi.waitFor(() =>
      expect(requests.at(-1)?.method).toBe("textDocument/didChange"),
    );
    process.stdout.write(
      encodeMessage({
        method: "textDocument/publishDiagnostics",
        params: {
          uri: first.uri,
          diagnostics: [{ message: "delayed", range: {} }],
        },
      }),
    );
    await expect(diagnostics).resolves.toMatchObject({
      fresh: false,
      diagnostics: [],
    });
  });

  it("waits for a changed push snapshot instead of accepting an old publication", async () => {
    const dir = temp();
    const file = join(dir, "sample.ts");
    writeFileSync(file, "one");
    const { client, process } = setup(dir);
    const first = await client.synchronize(file, "typescript");
    process.stdout.write(
      encodeMessage({
        method: "textDocument/publishDiagnostics",
        params: {
          uri: first.uri,
          version: 1,
          diagnostics: [{ message: "old", range: {} }],
        },
      }),
    );
    writeFileSync(file, "two");
    const waiting = client.diagnostics(
      file,
      "typescript",
      {},
      { timeoutMs: 100 },
    );
    process.stdout.write(
      encodeMessage({
        method: "textDocument/publishDiagnostics",
        params: {
          uri: first.uri,
          version: 1,
          diagnostics: [{ message: "still old", range: {} }],
        },
      }),
    );
    process.stdout.write(
      encodeMessage({
        method: "textDocument/publishDiagnostics",
        params: {
          uri: first.uri,
          version: 2,
          diagnostics: [{ message: "new", range: {} }],
        },
      }),
    );
    await expect(waiting).resolves.toMatchObject({ fresh: true });
  });

  it("propagates cancellation while waiting for push diagnostics", async () => {
    const dir = temp();
    const file = join(dir, "sample.ts");
    writeFileSync(file, "one");
    const { client } = setup(dir);
    const controller = new AbortController();
    const waiting = client.diagnostics(
      file,
      "typescript",
      {},
      {
        timeoutMs: 100,
        signal: controller.signal,
      },
    );
    controller.abort();
    await expect(waiting).rejects.toThrow("cancelled");
  });

  it("sends exit after graceful shutdown and skips the handshake when forced", async () => {
    const dir = temp();
    const file = join(dir, "sample.ts");
    writeFileSync(file, "one");
    const root = realpathSync(dir);
    const graceful = setup(root);
    const initialization = graceful.client.initialize(pathToFileURL(root).href);
    await vi.waitFor(() =>
      expect(graceful.requests.at(-1)?.method).toBe("initialize"),
    );
    graceful.process.stdout.write(
      encodeMessage({
        id: graceful.requests.at(-1)!.id,
        result: { capabilities: {} },
      }),
    );
    await initialization;
    await graceful.client.synchronize(file, "typescript");
    const closing = graceful.client.shutdown();
    await vi.waitFor(() =>
      expect(graceful.requests.at(-1)?.method).toBe("shutdown"),
    );
    graceful.process.stdout.write(
      encodeMessage({ id: graceful.requests.at(-1)!.id, result: null }),
    );
    await closing;
    expect(graceful.requests.map((request) => request.method)).toContain(
      "textDocument/didClose",
    );
    expect(graceful.requests.map((request) => request.method)).toContain(
      "exit",
    );

    const forced = setup(dir);
    await forced.client.synchronize(file, "typescript");
    await forced.client.shutdown({ force: true });
    expect(forced.requests.map((request) => request.method)).toEqual([
      "textDocument/didOpen",
      "textDocument/didClose",
    ]);
  });

  it("rejects files and diagnostic publications outside its workspace", async () => {
    const dir = temp();
    const outside = temp();
    const file = join(outside, "sample.ts");
    const inside = join(dir, "sample.ts");
    writeFileSync(file, "one");
    writeFileSync(inside, "one");
    const { client, process } = setup(dir);
    await expect(client.synchronize(file, "typescript")).rejects.toThrow(
      "outside workspace",
    );
    process.stdout.write(
      encodeMessage({
        method: "textDocument/publishDiagnostics",
        params: {
          uri: `file://${file}`,
          version: 1,
          diagnostics: [{ message: "outside", range: {} }],
        },
      }),
    );
    await new Promise((resolve) => setImmediate(resolve));
    expect(
      await client.diagnostics(inside, "typescript", {}, { timeoutMs: 1 }),
    ).toMatchObject({ fresh: false });
  });
});
