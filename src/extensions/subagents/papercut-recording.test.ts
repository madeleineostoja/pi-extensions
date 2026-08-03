import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import {
  createManagedSessionHarness,
  managedSessionContext,
} from "#test/managed-session";
import { registerRecordTool } from "../papercuts/record-tool.js";
import { createPapercutStatusController } from "../papercuts/status.js";
import { afterEach, describe, expect, it } from "vitest";
import { SubagentRuntime } from "./runtime.js";

const roots: string[] = [];

function recordPapercutExtension(
  pi: Parameters<typeof registerRecordTool>[0],
): void {
  registerRecordTool(pi, createPapercutStatusController());
}

afterEach(() => {
  while (roots.length) {
    rmSync(roots.pop()!, { force: true, recursive: true });
  }
});

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}

function linkedRepository(): { root: string; linked: string } {
  const root = mkdtempSync(join(tmpdir(), "pipkin-subagent-papercut-"));
  roots.push(root);
  git(root, "init", "-q");
  git(root, "config", "user.email", "test@example.com");
  git(root, "config", "user.name", "Test");
  writeFileSync(join(root, "README.md"), "fixture\n");
  git(root, "add", "README.md");
  git(root, "commit", "-qm", "fixture");
  const linked = join(root, "linked");
  git(root, "worktree", "add", "-qb", "linked", linked);
  return { root, linked };
}

describe("public papercut recording", () => {
  it("records directly from a read-only linked-worktree child after removal", async () => {
    const { root, linked } = linkedRepository();
    const harness = await createManagedSessionHarness(
      [
        fauxAssistantMessage(
          fauxToolCall(
            "record_papercut",
            {
              key: "linked-discovery",
              title: "Linked discovery detour",
              task: "Explore an unrelated repository behavior",
              incident:
                "The validation convention required undocumented discovery.",
              evidence:
                "The scripts and CI configuration disagreed about the documented command.",
              workarounds: ["Inspected the scripts and CI configuration."],
              taskOutcome: "Completed the requested exploration safely.",
            },
            { id: "record" },
          ),
        ),
        fauxAssistantMessage("Recorded the incidental friction."),
      ],
      { extensionFactories: [recordPapercutExtension] },
    );
    const pi = {
      getActiveTools: () => [
        "read",
        "bash",
        "bash_outcome",
        "context_recall",
        "edit",
        "write",
        "Agent",
        "get_subagent_result",
        "steer_subagent",
        "record_papercut",
      ],
      sendMessage() {},
    };
    const runtime = new SubagentRuntime(pi as never, {
      createSession: harness.createSession,
    });

    await expect(
      runtime.runPublicAgent({
        type: "Explore",
        prompt: "Inspect the assigned behavior.",
        cwd: linked,
        ctx: managedSessionContext(harness) as never,
      }),
    ).resolves.toMatchObject({ status: "completed" });
    git(root, "worktree", "remove", "--force", linked);
    const registry = join(root, ".pi", "pipkin", "papercuts.json");
    expect(existsSync(registry)).toBe(true);
    expect(JSON.parse(readFileSync(registry, "utf8"))).toMatchObject({
      records: [expect.objectContaining({ key: "linked-discovery" })],
    });
    await runtime.dispose();
  });
});
