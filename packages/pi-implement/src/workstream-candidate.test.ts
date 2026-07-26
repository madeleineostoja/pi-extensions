import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { ensureGitInfoExclude } from "@pi-extensions/lib";
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  compileExecutionPlan,
  type ExecutionPlan,
} from "./execution-plan-vnext.js";
import { ExecGitClient } from "./git.js";
import { createVNextRuntime } from "./vnext-command.js";
import { buildMaterialStore } from "./material-store.js";
import { parsePlan } from "./plan.js";
import type { WorkstreamImplementerCompletion } from "./result-schemas.js";
import type { SubagentClient } from "./subagents.js";
import { within } from "./test-boundary.js";
import {
  buildWorkstreamPacket,
  recreateWorkstreamWorkspace,
  runWorkstreamCandidate,
  workstreamWorkspace,
} from "./workstream-candidate.js";
import {
  checkoutPaths,
  createPlanningRun,
  protectedArtifactsMatch,
  sourceIdentityForExecutionPlan,
  type CheckoutLeaseCapability,
  type VNextRunStore,
} from "./vnext-store.js";

const temporaryDirectories = new Set<string>();

type Fixture = {
  root: string;
  planPath: string;
  planContent: string;
  plan: ExecutionPlan;
  run: VNextRunStore;
};

function temporaryDirectory(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.add(path);
  return path;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" });
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  return {
    promise: new Promise<void>((resolvePromise) => {
      resolve = resolvePromise;
    }),
    resolve,
  };
}

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

async function fixture(args: {
  workstreams: Array<{ id: string; taskIds: string[] }>;
  tasks?: Array<{ id: string; title: string }>;
}): Promise<Fixture> {
  const root = realpathSync(temporaryDirectory("pi-implement-workstream-"));
  git(root, "init");
  git(root, "config", "user.email", "test@example.com");
  git(root, "config", "user.name", "Test");
  await ensureGitInfoExclude(root, ".pi/");
  const tasks = args.tasks ?? [
    { id: "first", title: "First task" },
    { id: "second", title: "Second task" },
  ];
  const planContent = `# Plan\n\n## Tasks\n\n${tasks.map((task) => `- [ ] ${task.title}`).join("\n")}\n`;
  const planPath = join(root, "plan.md");
  writeFileSync(planPath, planContent);
  writeFileSync(join(root, ".gitignore"), "node_modules\n");
  git(root, "add", ".");
  git(root, "commit", "-m", "chore: init");
  const parsed = parsePlan(planPath, planContent);
  const materialStore = buildMaterialStore({
    plan: parsed,
    planPath,
    repoRoot: root,
  });
  const result = compileExecutionPlan(
    {
      version: 1,
      plannerReason: "The workstreams are independent.",
      plannerConfidence: "high",
      tasks: tasks.map((task, index) => ({
        id: task.id,
        planIndex: index + 1,
        title: task.title,
        dependsOn: [],
        provenance: [{ path: planPath, quote: task.title }],
        compiledContract: {
          objective: `Implement ${task.title}.`,
          inScope: [task.title],
          acceptanceCriteria: [`${task.title} works`],
          outOfScope: ["Unrelated changes"],
        },
      })),
      workstreams: args.workstreams.map((workstream) => ({
        ...workstream,
        dependsOn: [],
        rationale: "The task contracts are independent.",
        risk: "normal" as const,
      })),
    },
    {
      plan: parsed,
      planHash: createHash("sha256").update(planContent).digest("hex"),
      materialStore,
      checkoutId: join(root, ".git"),
      baseSha: git(root, "rev-parse", "HEAD").trim(),
      workerConcurrency: 2,
    },
  );
  if (!result.ok) {
    throw new Error(result.reason);
  }
  const branch = await new ExecGitClient(root).currentBranch();
  const run = createPlanningRun({
    lease: fakeLease(root),
    runId: "run-1",
    checkout: {
      root,
      gitDir: join(root, ".git"),
      commonGitDir: join(root, ".git"),
      branchRef: `refs/heads/${branch}`,
      startHead: result.value.source.baseSha,
    },
    source: sourceIdentityForExecutionPlan(result.value),
    workerConcurrency: 2,
  });
  await run.bindExecutionPlan(result.value);
  const state = run.read();
  await run.update(state.revision, (current) => ({
    ...current,
    workstreams: {
      ...current.workstreams,
      source: Object.fromEntries(
        Object.entries(current.workstreams.source).map(([id, workstream]) => [
          id,
          { ...workstream, baseSha: current.run.checkout.startHead },
        ]),
      ),
    },
  }));
  return { root, planPath, planContent, plan: result.value, run };
}

