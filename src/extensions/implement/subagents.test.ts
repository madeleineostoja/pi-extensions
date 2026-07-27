import { describe, expect, it } from "vitest";
import {
  mutableWorkerExcludedTools,
  readOnlyWorkerTools,
} from "./subagents.js";

describe("managed Pipkin Implement worker tools", () => {
  it("excludes public agent controls from mutable workers", () => {
    expect(mutableWorkerExcludedTools()).toEqual(
      expect.arrayContaining([
        "Agent",
        "get_subagent_result",
        "steer_subagent",
      ]),
    );
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
