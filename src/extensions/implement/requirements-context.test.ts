import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compileExecutionPlan } from "./execution-plan.js";
import { buildMaterialStore } from "./material-store.js";
import { parsePlan } from "./plan.js";
import {
  loadRequirementsContext,
  scopedRequirements,
  sourceCorpusPath,
  writeSourceCorpus,
} from "./requirements-context.js";

const roots = new Set<string>();

afterEach(() => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
  roots.clear();
});

describe("requirements context", () => {
  it("loads packet material from the frozen corpus after originals disappear", () => {
    const root = mkdtempSync(join(tmpdir(), "pipkin-requirements-"));
    roots.add(root);
    const planPath = join(root, "plan.md");
    const linkedPath = join(root, "docs", "compatibility.md");
    const content =
      "# Plan\n\n[Compatibility](docs/compatibility.md)\n\n- [ ] Add context\n";
    mkdirSync(join(root, "docs"));
    const compatibility = "Accepted compatibility boundary.\n";
    writeFileSync(planPath, content);
    writeFileSync(linkedPath, compatibility);
    const plan = parsePlan(planPath, content);
    const materialStore = buildMaterialStore({
      plan,
      planPath,
      repoRoot: root,
    });
    const compiled = compileExecutionPlan(
      {
        version: 1,
        tasks: [
          {
            id: "context",
            planIndex: 1,
            title: "Add context",
            dependsOn: [],
            supportingDocuments: ["compatibility.md"],
            compiledContract: {
              objective: "Keep the compatibility boundary.",
              inScope: ["Context"],
              acceptanceCriteria: ["Boundary is retained"],
              outOfScope: ["Redesign"],
            },
          },
        ],
        workstreams: [{ id: "context", taskIds: ["context"] }],
      },
      {
        plan,
        planHash: hash(content),
        materialStore,
        checkoutId: join(root, ".git"),
        baseSha: "base",
        workerConcurrency: 1,
      },
    );
    if (!compiled.ok) {
      throw new Error(compiled.reason);
    }
    const runDir = join(root, "run");
    writeSourceCorpus(runDir, materialStore, compiled.value);
    unlinkSync(planPath);
    unlinkSync(linkedPath);

    const context = loadRequirementsContext(runDir, compiled.value);
    const scoped = scopedRequirements(context, ["context"]);

    expect(context.corpus).toEqual([
      { path: "plan.md", content },
      { path: "compatibility.md", content: compatibility },
    ]);
    expect(scoped.sourceMaterial).toEqual([
      { path: "plan.md:5", content: "- [ ] Add context\n" },
      { path: "compatibility.md", content: compatibility },
    ]);
    expect(JSON.stringify(context)).not.toContain(root);
  });

  it("rejects a retained corpus that no longer binds to its execution plan", () => {
    const root = mkdtempSync(join(tmpdir(), "pipkin-requirements-"));
    roots.add(root);
    const planPath = join(root, "plan.md");
    const content = "# Plan\n\n- [ ] Add context\n";
    writeFileSync(planPath, content);
    const plan = parsePlan(planPath, content);
    const materialStore = buildMaterialStore({
      plan,
      planPath,
      repoRoot: root,
    });
    const compiled = compileExecutionPlan(
      {
        version: 1,
        tasks: [task()],
        workstreams: [{ id: "context", taskIds: ["context"] }],
      },
      {
        plan,
        planHash: hash(content),
        materialStore,
        checkoutId: join(root, ".git"),
        baseSha: "base",
        workerConcurrency: 1,
      },
    );
    if (!compiled.ok) {
      throw new Error(compiled.reason);
    }
    const runDir = join(root, "run");
    writeSourceCorpus(runDir, materialStore, compiled.value);
    const stored = JSON.parse(readFileSync(sourceCorpusPath(runDir), "utf-8"));
    stored.documents[0].displayPath = planPath;
    writeFileSync(sourceCorpusPath(runDir), JSON.stringify(stored));

    expect(() => loadRequirementsContext(runDir, compiled.value)).toThrow(
      "duplicate documents",
    );
  });
});

function task() {
  return {
    id: "context",
    planIndex: 1,
    title: "Add context",
    dependsOn: [],
    supportingDocuments: [],
    compiledContract: {
      objective: "Keep context.",
      inScope: ["Context"],
      acceptanceCriteria: ["Context works"],
      outOfScope: ["Redesign"],
    },
  };
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