function agent(
  run: (
    cwd: string,
  ) => Promise<
    | { status: "completed"; result: unknown }
    | { status: "failed"; error: string }
  >,
): SubagentClient {
  let cwd = "";
  return {
    async probe() {
      return { ok: true };
    },
    async spawn(args) {
      cwd = args.cwd!;
      return "agent" as never;
    },
    async stop() {},
    async waitFor() {
      return (await run(cwd)) as never;
    },
  };
}

async function changedResult(cwd: string, taskIds: string[]) {
  const client = new ExecGitClient(cwd);
  for (const taskId of taskIds) {
    writeFileSync(join(cwd, `${taskId}.txt`), `${taskId}\n`);
  }
  git(cwd, "add", "-A");
  await client.checkpoint("feat: implement workstream", false);
  const checkpoint = await client.head();
  return {
    status: "completed" as const,
    result: {
      outcome: "changed" as const,
      summary: "Implemented the workstream and repaired local runtime state.",
      verification: [
        {
          command: "npm test",
          result: "passed",
          rationale: "Verifies the workstream behavior.",
        },
      ],
      taskCompletions: taskIds.map((taskId) => ({
        taskId,
        kind: "checkpoint" as const,
        checkpoint,
      })),
      candidateTip: checkpoint,
    },
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
  temporaryDirectories.clear();
});

