import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Check } from "typebox/value";
import {
  PapercutObservationSchema,
  registerRecordTool,
} from "./record-tool.js";
import { createPapercutStatusController } from "./status.js";

const roots: string[] = [];
function repo(): string {
  const root = mkdtempSync(join(tmpdir(), "pipkin-record-tool-"));
  roots.push(root);
  execFileSync("git", ["init", "-q"], { cwd: root });
  return root;
}
afterEach(() =>
  roots
    .splice(0)
    .forEach((root) => rmSync(root, { recursive: true, force: true })),
);

const observation = {
  key: "validation-convention",
  title: "Undocumented validation convention",
  task: "Implement unrelated work",
  incident: "Had to discover validation.",
  evidence: "Scripts showed the convention.",
  workarounds: ["Inspected scripts.", "Ran the command."],
  taskOutcome: "Completed validation safely.",
  suggestedDestination: "docs" as const,
};

describe("record_papercut", () => {
  it("registers the bounded factual incident schema and eligibility guidance", () => {
    let tool: any;
    registerRecordTool(
      {
        registerTool: (definition: unknown) => {
          tool = definition;
        },
      } as never,
      createPapercutStatusController(),
    );
    expect(tool.name).toBe("record_papercut");
    expect(
      JSON.parse(JSON.stringify(PapercutObservationSchema))
        .additionalProperties,
    ).toBe(false);
    expect(tool.parameters.properties.workarounds).toMatchObject({
      minItems: 1,
      maxItems: 5,
    });
    expect(tool.description).toContain("No outage");
    expect(tool.description).toContain("undocumented validation convention");
    expect(tool.description).toContain("manual worktree setup");
  });

  it("enforces every public observation bound, shape, and trim rule", () => {
    expect(Check(PapercutObservationSchema, observation)).toBe(true);
    expect(
      Check(PapercutObservationSchema, {
        ...observation,
        key: "a".repeat(64),
        title: "a".repeat(120),
        task: "a".repeat(1_000),
        incident: "a".repeat(2_000),
        evidence: "a".repeat(2_000),
        workarounds: Array.from({ length: 5 }, () => "a".repeat(1_000)),
        taskOutcome: "a".repeat(1_000),
        guardrailCandidate: "a".repeat(1_000),
      }),
    ).toBe(true);
    for (const [field, value] of Object.entries({
      key: "A-key",
      title: "a".repeat(121),
      task: "a".repeat(1_001),
      incident: "a".repeat(2_001),
      evidence: "a".repeat(2_001),
      taskOutcome: "a".repeat(1_001),
      guardrailCandidate: "a".repeat(1_001),
    })) {
      expect(
        Check(PapercutObservationSchema, { ...observation, [field]: value }),
      ).toBe(false);
    }
    for (const field of [
      "title",
      "task",
      "incident",
      "evidence",
      "taskOutcome",
      "guardrailCandidate",
    ]) {
      expect(
        Check(PapercutObservationSchema, { ...observation, [field]: " \n\t " }),
      ).toBe(false);
    }
    expect(
      Check(PapercutObservationSchema, { ...observation, workarounds: [" "] }),
    ).toBe(false);
    expect(
      Check(PapercutObservationSchema, { ...observation, workarounds: [] }),
    ).toBe(false);
    expect(
      Check(PapercutObservationSchema, {
        ...observation,
        workarounds: Array.from({ length: 6 }, () => "done"),
      }),
    ).toBe(false);
    expect(
      Check(PapercutObservationSchema, {
        ...observation,
        suggestedDestination: "other",
      }),
    ).toBe(false);
    expect(
      Check(PapercutObservationSchema, { ...observation, unexpected: true }),
    ).toBe(false);
    const {
      guardrailCandidate: _candidate,
      suggestedDestination: _destination,
      ...required
    } = { ...observation, guardrailCandidate: "Document it." };
    expect(Check(PapercutObservationSchema, required)).toBe(true);
  });

  it("trims accepted surrounding whitespace before persistence", async () => {
    const root = repo();
    const status = createPapercutStatusController();
    const ctx = {
      cwd: root,
      mode: "json",
      ui: { notify: vi.fn(), setStatus: vi.fn() },
    };
    expect(
      Check(PapercutObservationSchema, {
        ...observation,
        title: "  Undocumented validation convention  ",
        workarounds: ["  Inspected scripts.  "],
        guardrailCandidate: "  Document it.  ",
      }),
    ).toBe(true);
    const result = await (
      await status.storeFor(ctx as never)
    ).record({
      ...observation,
      title: "  Undocumented validation convention  ",
      workarounds: ["  Inspected scripts.  "],
      guardrailCandidate: "  Document it.  ",
    });
    expect(result).toMatchObject({ kind: "created" });
    expect(
      (await (await status.storeFor(ctx as never)).load()).records[0],
    ).toMatchObject({
      title: "Undocumented validation convention",
      workarounds: ["Inspected scripts."],
      guardrailCandidate: "Document it.",
    });
  });

  it("refreshes the open-count status after a successful registered record", async () => {
    let tool: any;
    registerRecordTool(
      { registerTool: (definition: unknown) => (tool = definition) } as never,
      createPapercutStatusController(),
    );
    const setStatus = vi.fn();
    const result = await tool.execute("id", observation, undefined, undefined, {
      cwd: repo(),
      mode: "tui",
      ui: {
        notify: vi.fn(),
        setStatus,
        theme: { fg: (_tone: string, text: string) => text },
      },
    });
    expect(result.details).toMatchObject({ outcome: "created" });
    expect(setStatus).toHaveBeenLastCalledWith(
      "pipkin:status:0300:papercuts",
      "󰶯 1 papercuts",
    );
  });

  it("returns only a bounded outcome, key, and occurrence count", async () => {
    let tool: any;
    registerRecordTool(
      {
        registerTool: (definition: unknown) => {
          tool = definition;
        },
      } as never,
      createPapercutStatusController(),
    );
    const ctx = {
      cwd: repo(),
      mode: "json",
      ui: { notify: vi.fn(), setStatus: vi.fn() },
    };
    const result = await tool.execute(
      "id",
      observation,
      undefined,
      undefined,
      ctx,
    );
    expect(result).toMatchObject({
      details: { outcome: "created", key: observation.key, occurrences: 1 },
    });
    expect(result.content[0].text).not.toContain(observation.incident);
    expect(
      Buffer.byteLength(result.content[0].text, "utf8"),
    ).toBeLessThanOrEqual(512);
  });
});
