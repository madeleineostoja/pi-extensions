import { afterEach, describe, expect, it } from "vitest";
import { bindSandboxBashExecutor } from "./bash-binding.js";
import {
  createSandboxBashDefinition,
  createSandboxBashRuntime,
} from "./bash.js";
import { registerBashOutcomeTool } from "../context/bash-outcome.ts";
import { decodeRetainedResult } from "../context/retained-result.ts";

type ToolDefinition = {
  execute: (...args: any[]) => Promise<any>;
};

function executionContext() {
  return {
    sessionManager: {
      getSessionFile: () => undefined,
      getSessionId: () => "test-session",
    },
  } as never;
}

describe("bash_outcome Sandbox composition", () => {
  const disposers: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    while (disposers.length) {
      await disposers.pop()?.();
    }
  });

  it("uses the bound public Bash definition for result, updates, and validation", async () => {
    const host = {};
    const runtime = createSandboxBashRuntime({
      enabled: () => false,
      supportedMac: true,
    });
    const bash = createSandboxBashDefinition(process.cwd(), runtime);
    const binding = bindSandboxBashExecutor(host as never, (request) =>
      bash.execute(
        request.toolCallId,
        request.params,
        request.signal,
        request.onUpdate,
        request.ctx,
      ),
    );
    disposers.push(binding.dispose, runtime.dispose);
    let outcome: ToolDefinition | undefined;
    registerBashOutcomeTool({
      events: host,
      getActiveTools: () => ["bash", "bash_outcome"],
      registerTool: (definition: ToolDefinition) => (outcome = definition),
    } as never);
    const ctx = executionContext();
    const updates: unknown[] = [];

    const publicResult = await bash.execute(
      "public",
      { command: "printf shared" },
      undefined,
      undefined,
      ctx,
    );
    const projected = await outcome!.execute(
      "outcome",
      { command: "printf shared" },
      undefined,
      (update: unknown) => updates.push(update),
      ctx,
    );

    expect(decodeRetainedResult(projected.details)).toEqual(publicResult);
    expect(updates).not.toHaveLength(0);
    await expect(
      bash.execute(
        "invalid-public",
        { command: "true", timeout: 0 },
        undefined,
        undefined,
        ctx,
      ),
    ).rejects.toThrow("Invalid timeout");
    await expect(
      outcome!.execute(
        "invalid-outcome",
        { command: "true", timeout: 0 },
        undefined,
        undefined,
        ctx,
      ),
    ).rejects.toThrow("Invalid timeout");

    binding.dispose();
    await expect(
      outcome!.execute(
        "revoked",
        { command: "true" },
        undefined,
        undefined,
        ctx,
      ),
    ).rejects.toThrow("unavailable");
  });
});
