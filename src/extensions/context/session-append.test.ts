import { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { EPOCH_TYPE } from "./policy.ts";
import { appendEpochAtomically } from "./session-append.ts";

const epoch = {
  kind: "tail" as const,
  decisions: [
    {
      sourceToolCallId: "source",
      reason: "standard-stale" as const,
      stub: '[tool result elided: stale. Call context_recall("source") to retrieve.]',
    },
  ],
};

describe("appendEpochAtomically", () => {
  it("rolls back Pi session state when persistence fails after appending", () => {
    const manager = SessionManager.inMemory("/work") as any;
    manager.appendMessage({ role: "user", content: "before", timestamp: 1 });
    const beforeEntries = manager.getEntries();
    const beforeLeaf = manager.getLeafId();
    manager._persist = () => {
      throw new Error("disk unavailable");
    };
    const pi = {
      appendEntry: (type: string, data: unknown) =>
        manager.appendCustomEntry(type, data),
    };
    const ctx = { sessionManager: manager };

    expect(() =>
      appendEpochAtomically(pi as never, ctx as never, EPOCH_TYPE, epoch),
    ).toThrow("disk unavailable");
    expect(manager.getEntries()).toEqual(beforeEntries);
    expect(manager.getLeafId()).toBe(beforeLeaf);
  });

  it("leaves one complete epoch after a successful append", () => {
    const manager = SessionManager.inMemory("/work");
    const pi = {
      appendEntry: (type: string, data: unknown) =>
        manager.appendCustomEntry(type, data),
    };

    appendEpochAtomically(
      pi as never,
      { sessionManager: manager } as never,
      EPOCH_TYPE,
      epoch,
    );

    expect(manager.getBranch()).toEqual([
      expect.objectContaining({ customType: EPOCH_TYPE, data: epoch }),
    ]);
  });
});
