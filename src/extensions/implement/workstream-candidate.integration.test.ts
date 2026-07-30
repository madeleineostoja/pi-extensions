import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { ensureGitInfoExclude } from "#lib/git";
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
import { compileExecutionPlan, type ExecutionPlan } from "./execution-plan.js";
import { ExecGitClient } from "./git.js";
import { createRuntime } from "./run.js";
import { buildMaterialStore } from "./material-store.js";
import { parsePlan } from "./plan.js";
import type { ImplementRoles, SubagentClient } from "./subagents.js";
import { within } from "./test-boundary.js";
import {
  recreateWorkstreamWorkspace,
  runWorkstreamCandidate,
  WorkstreamCandidateLifecycleError,
  workstreamWorkspace,
} from "./workstream-candidate.js";
import {
  checkoutPaths,
  createPlanningRun,
  protectedArtifactsMatch,
  sourceIdentityForExecutionPlan,
  RunStore,
  type CheckoutLeaseCapability,
} from "./store.js";

const temporaryDirectories = new Set<string>();

type Fixture = {
  root: string;
  planPath: string;
  planContent: string;
  plan: ExecutionPlan;
  run: RunStore;
  roles: ImplementRoles;
};

const roles: ImplementRoles = {
  implementer: {
    type: "pipkin:implement:implementer",
    model: "test/medium",
    thinking: "medium",
  },
  reviewer: {
    type: "pipkin:implement:reviewer",
    model: "test/high",
    thinking: "high",
  },
  planner: {
    type: "pipkin:implement:planner",
    model: "test/high",
    thinking: "high",
  },
  recovery: {
    type: "pipkin:implement:recovery",
    model: "test/medium",
    thinking: "medium",
  },
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
  const root = realpathSync(temporaryDirectory("pipkin-implement-workstream-"));
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
      tasks: tasks.map((task, index) => ({
        id: task.id,
        planIndex: index + 1,
        title: task.title,
        dependsOn: [],
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
  return { root, planPath, planContent, plan: result.value, run, roles };
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
  return {
    status: "completed" as const,
    result: {
      outcome: "changed" as const,
      summary: "Implemented the workstream and repaired local runtime state.",
      commitMessage: "feat: implement workstream behavior",
      verification: ["Focused workstream tests passed."],
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
  it("derives every changed task checkpoint from the observed candidate", async () => {
    const subject = await fixture({
      workstreams: [{ id: "combined", taskIds: ["first", "second"] }],
    });
    const outcome = await runWorkstreamCandidate({
      state: subject.run.read(),
      plan: subject.plan,
      workstreamId: "combined",
      git: new ExecGitClient(subject.root),
      roles: subject.roles,
      subagents: agent(async (cwd) => changedResult(cwd, ["first", "second"])),
      artifactsPath: join(
        subject.root,
        ".pi",
        "pipkin",
        "implement",
        "runs",
        "run-1",
        "artifacts",
      ),
      artifactLeaseId: "lease-combined",
    });

    expect(outcome).toMatchObject({
      kind: "candidate_ready",
      checkpoints: {
        first: expect.stringMatching(/^[0-9a-f]{40}$/),
        second: expect.stringMatching(/^[0-9a-f]{40}$/),
      },
      candidate: {
        commitSha: expect.stringMatching(/^[0-9a-f]{40}$/),
      },
    });
    if (outcome.kind !== "candidate_ready") {
      throw new Error("Expected a candidate-ready outcome.");
    }
    expect(outcome.checkpoints).toEqual({
      first: outcome.candidate.commitSha,
      second: outcome.candidate.commitSha,
    });
    expect(readFileSync(join(subject.root, "plan.md"), "utf-8")).toBe(
      subject.planContent,
    );
    expect(outcome.evidencePath).toContain(
      "implementation/combined/lease-combined.json",
    );
  });

  it("rejects an already-satisfied outcome after creating commits", async () => {
    const subject = await fixture({
      workstreams: [{ id: "combined", taskIds: ["first", "second"] }],
    });
    await expect(
      runWorkstreamCandidate({
        state: subject.run.read(),
        plan: subject.plan,
        workstreamId: "combined",
        git: new ExecGitClient(subject.root),
        roles: subject.roles,
        subagents: agent(async (cwd) => {
          await changedResult(cwd, ["first", "second"]);
          return {
            status: "completed" as const,
            result: {
              outcome: "already_satisfied" as const,
              evidence: "The repository already exposes both behaviors.",
              summary: "Confirmed the workstream is already satisfied.",
              verification: ["Inspected the repository state."],
            },
          };
        }),
      }),
    ).rejects.toThrow("An already-satisfied workstream cannot create commits.");
  });

  it("retains evidence from a failed lease after a retry succeeds", async () => {
    const subject = await fixture({
      workstreams: [{ id: "combined", taskIds: ["first", "second"] }],
    });
    const artifactsPath = join(
      subject.root,
      ".pi",
      "pipkin",
      "implement",
      "runs",
      "run-1",
      "artifacts",
    );
    await expect(
      runWorkstreamCandidate({
        state: subject.run.read(),
        plan: subject.plan,
        workstreamId: "combined",
        git: new ExecGitClient(subject.root),
        roles: subject.roles,
        subagents: agent(async () => ({
          status: "completed",
          result: {
            outcome: "changed",
            summary: "No changes were needed.",
            commitMessage: "feat: implement workstream behavior",
            verification: ["Inspected the repository."],
          },
        })),
        artifactsPath,
        artifactLeaseId: "lease-first",
      }),
    ).rejects.toThrow(
      "A changed workstream must advance beyond its assigned base.",
    );
    await runWorkstreamCandidate({
      state: subject.run.read(),
      plan: subject.plan,
      workstreamId: "combined",
      git: new ExecGitClient(subject.root),
      roles: subject.roles,
      subagents: agent(async (cwd) => changedResult(cwd, ["first", "second"])),
      artifactsPath,
      artifactLeaseId: "lease-retry",
    });

    const attemptPath = (leaseId: string) =>
      join(artifactsPath, "implementation", "combined", `${leaseId}.json`);
    expect(
      JSON.parse(readFileSync(attemptPath("lease-first"), "utf-8")),
    ).toMatchObject({
      status: "validation_failed",
    });
    expect(
      JSON.parse(readFileSync(attemptPath("lease-retry"), "utf-8")),
    ).toMatchObject({
      status: "completed",
    });
  });

  it("rejects a changed outcome without a changed candidate tree", async () => {
    const subject = await fixture({
      workstreams: [{ id: "combined", taskIds: ["first", "second"] }],
    });
    await expect(
      runWorkstreamCandidate({
        state: subject.run.read(),
        plan: subject.plan,
        workstreamId: "combined",
        git: new ExecGitClient(subject.root),
        roles: subject.roles,
        subagents: agent(async () => ({
          status: "completed",
          result: {
            outcome: "changed",
            summary: "No changes were needed.",
            commitMessage: "feat: implement workstream behavior",
            verification: ["Inspected the repository."],
          },
        })),
      }),
    ).rejects.toThrow(
      "A changed workstream must advance beyond its assigned base.",
    );
  });

  it("maps already-satisfied evidence to every assigned task", async () => {
    const subject = await fixture({
      workstreams: [{ id: "combined", taskIds: ["first", "second"] }],
    });
    const outcome = await runWorkstreamCandidate({
      state: subject.run.read(),
      plan: subject.plan,
      workstreamId: "combined",
      git: new ExecGitClient(subject.root),
      roles: subject.roles,
      subagents: agent(async () => ({
        status: "completed",
        result: {
          outcome: "already_satisfied",
          evidence: "The repository already exposes both required behaviors.",
          summary: "Confirmed the workstream is already satisfied.",
          verification: ["Inspected the repository state."],
        },
      })),
    });

    expect(outcome).toMatchObject({
      kind: "satisfaction_claimed",
      evidence: {
        first: "The repository already exposes both required behaviors.",
        second: "The repository already exposes both required behaviors.",
      },
    });
  });

  it("completes implementation, publication, projection, and whole-plan review through the production runtime", async () => {
    const subject = await fixture({
      workstreams: [{ id: "combined", taskIds: ["first", "second"] }],
    });
    const completed = deferred();
    const handles = new Map<string, { role: string; cwd: string }>();
    let sequence = 0;
    let reviews = 0;
    const subagents: SubagentClient = {
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
    const runtime = createRuntime({
      pi: {} as never,
      ctx: {} as never,
      git: new ExecGitClient(subject.root),
      store: subject.run,
      lease: subject.run.lease,
      roles: subject.roles,
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
        if (event.kind === "run_completed") {
          completed.resolve();
        }
      },
    });

    await runtime.start();
    try {
      await within("production runtime completion", completed.promise, {
        timeoutMs: 50_000,
        diagnostics: () => JSON.stringify(runtime.snapshot()),
      });
      await runtime.settle();

      expect(runtime.snapshot()).toMatchObject({
        phase: "completed",
        wholePlanReview: { status: "approved" },
      });
      expect(runtime.snapshot().gates).toContainEqual(
        expect.objectContaining({ kind: "review", outcome: "passed" }),
      );
      expect(Object.keys(runtime.snapshot().publication.receipts)).toHaveLength(
        1,
      );
      expect(readFileSync(subject.planPath, "utf-8")).toContain(
        "- [x] First task\n- [x] Second task",
      );
      expect(readFileSync(join(subject.root, "first.txt"), "utf-8")).toBe(
        "first\n",
      );
      expect(git(subject.root, "log", "-1", "--format=%s").trim()).toBe(
        "feat: implement workstream behavior",
      );
      expect(reviews).toBe(2);
    } finally {
      await runtime.stop("test completed");
    }
  }, 60_000);

  it("publishes a narrowed two-finding correction journey through the production actor", async () => {
    const subject = await fixture({
      workstreams: [{ id: "combined", taskIds: ["first", "second"] }],
    });
    const completed = deferred();
    const handles = new Map<
      string,
      { role: string; cwd: string; description: string }
    >();
    let sequence = 0;
    let workstreamReviews = 0;
    let corrections = 0;
    const recoveryPrompts: string[] = [];
    const reviewPrompts: string[] = [];
    const subagents: SubagentClient = {
      async spawn(args) {
        const id = `agent-${sequence++}`;
        handles.set(id, {
          role: args.role ?? "unknown",
          cwd: args.cwd ?? "",
          description: args.description,
        });
        if (args.role === "recovery") {
          recoveryPrompts.push(args.prompt);
        }
        if (args.description.startsWith("Review workstream")) {
          reviewPrompts.push(args.prompt);
        }
        return id as never;
      },
      async stop() {},
      async waitFor(id) {
        const handle = handles.get(id as string);
        if (!handle) {
          return { status: "failed", error: "Unknown worker handle." } as never;
        }
        if (handle.role === "implementer") {
          return changedResult(handle.cwd, ["first", "second"]) as never;
        }
        if (handle.role === "recovery") {
          corrections++;
          const path = join(handle.cwd, `correction-${corrections}.txt`);
          writeFileSync(path, `correction ${corrections}\n`);
          git(handle.cwd, "add", "-A");
          const candidateGit = new ExecGitClient(handle.cwd);
          await candidateGit.checkpoint(
            `fix: correct finding ${corrections}`,
            false,
          );
          const candidateTip = await candidateGit.head();
          return {
            status: "completed",
            result: {
              action: "rework_candidate",
              summary: `Committed correction ${corrections}.`,
              evidence: `Correction ${corrections} is committed.`,
              commitMessage: "feat: implement corrected workstream behavior",
              candidateTip,
              changedPaths: [`correction-${corrections}.txt`],
            },
          } as never;
        }
        if (handle.description.startsWith("Review workstream")) {
          workstreamReviews++;
          if (workstreamReviews === 1) {
            return {
              status: "completed",
              result: {
                verdict: "changes_requested",
                findings: [
                  {
                    summary: "First correction is required.",
                    evidence: "The first observable behavior is missing.",
                    requiredChange: "Implement the first correction.",
                    acceptanceCriteria: ["The first correction is observable."],
                  },
                  {
                    summary: "Second correction is required.",
                    evidence: "The second observable behavior is missing.",
                    requiredChange: "Implement the second correction.",
                    acceptanceCriteria: [
                      "The second correction is observable.",
                    ],
                  },
                ],
              },
            } as never;
          }
          if (workstreamReviews === 2) {
            return {
              status: "completed",
              result: {
                assessments: [
                  {
                    id: "source-combined-r1",
                    status: "resolved",
                    evidence: "The first correction is present.",
                  },
                  {
                    id: "source-combined-r2",
                    status: "unresolved",
                    evidence: "The second correction is still missing.",
                  },
                ],
                regressions: [],
              },
            } as never;
          }
          return {
            status: "completed",
            result: {
              assessments: [
                {
                  id: "source-combined-r2",
                  status: "resolved",
                  evidence: "The second correction is present.",
                },
              ],
              regressions: [],
            },
          } as never;
        }
        return {
          status: "completed",
          result: { verdict: "approved" },
        } as never;
      },
    };
    const gitClient = new ExecGitClient(subject.root);
    const runtime = createRuntime({
      pi: {} as never,
      ctx: {} as never,
      git: gitClient,
      store: subject.run,
      lease: subject.run.lease,
      roles: subject.roles,
      plan: parsePlan(subject.planPath, subject.planContent),
      materialStore: buildMaterialStore({
        plan: parsePlan(subject.planPath, subject.planContent),
        planPath: subject.planPath,
        repoRoot: subject.root,
      }),
      checkoutIdentity: await gitClient.checkoutIdentity(),
      baseSha: await gitClient.head(),
      subagents,
      onTransition: (_state, event) => {
        if (event.kind === "run_completed") {
          completed.resolve();
        }
      },
    });

    await runtime.start();
    try {
      await within("narrowed correction journey", completed.promise, {
        timeoutMs: 30_000,
        diagnostics: () => JSON.stringify(runtime.snapshot()),
      });
      await runtime.settle();

      const state = runtime.snapshot();
      expect(state).toMatchObject({
        phase: "completed",
        wholePlanReview: { status: "approved" },
      });
      expect(corrections).toBe(2);
      expect(workstreamReviews).toBe(3);
      expect(recoveryPrompts).toHaveLength(2);
      expect(recoveryPrompts[0]).toContain("source-combined-r1");
      expect(recoveryPrompts[0]).toContain("source-combined-r2");
      expect(recoveryPrompts[1]).not.toContain("source-combined-r1");
      expect(recoveryPrompts[1]).toContain("source-combined-r2");
      expect(reviewPrompts).toHaveLength(3);
      expect(reviewPrompts[2]).not.toContain("source-combined-r1");
      expect(reviewPrompts[2]).toContain("source-combined-r2");
      expect(state.findings["source-combined-r1"]?.status).toBe("resolved");
      expect(state.findings["source-combined-r2"]?.status).toBe("resolved");
      const completedEpisode = Object.values(state.recoveryEpisodes)[0];
      expect(completedEpisode).toMatchObject({
        status: "completed",
        outstandingFindingIds: ["source-combined-r1", "source-combined-r2"],
      });
      const reloaded = RunStore.open(
        subject.run.lease,
        subject.run.path,
      ).read();
      expect(reloaded.recoveryEpisodes[completedEpisode!.id]).toMatchObject({
        status: "completed",
        outstandingFindingIds: ["source-combined-r1", "source-combined-r2"],
      });
      expect(
        Object.values(reloaded.recoveryEpisodes).find(
          (episode) =>
            JSON.stringify(episode.outstandingFindingIds) ===
            JSON.stringify(["source-combined-r2"]),
        ),
      ).toMatchObject({
        status: "completed",
        outstandingFindingIds: ["source-combined-r2"],
      });
      expect(Object.keys(state.publication.receipts)).toHaveLength(1);
      expect(
        readFileSync(join(subject.root, "correction-1.txt"), "utf-8"),
      ).toBe("correction 1\n");
      expect(
        readFileSync(join(subject.root, "correction-2.txt"), "utf-8"),
      ).toBe("correction 2\n");
      expect(readFileSync(subject.planPath, "utf-8")).toContain(
        "- [x] First task\n- [x] Second task",
      );
    } finally {
      await runtime.stop("test completed");
    }
  }, 40_000);

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
      roles: subject.roles,
      subagents: worker("first"),
    });
    const secondPromise = runWorkstreamCandidate({
      state: subject.run.read(),
      plan: subject.plan,
      workstreamId: "second-stream",
      git: new ExecGitClient(subject.root),
      roles: subject.roles,
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

  it("durably observes committed progress before rejecting a dirty workspace", async () => {
    const subject = await fixture({
      workstreams: [{ id: "combined", taskIds: ["first", "second"] }],
    });
    const targetGit = new ExecGitClient(subject.root);
    const artifactsPath = join(
      subject.root,
      ".pi",
      "pipkin",
      "implement",
      "runs",
      "run-1",
      "artifacts",
    );
    let failure: WorkstreamCandidateLifecycleError | undefined;
    try {
      await runWorkstreamCandidate({
        state: subject.run.read(),
        plan: subject.plan,
        workstreamId: "combined",
        git: targetGit,
        roles: subject.roles,
        subagents: agent(async (cwd) => {
          const result = await changedResult(cwd, ["first", "second"]);
          writeFileSync(join(cwd, "uncommitted.txt"), "retain as evidence\n");
          return result;
        }),
        artifactsPath,
        artifactLeaseId: "lease-dirty",
      });
    } catch (error) {
      failure = error as WorkstreamCandidateLifecycleError;
    }

    expect(failure).toBeInstanceOf(WorkstreamCandidateLifecycleError);
    expect(failure?.message).toBe("Workstream candidate is dirty.");
    expect(failure?.trustedCheckpoint).toMatch(/^[0-9a-f]{40}$/);
    expect(failure?.trustedCandidate).toMatchObject({
      id: `checkpoint:combined:${failure?.trustedCheckpoint}`,
      commitSha: failure?.trustedCheckpoint,
    });
    expect(failure?.recoveryWorkspace).toMatchObject({
      checkpoint: failure?.trustedCheckpoint,
      changedPaths: ["uncommitted.txt"],
    });
    expect(
      JSON.parse(
        readFileSync(
          join(artifactsPath, "implementation", "combined", "lease-dirty.json"),
          "utf-8",
        ),
      ),
    ).toMatchObject({
      status: "validation_failed",
      trustedCheckpoint: failure?.trustedCheckpoint,
      observation: { clean: false, head: failure?.trustedCheckpoint },
    });

    const workspace = workstreamWorkspace(subject.run.read(), "combined");
    expect(await targetGit.forWorktree(workspace.worktreePath).isClean()).toBe(
      false,
    );
    await recreateWorkstreamWorkspace({
      state: subject.run.read(),
      workstreamId: "combined",
      git: targetGit,
      trustedCheckpoint: failure!.trustedCheckpoint!,
    });
    const outcome = await runWorkstreamCandidate({
      state: subject.run.read(),
      plan: subject.plan,
      workstreamId: "combined",
      git: targetGit,
      roles: subject.roles,
      subagents: agent((cwd) => changedResult(cwd, ["first", "second"])),
      trustedCheckpoint: failure!.trustedCheckpoint!,
    });
    expect(outcome).toMatchObject({ kind: "candidate_ready" });
  });

  it("does not trust a checkpoint committed from a foreign branch", async () => {
    const subject = await fixture({
      workstreams: [{ id: "combined", taskIds: ["first", "second"] }],
    });
    let failure: WorkstreamCandidateLifecycleError | undefined;
    try {
      await runWorkstreamCandidate({
        state: subject.run.read(),
        plan: subject.plan,
        workstreamId: "combined",
        git: new ExecGitClient(subject.root),
        roles: subject.roles,
        subagents: agent(async (cwd) => {
          const result = await changedResult(cwd, ["first", "second"]);
          git(cwd, "switch", "-c", "foreign-candidate-branch");
          return result;
        }),
      });
    } catch (error) {
      failure = error as WorkstreamCandidateLifecycleError;
    }

    expect(failure).toBeInstanceOf(WorkstreamCandidateLifecycleError);
    expect(failure?.message).toBe(
      "Workstream candidate is no longer on its owned branch.",
    );
    expect(failure?.trustedCheckpoint).toBeUndefined();
    expect(failure?.trustedCandidate).toBeUndefined();
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
        roles: subject.roles,
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
        roles: subject.roles,
        subagents: agent(async (cwd) => {
          writeFileSync(subject.planPath, "tampered\n");
          return changedResult(cwd, ["first", "second"]);
        }),
      }),
    ).rejects.toThrow("target checkout or protected artifacts");
    expect(readFileSync(subject.planPath, "utf-8")).toBe("tampered\n");
  });
});
