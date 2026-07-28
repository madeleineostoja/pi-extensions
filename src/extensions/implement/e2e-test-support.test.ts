import { describe, expect, it } from "vitest";
import { ScriptedSubagentClient } from "./e2e-test-support.js";

describe("scripted worker capability", () => {
  it("refuses artifact and target reads outside the assigned candidate root", () => {
    const candidate = "/workspace/candidate";
    const client = new ScriptedSubagentClient([], [candidate]);

    expect(() =>
      client.assertReadable("/workspace/candidate/src/app.ts"),
    ).not.toThrow();
    expect(() =>
      client.assertReadable("/workspace/artifacts/review.json"),
    ).toThrow("outside its assigned roots");
    expect(() => client.assertReadable("/workspace/target/app.ts")).toThrow(
      "outside its assigned roots",
    );
  });
});
