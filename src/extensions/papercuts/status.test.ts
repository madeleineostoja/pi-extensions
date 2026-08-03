import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPapercutStatusController } from "./status.js";

const roots: string[] = [];

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), "pipkin-papercuts-status-"));
  roots.push(root);
  execFileSync("git", ["init", "-q"], { cwd: root });
  return root;
}

afterEach(() =>
  roots
    .splice(0)
    .forEach((root) => rmSync(root, { recursive: true, force: true })),
);

describe("papercut status", () => {
  it("refreshes at supported lifecycle points and clears at shutdown", async () => {
    const status = createPapercutStatusController();
    const setStatus = vi.fn();
    const ctx = {
      cwd: repo(),
      mode: "tui",
      ui: { setStatus, theme: { fg: (_tone: string, text: string) => text } },
    };
    await status.sessionStart(ctx as never);
    expect(setStatus).toHaveBeenLastCalledWith(
      "pipkin:status:0300:papercuts",
      undefined,
    );
    await (
      await status.storeFor(ctx as never)
    ).record({
      key: "finding",
      title: "Finding",
      task: "Task",
      incident: "Incident",
      evidence: "Evidence",
      workarounds: ["Worked around it."],
      taskOutcome: "Continued.",
    });
    await status.refreshStatus(ctx as never);
    expect(setStatus).toHaveBeenLastCalledWith(
      "pipkin:status:0300:papercuts",
      "󰶯 1 papercuts",
    );
    status.sessionShutdown(ctx as never);
    expect(setStatus).toHaveBeenLastCalledWith(
      "pipkin:status:0300:papercuts",
      undefined,
    );
  });
});
