import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createManagedSessionHarness } from "#test/managed-session";
import sandbox from "../../src/extensions/sandbox/index.ts";
import { afterEach, describe, expect, it } from "vitest";

const directories: string[] = [];

afterEach(async () => {
  while (directories.length) {
    rmSync(directories.pop()!, { force: true, recursive: true });
  }
});

describe("Sandbox child binding", () => {
  it("binds a fresh Sandbox Bash owner at a managed child's cwd", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "pipkin-sandbox-child-"));
    directories.push(workspace);
    const harness = await createManagedSessionHarness([], {
      extensionFactories: [sandbox],
    });
    const { session } = await harness.createSession({ cwd: workspace });
    await session.bindExtensions({
      mode: "print",
      abortHandler: () => void session.abort(),
      shutdownHandler: () => {},
    });

    expect(
      session.getAllTools().filter((tool) => tool.name === "bash"),
    ).toHaveLength(1);
    expect(
      session.getAllTools().find((tool) => tool.name === "bash")?.name,
    ).toBe("bash");
    await session.dispose();
  });
});
