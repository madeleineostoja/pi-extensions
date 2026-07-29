import { createHash } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compileExecutionPlan } from "./execution-plan.js";
import { buildMaterialStore } from "./material-store.js";
import { parsePlan } from "./plan.js";
import {
  checkoutPaths,
  createPlanningRun,
  sourceIdentityForExecutionPlan,
  type CheckoutLeaseCapability,
} from "./store.js";
import {
  buildWorkstreamPacket,
  workstreamWorkspace,
} from "./workstream-candidate.js";

const roots = new Set<string>();

afterEach(() => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
  roots.clear();
});

function fakeLease(root: string): CheckoutLeaseCapability {
  const paths = checkoutPaths(root);
  return {
    paths,
    owner: {
      runId: "run-1",
      runPath: join(paths.runs, "run-1"),
      checkoutRoot: root,
      gitDir: join(root, ".git"),
      pid: process.pid,
      hostname: "test",
      startedAt: "2026-01-01T00:00:00.000Z",
    },
    assertOwned() {},
    async release() {},
  };
}

describe("workstream packet", () => {
  it("embeds task blocks and ignores non-corpus document hints without Git", async () => {
    const root = mkdtempSync(join(tmpdir(), "pipkin-implement-packet-"));
    roots.add(root);
    const planPath = join(root, "plan.md");
    const content = "# Plan\n\n## Tasks\n\n- [ ] First\n- [ ] Second\n";
    writeFileSync(planPath, content);
    const parsed = parsePlan(planPath, content);
    const materialStore = buildMaterialStore({
      plan: parsed,
      planPath,
      repoRoot: root,
    });
    const compiled = compileExecutionPlan(
      {
        version: 1,
        tasks: ["First", "Second"].map((title, index) => ({
          id: title.toLowerCase(),
          planIndex: index + 1,
          title,
          dependsOn: [],
          supportingDocuments:
            index === 0 ? ["ai/src/evals/scorers/scorer-configuration.ts"] : [],
          compiledContract: {
            objective: `Implement ${title}.`,
            inScope: [title],
            acceptanceCriteria: [`${title} works.`],
            outOfScope: ["Unrelated work"],
          },
        })),
        workstreams: [
          {
            id: "combined",
            taskIds: ["first", "second"],
            dependsOn: [],
          },
        ],
      },
      {
        plan: parsed,
        planHash: createHash("sha256").update(content).digest("hex"),
        materialStore,
        checkoutId: join(root, ".git"),
        baseSha: "base-sha",
        workerConcurrency: 1,
      },
    );
    if (!compiled.ok) {
      throw new Error(compiled.reason);
    }
    const run = createPlanningRun({
      lease: fakeLease(root),
      runId: "run-1",
      checkout: {
        root,
        gitDir: join(root, ".git"),
        commonGitDir: join(root, ".git"),
        branchRef: "refs/heads/main",
        startHead: "base-sha",
      },
      source: sourceIdentityForExecutionPlan(compiled.value),
      workerConcurrency: 1,
    });
    await run.bindExecutionPlan(compiled.value);
    const state = run.read();
    await run.update(state.revision, (current) => ({
      ...current,
      workstreams: {
        ...current.workstreams,
        source: {
          ...current.workstreams.source,
          combined: {
            ...current.workstreams.source.combined!,
            baseSha: "base-sha",
          },
        },
      },
    }));

    const packet = buildWorkstreamPacket({
      state: run.read(),
      plan: compiled.value,
      workstreamId: "combined",
      workspace: workstreamWorkspace(run.read(), "combined"),
    });

    expect(packet.tasks.map((task) => task.id)).toEqual(["first", "second"]);
    expect(packet.sourceMaterial).toEqual([
      { path: `${realpathSync(planPath)}:5`, content: "- [ ] First" },
      { path: `${realpathSync(planPath)}:6`, content: "- [ ] Second\n" },
    ]);
  });
});
