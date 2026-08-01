import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  createSandboxDenialObserver,
  parseSandboxWriteDenial,
} from "./denial-observer.js";
import { createSandboxDenialRecorder } from "./denials.js";

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  exitCode: number | null = null;
  killed = false;

  kill(): boolean {
    this.killed = true;
    this.exitCode = 0;
    this.emit("close", 0);
    return true;
  }
}

describe("Sandbox denial observer", () => {
  it("parses only kernel file-write reports", () => {
    expect(
      parseSandboxWriteDenial(
        "Sandbox: touch(42) deny(1) file-write-create /tmp/blocked\nPIPKIN_ABC",
      ),
    ).toEqual({
      process: "touch",
      pid: 42,
      operation: "file-write-create",
      path: "/tmp/blocked",
    });
    expect(
      parseSandboxWriteDenial("Sandbox: cat(42) deny(1) file-read-data /tmp/x"),
    ).toBeUndefined();
  });

  it("records chunked reports only for active marked Bash invocations", async () => {
    const recorder = createSandboxDenialRecorder();
    const child = new FakeChild();
    const observer = createSandboxDenialObserver({
      denials: recorder,
      spawn: () => child as never,
    });
    observer.start();
    const release = observer.registerBashInvocation("PIPKIN_ABC123");
    child.stdout.write(
      '{"eventMessage":"Sandbox: touch(42) deny(1) file-write-create ',
    );
    child.stdout.write('/tmp/blocked\\nPIPKIN_ABC123"}\n');
    await new Promise((resolve) => setImmediate(resolve));
    expect(recorder.snapshot()).toMatchObject({
      count: 1,
      recent: [
        {
          kind: "bash",
          process: "touch",
          pid: 42,
          operation: "file-write-create",
          path: "/tmp/blocked",
        },
      ],
    });
    child.stdout.write(
      '{"eventMessage":"Sandbox: cat(43) deny(1) file-read-data /tmp/blocked\\nPIPKIN_ABC123"}\n',
    );
    child.stdout.write(
      '{"eventMessage":"Sandbox: touch(44) deny(1) file-write-create /tmp/other\\nPIPKIN_OTHER"}\n',
    );
    child.stdout.write(
      '{"eventMessage":"Sandbox: touch(45) deny(1) file-write-create /tmp/other\\nPIPKIN_ABC1234"}\n',
    );
    await new Promise((resolve) => setImmediate(resolve));
    expect(recorder.snapshot().count).toBe(1);
    release();
    await observer.dispose();
    expect(child.killed).toBe(true);
  });

  it("preserves UTF-8 split across log chunks", async () => {
    const recorder = createSandboxDenialRecorder();
    const child = new FakeChild();
    const observer = createSandboxDenialObserver({
      denials: recorder,
      spawn: () => child as never,
    });
    observer.start();
    observer.registerBashInvocation("PIPKIN_ABC123");
    const data = Buffer.from(
      '{"eventMessage":"Sandbox: touch(42) deny(1) file-write-create /tmp/blöcked\\nPIPKIN_ABC123"}\n',
    );
    const split = data.indexOf(Buffer.from("ö")) + 1;
    child.stdout.write(data.subarray(0, split));
    child.stdout.write(data.subarray(split));
    await new Promise((resolve) => setImmediate(resolve));
    expect(recorder.snapshot().recent[0]).toMatchObject({
      path: "/tmp/blöcked",
    });
    await observer.dispose();
  });

  it("ignores malformed log events and is idempotently disposable", async () => {
    const recorder = createSandboxDenialRecorder();
    const child = new FakeChild();
    const observer = createSandboxDenialObserver({
      denials: recorder,
      spawn: () => child as never,
    });
    observer.start();
    observer.registerBashInvocation("PIPKIN_ABC123");
    child.stdout.write("not json\n");
    child.stdout.write('{"eventMessage":42}\n');
    await observer.dispose();
    await observer.dispose();
    expect(recorder.snapshot().count).toBe(0);
  });
});
