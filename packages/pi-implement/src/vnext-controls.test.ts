import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkoutPaths } from "./vnext-store.js";
import { listCheckoutVNextRuns } from "./vnext-controls.js";

const temporaryDirectories = new Set<string>();

afterEach(() => {
  for (const directory of temporaryDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
  temporaryDirectories.clear();
});

describe("VNext controls", () => {
  it("reports malformed retained directories as manual-only historical artifacts", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-implement-controls-"));
    temporaryDirectories.add(root);
    const path = join(checkoutPaths(root).runs, "old-run");
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, "run-state.json"), "historical state");

    expect(listCheckoutVNextRuns(root)).toEqual([
      { kind: "historical", runId: "old-run" },
    ]);
  });
});
