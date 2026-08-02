import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { createManagedSessionHarness } from "#test/managed-session";
import sandbox from "../../src/extensions/sandbox/index.ts";
import {
  bindSandboxHost,
  prepareSandboxChild,
} from "../../src/extensions/sandbox/runtime.ts";
import { afterEach, describe, expect, it } from "vitest";

const directories: string[] = [];

afterEach(async () => {
  while (directories.length) {
    rmSync(directories.pop()!, { force: true, recursive: true });
  }
});

describe("Sandbox child binding", () => {
  it("consumes a prepared disabled mode while binding one Bash owner at the child cwd", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "pipkin-sandbox-child-"));
    directories.push(workspace);
    const parentBus = createEventBus();
    const childBus = createEventBus();
    const parent = bindSandboxHost(parentBus, () => false);
    const pending = prepareSandboxChild(parentBus, childBus);
    const harness = await createManagedSessionHarness([], {
      extensionFactories: [sandbox],
      eventBus: childBus,
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
    const childProbe = bindSandboxHost(childBus, () => true);
    expect(childProbe.inheritedEnabled).toBeUndefined();
    childProbe.dispose();
    pending?.dispose();
    parent.dispose();
    await session.dispose();
  });
});
