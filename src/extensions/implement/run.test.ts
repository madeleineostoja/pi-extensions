import { describe, expect, it } from "vitest";
import { stopRun, type ActiveRun } from "./run.js";

describe("active run shutdown", () => {
  it("settles completion cleanup before releasing the checkout lease", async () => {
    const calls: string[] = [];
    const active = {
      actor: {
        async stop() {
          calls.push("stop");
        },
      },
      lease: {
        async release() {
          calls.push("release");
        },
      },
    } as unknown as ActiveRun;

    await stopRun(active, "interrupted", async () => {
      calls.push("cleanup");
    });

    expect(calls).toEqual(["stop", "cleanup", "release"]);
  });
});
