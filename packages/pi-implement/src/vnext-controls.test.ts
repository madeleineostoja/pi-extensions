import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkoutPaths } from "./vnext-store.js";
import { listCheckoutVNextRuns } from "./vnext-controls.js";

describe("VNext controls", () => {
  it("reports malformed retained directories as manual-only historical artifacts", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-implement-controls-"));
    const path = join(checkoutPaths(root).runs, "old-run");
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, "run-state.json"), "historical state");

    expect(listCheckoutVNextRuns(root)).toEqual([
      { kind: "historical", runId: "old-run" },
    ]);
  });
});