describe("workstream candidate lifecycle", () => {
  it("runs ordered tasks in one workspace and retains their checkpoint mapping", async () => {
    const subject = await fixture({
      workstreams: [{ id: "combined", taskIds: ["first", "second"] }],
    });
    const outcome = await runWorkstreamCandidate({
      state: subject.run.read(),
      plan: subject.plan,
      workstreamId: "combined",
      git: new ExecGitClient(subject.root),
      subagents: agent(async (cwd) => {
        const result = await changedResult(cwd, ["first"]);
        const completion = result.result as WorkstreamImplementerCompletion;
        completion.taskCompletions.push({
          taskId: "second",
          kind: "already_satisfied",
          evidence:
            "The repository already exposed the required second behavior.",
        });
        return { ...result, result: completion };
      }),
      artifactsPath: join(
        subject.root,
        ".pi",
        "implement",
        "runs",
        "run-1",
        "artifacts",
      ),
    });

    expect(outcome).toMatchObject({
      kind: "candidate_ready",
      checkpoints: { first: expect.any(String) },
      satisfied: {
        second: "The repository already exposed the required second behavior.",
      },
    });
    expect(readFileSync(join(subject.root, "plan.md"), "utf-8")).toBe(
      subject.planContent,
    );
    expect(outcome.evidencePath).toContain("combined-implementation.json");
  });

  it("runs implementation and review through the production runtime factory", async () => {
    const subject = await fixture({
      workstreams: [{ id: "combined", taskIds: ["first", "second"] }],
    });
    const completed = deferred();
    const handles = new Map<string, { role: string; cwd: string }>();
    let sequence = 0;
    let reviews = 0;
    const subagents: SubagentClient = {
      async probe() {
        return { ok: true };
      },
      async spawn(args) {
        const id = `agent-${sequence++}`;
        handles.set(id, { role: args.role ?? "unknown", cwd: args.cwd ?? "" });
        return id as never;
      },
      async stop() {},
      async waitFor(id) {
        const handle = handles.get(id as string)!;
        if (handle.role === "implementer") {
          return changedResult(handle.cwd, ["first", "second"]) as never;
        }
        reviews += 1;
        return {
          status: "completed",
          result: { verdict: "approved" },
        } as never;
      },
    };
    const targetGit = new ExecGitClient(subject.root);
    expect(
      await targetGit.isCleanExcept([realpathSync(subject.planPath)]),
    ).toBe(true);
    expect(
      await targetGit.hasStagedChangesInPaths([realpathSync(subject.planPath)]),
    ).toBe(false);
    expect(await targetGit.checkoutIdentity()).toBe(
      subject.run.read().run.checkout.gitDir,
    );
    expect(protectedArtifactsMatch(subject.run.read())).toBe(true);
    const runtime = createVNextRuntime({
      pi: {} as never,
      ctx: {} as never,
      git: new ExecGitClient(subject.root),
      store: subject.run,
      lease: subject.run.lease,
      roles: {} as never,
      plan: parsePlan(subject.planPath, subject.planContent),
      materialStore: buildMaterialStore({
        plan: parsePlan(subject.planPath, subject.planContent),
        planPath: subject.planPath,
        repoRoot: subject.root,
      }),
      checkoutIdentity: await new ExecGitClient(
        subject.root,
      ).checkoutIdentity(),
      baseSha: await new ExecGitClient(subject.root).head(),
      subagents,
      onTransition: (_state, event) => {
        if (event.kind === "review_completed") {
          completed.resolve();
        }
      },
    });

    await runtime.start();
    try {
      await within("production runtime completion", completed.promise, {
        timeoutMs: 10_000,
        diagnostics: () => JSON.stringify(runtime.snapshot()),
      });
      await runtime.quiesce();

      expect(runtime.snapshot().gates).toContainEqual(
        expect.objectContaining({ kind: "review", outcome: "passed" }),
      );
      expect(reviews).toBe(1);
    } finally {
      await runtime.stop("test completed after review");
    }
  });

  it("runs independent workstreams concurrently in isolated worktrees", async () => {
    const subject = await fixture({
      tasks: [
        { id: "first", title: "First task" },
        { id: "second", title: "Second task" },
      ],
      workstreams: [
        { id: "first-stream", taskIds: ["first"] },
        { id: "second-stream", taskIds: ["second"] },
      ],
    });
    let active = 0;
    let peak = 0;
    let started = 0;
    const bothStarted = deferred();
    const release = deferred();
    const worker = (taskId: string) =>
      agent(async (cwd) => {
        active += 1;
        peak = Math.max(peak, active);
        started += 1;
        if (started === 2) {
          bothStarted.resolve();
        }
        await release.promise;
        const result = await changedResult(cwd, [taskId]);
        active -= 1;
        return result;
      });

    const firstPromise = runWorkstreamCandidate({
      state: subject.run.read(),
      plan: subject.plan,
      workstreamId: "first-stream",
      git: new ExecGitClient(subject.root),
      subagents: worker("first"),
    });
    const secondPromise = runWorkstreamCandidate({
      state: subject.run.read(),
      plan: subject.plan,
      workstreamId: "second-stream",
      git: new ExecGitClient(subject.root),
      subagents: worker("second"),
    });
    try {
      await within(
        "both workstreams to reach their start barrier",
        bothStarted.promise,
        {
          timeoutMs: 10_000,
          diagnostics: () => `started=${started}; active=${active}`,
        },
      );
      expect(peak).toBe(2);
      release.resolve();

      const [first, second] = await Promise.all([firstPromise, secondPromise]);

      expect(first.kind).toBe("candidate_ready");
      expect(second.kind).toBe("candidate_ready");
      expect(
        workstreamWorkspace(subject.run.read(), "first-stream").worktreePath,
      ).not.toBe(
        workstreamWorkspace(subject.run.read(), "second-stream").worktreePath,
      );
    } finally {
      release.resolve();
      await Promise.allSettled([firstPromise, secondPromise]);
    }
  });

  it("retains committed progress after a failed worker and safely recreates a dirty workspace", async () => {
    const subject = await fixture({
      workstreams: [{ id: "combined", taskIds: ["first", "second"] }],
    });
    const targetGit = new ExecGitClient(subject.root);
    let trustedCheckpoint = "";
    await expect(
      runWorkstreamCandidate({
        state: subject.run.read(),
        plan: subject.plan,
        workstreamId: "combined",
        git: targetGit,
        subagents: agent(async (cwd) => {
          const client = new ExecGitClient(cwd);
          writeFileSync(join(cwd, "first.txt"), "first\n");
          git(cwd, "add", "-A");
          await client.checkpoint("feat: first checkpoint", false);
          trustedCheckpoint = await client.head();
          writeFileSync(join(cwd, "second.txt"), "untrusted\n");
          git(cwd, "add", "-A");
          await client.checkpoint("feat: untrusted checkpoint", false);
          writeFileSync(join(cwd, "uncommitted.txt"), "retain as evidence\n");
          return { status: "failed", error: "provider disconnected" };
        }),
      }),
    ).rejects.toThrow("provider disconnected");

    const workspace = workstreamWorkspace(subject.run.read(), "combined");
    const workspaceGit = targetGit.forWorktree(workspace.worktreePath);
    expect(await workspaceGit.head()).not.toBe(trustedCheckpoint);
    expect(await workspaceGit.isClean()).toBe(false);
    await recreateWorkstreamWorkspace({
      state: subject.run.read(),
      workstreamId: "combined",
      git: targetGit,
      trustedCheckpoint,
    });
    expect(await targetGit.forWorktree(workspace.worktreePath).head()).toBe(
      trustedCheckpoint,
    );
    expect(await targetGit.forWorktree(workspace.worktreePath).isClean()).toBe(
      true,
    );

    const outcome = await runWorkstreamCandidate({
      state: subject.run.read(),
      plan: subject.plan,
      workstreamId: "combined",
      git: targetGit,
      subagents: agent((cwd) => changedResult(cwd, ["first", "second"])),
      trustedCheckpoint,
    });
    expect(outcome).toMatchObject({ kind: "candidate_ready" });
  });

  it("rejects a candidate that commits protected plan artifacts", async () => {
    const subject = await fixture({
      workstreams: [{ id: "combined", taskIds: ["first", "second"] }],
    });
    await expect(
      runWorkstreamCandidate({
        state: subject.run.read(),
        plan: subject.plan,
        workstreamId: "combined",
        git: new ExecGitClient(subject.root),
        subagents: agent(async (cwd) => {
          writeFileSync(join(cwd, "plan.md"), "tampered candidate\n");
          return changedResult(cwd, ["first", "second"]);
        }),
      }),
    ).rejects.toThrow("Candidate changes protected plan artifacts");
    expect(readFileSync(subject.planPath, "utf-8")).toBe(subject.planContent);
  });

  it("rejects an implementer that mutates the target checkout", async () => {
    const subject = await fixture({
      workstreams: [{ id: "combined", taskIds: ["first", "second"] }],
    });
    await expect(
      runWorkstreamCandidate({
        state: subject.run.read(),
        plan: subject.plan,
        workstreamId: "combined",
        git: new ExecGitClient(subject.root),
        subagents: agent(async (cwd) => {
          writeFileSync(subject.planPath, "tampered\n");
          return changedResult(cwd, ["first", "second"]);
        }),
      }),
    ).rejects.toThrow("target checkout or protected artifacts");
    expect(readFileSync(subject.planPath, "utf-8")).toBe("tampered\n");
  });

  it("builds a packet from ordered contracts and selected provenance material", async () => {
    const subject = await fixture({
      workstreams: [{ id: "combined", taskIds: ["first", "second"] }],
    });
    const packet = buildWorkstreamPacket({
      state: subject.run.read(),
      plan: subject.plan,
      workstreamId: "combined",
      workspace: workstreamWorkspace(subject.run.read(), "combined"),
    });

    expect(packet.tasks.map((task) => task.id)).toEqual(["first", "second"]);
    expect(packet.sourceMaterial).toEqual([
      { path: realpathSync(subject.planPath), content: subject.planContent },
    ]);
  });
});
