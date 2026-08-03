import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  mutableWorkerExcludedTools,
  readOnlyWorkerTools,
} from "./subagents.js";

describe("managed Pipkin Implement worker tools", () => {
  it("excludes orchestration inspection and public agent controls from mutable workers", () => {
    expect(mutableWorkerExcludedTools()).toEqual(
      expect.arrayContaining([
        "inspect_implement_run",
        "Agent",
        "get_subagent_result",
        "steer_subagent",
      ]),
    );
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
      "Agent",
      "get_subagent_result",
      "steer_subagent",
      "edit",
    ]);

    expect(selection.tools).toEqual(["read", "bash"]);
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
});
