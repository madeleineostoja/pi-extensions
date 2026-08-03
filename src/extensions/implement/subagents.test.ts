import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  mutableWorkerExcludedTools,
  readOnlyWorkerTools,
  type ImplementRoles,
} from "./subagents.js";
import { spawnValidatedWorker } from "./worker-invocation.js";

describe("managed Pipkin Implement worker tools", () => {
  it("excludes orchestration inspection and public agent controls from mutable workers", () => {
    expect(mutableWorkerExcludedTools()).toEqual([
      "inspect_implement_run",
      "Agent",
      "get_subagent_result",
      "steer_subagent",
    ]);
  });

  it("keeps managed runtime ownership in the Implement adapter", () => {
    const directory = dirname(fileURLToPath(import.meta.url));
    const owners = readdirSync(directory, {
      recursive: true,
      encoding: "utf8",
    })
      .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
      .filter((name) => {
        const source = readFileSync(join(directory, name), "utf-8");
        return (
          source.includes("runManagedAgent") ||
          source.includes("#subagents/runtime")
        );
      });

    expect(owners).toEqual(["subagents.ts"]);
  });

  it("keeps Bash verification while excluding public agent controls", () => {
    const selection = readOnlyWorkerTools([
      "read",
      "bash",
      "start_process",
      "get_process_result",
      "stop_process",
      "bash_outcome",
      "context_recall",
      "Agent",
      "get_subagent_result",
      "steer_subagent",
      "record_papercut",
      "edit",
    ]);

    expect(selection.tools).toEqual([
      "read",
      "bash",
      "start_process",
      "get_process_result",
      "stop_process",
      "bash_outcome",
      "context_recall",
      "record_papercut",
    ]);
    expect(selection.excludeTools).toEqual(
      expect.arrayContaining([
        "Agent",
        "get_subagent_result",
        "steer_subagent",
        "edit",
        "write",
      ]),
    );
  });

  it("maps every completion owner to the established read-only or mutable admission", async () => {
    const spawn = vi.fn(async () => "worker");
    const roles: ImplementRoles = {
      planner: {
        type: "pipkin:implement:planner",
        model: "test/planner",
        thinking: "high",
      },
      reviewer: {
        type: "pipkin:implement:reviewer",
        model: "test/reviewer",
        thinking: "high",
      },
      implementer: {
        type: "pipkin:implement:implementer",
        model: "test/implementer",
        thinking: "medium",
      },
    };
    const completionKinds = [
      ["planner", "planner", true],
      ["implementer", "implementer", false],
      ["overall-rework", "implementer", false],
      ["initial-overall-review", "reviewer", true],
      ["initial-review", "reviewer", true],
      ["repository-state-review", "reviewer", true],
      ["initial-anchored-review", "reviewer", true],
      ["anchored-review", "reviewer", true],
      ["initial-anchored-overall-review", "reviewer", true],
      ["anchored-overall-review", "reviewer", true],
      ["reconciliation", "implementer", false],
      ["revision", "implementer", false],
    ] as const;

    for (const [completionKind, role, readOnly] of completionKinds) {
      await spawnValidatedWorker({
        packet: {
          completionKind,
          identity: completionKind,
          workspace: { path: "/worktree" },
        },
        subagents: { spawn } as never,
        roles,
        taskId: "task",
        description: completionKind,
        render: () => "Complete the assignment.",
      });
      expect(spawn).toHaveBeenLastCalledWith(
        expect.objectContaining({
          type: `pipkin:implement:${role}`,
          role,
          ...(readOnly ? { readOnly: true } : {}),
          prompt: expect.stringContaining(
            "sole allowed personal-metadata write",
          ),
        }),
      );
    }
    expect(spawn).toHaveBeenCalledTimes(completionKinds.length);
  });

  it("does not retain Context Bash companions after active-tool filtering", () => {
    expect(
      readOnlyWorkerTools(["read", "bash_outcome", "context_recall"]).tools,
    ).toEqual(["read"]);
    expect(readOnlyWorkerTools(["read", "bash", "bash_outcome"]).tools).toEqual(
      ["read", "bash"],
    );
    expect(
      readOnlyWorkerTools(["read", "get_process_result", "stop_process"]).tools,
    ).toEqual(["read", "get_process_result", "stop_process"]);
    expect(
      readOnlyWorkerTools(["read", "bash", "start_process", "context_recall"])
        .tools,
    ).toEqual(["read", "bash", "start_process", "context_recall"]);
    expect(
      readOnlyWorkerTools(["read", "bash", "context_recall"]).tools,
    ).toEqual(["read", "bash", "context_recall"]);
  });
});
