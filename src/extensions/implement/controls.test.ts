import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listCheckoutRuns } from "./controls.js";
import { checkoutPaths } from "./store.js";

const temporaryDirectories = new Set<string>();

afterEach(() => {
  for (const directory of temporaryDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
  temporaryDirectories.clear();
});

describe("retained run listing", () => {
  it("reports malformed retained directories as manual-only historical artifacts", () => {
    const root = mkdtempSync(join(tmpdir(), "pipkin-implement-controls-"));
    temporaryDirectories.add(root);
    const path = join(checkoutPaths(root).runs, "old-run");
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, "run-state.json"), "historical state");

    expect(listCheckoutRuns(root)).toEqual([
      { kind: "historical", runId: "old-run" },
    ]);
  });
});
