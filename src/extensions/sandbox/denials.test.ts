import { describe, expect, it, vi } from "vitest";
import { createSandboxDenialRecorder } from "./denials.js";

describe("Sandbox denial recorder", () => {
  it("keeps a bounded recent history while retaining the session count", () => {
    const recorder = createSandboxDenialRecorder();
    const changed = vi.fn();
    const unsubscribe = recorder.subscribe(changed);
    for (let index = 0; index < 12; index += 1) {
      recorder.recordDirect({
        tool: "write",
        requestedPath: `file-${index}`,
        reason: "blocked",
      });
    }
    expect(recorder.snapshot()).toMatchObject({ count: 12 });
    expect(recorder.snapshot().recent).toHaveLength(10);
    expect(recorder.snapshot().recent[0]).toMatchObject({
      requestedPath: "file-2",
    });
    expect(changed).toHaveBeenCalledTimes(12);
    unsubscribe();
    recorder.reset();
    expect(recorder.snapshot()).toEqual({ count: 0, recent: [] });
    expect(changed).toHaveBeenCalledTimes(12);
  });

  it("bounds control characters in diagnostic values", () => {
    const recorder = createSandboxDenialRecorder();
    recorder.recordBash({
      process: "touch\n",
      pid: 42,
      operation: "file-write-create",
      path: "/tmp/target\u0000",
    });
    expect(recorder.snapshot().recent[0]).toMatchObject({
      process: "touch�",
      path: "/tmp/target�",
    });
  });
});
