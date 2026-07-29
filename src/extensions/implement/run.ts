import { join, resolve } from "node:path";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { buildMaterialStore } from "./material-store.js";
import { parsePlan } from "./plan.js";
import {
  buildStrictExecutionPlannerPrompt,
  planExecution,
  readExecutionPlan,
} from "./execution-plan.js";
import {
  CandidateReplayEngine,
  publicationPreparation,
} from "./candidate-replay.js";
import { ExecGitClient } from "./git.js";
import { RuntimeSubagentClient, type SubagentClient } from "./subagents.js";
import { spawnValidatedWorker } from "./worker-invocation.js";
import { runProjection } from "./projection-runner.js";
import { createCheckboxProjectionIntent } from "./projection.js";
import { runPublication } from "./publication.js";
import {
  completeWholePlanRun,
  runWholePlanRecovery,
  runWholePlanReview,
} from "./whole-plan-review.js";
import { WriteAheadPublisher } from "./write-ahead-publication.js";
import {
  assertNoFailedRuns,
  assertProspectiveRunPreflight,
} from "./controls.js";
import { sha256 } from "./source-integrity.js";
import {
  runWorkstreamCandidate,
  TargetPreconditionError,
} from "./workstream-candidate.js";
import { runOverallRepair } from "./overall-repair.js";
import { runWorkstreamReview } from "./review.js";
import { runRecovery } from "./recovery-service.js";
import {
  SchedulerActor,
  type SchedulerActorOptions,
} from "./scheduler-actor.js";
import {
  acquireCheckoutLease,
  createPlanningRun,
  makeRunId,
  protectedArtifactsMatch,
  sourceIdentityForPlanning,
  type CheckoutLeaseCapability,
  type RunState,
  RunStore,
} from "./store.js";
import type { ImplementRoles } from "./subagents.js";

export type ActiveRun = {
  runId: string;
  actor: SchedulerActor;
  lease: CheckoutLeaseCapability;
  store: RunStore;
};

export async function startRun(args: {
  pi: ExtensionAPI;
  ctx: ExtensionCommandContext;
  planPath: string;
  roles: ImplementRoles;
  workerConcurrency: number;
  onTransition?: SchedulerActorOptions["onTransition"];
}): Promise<{ kind: "no-op" } | { kind: "started"; active: ActiveRun }> {
  const planPath = resolve(args.ctx.cwd, args.planPath);
  const content = await readText(planPath);
  const parsed = parsePlan(planPath, content);
  if (parsed.tasks.every((task) => task.checked)) {
    return { kind: "no-op" };
  }
  const git = new ExecGitClient(args.ctx.cwd);
  const [checkoutRoot, checkoutIdentity] = await Promise.all([
    git.root(),
    git.checkoutIdentity(),
  ]);
  const runId = makeRunId();
  const lease = await acquireCheckoutLease({
    checkoutRoot,
    gitDir: checkoutIdentity,
    runId,
    timeoutMs: 10_000,
  });
  try {
    await assertProspectiveRunPreflight(git);
    assertNoFailedRuns(checkoutRoot);
    const [baseSha, branch] = await Promise.all([
      git.head(),
      git.currentBranch(),
    ]);
    const materialStore = buildMaterialStore({
      plan: parsed,
      planPath,
      repoRoot: checkoutRoot,
    });
    const source = sourceIdentityForPlanning({
      planPath,
      planContent: content,
      corpusFiles: materialStore.files.map((file) => ({
        path: file.absolutePath,
        hash: file.hash,
      })),
      uncheckedLineNumbers: parsed.tasks
        .filter((task) => !task.checked)
        .map((task) => task.lineNumber),
    });
    const store = createPlanningRun({
      lease,
      runId,
      checkout: {
        root: checkoutRoot,
        gitDir: checkoutIdentity,
        commonGitDir: checkoutIdentity,
        branchRef: `refs/heads/${branch}`,
        startHead: baseSha,
      },
      source,
      workerConcurrency: args.workerConcurrency,
    });
    const actor = createRuntime({
      pi: args.pi,
      ctx: args.ctx,
      git,
      store,
      lease,
      roles: args.roles,
      plan: parsed,
      materialStore,
      checkoutIdentity,
      baseSha,
      onTransition: args.onTransition,
    });
    await actor.start();
    return { kind: "started", active: { runId, actor, lease, store } };
  } catch (error) {
    await lease.release();
    throw error;
  }
}

async function captureTargetBoundary(
  state: RunState,
  git: ExecGitClient,
): Promise<string> {
  const protectedPaths = Object.keys(state.protectedArtifactHashes);
  const [checkout, branch, head, operation, status, protectedIndexDirty] =
    await Promise.all([
      git.checkoutIdentity(),
      git.currentBranch(),
      git.head(),
      git.activeOperation(),
      git.statusEntriesExcept(protectedPaths),
      git.hasStagedChangesInPaths(protectedPaths),
    ]);
  const protectedMatch = protectedArtifactsMatch(state);
  const issues: string[] = [];
  if (checkout !== state.run.checkout.gitDir) {
    issues.push("the checkout identity changed");
  }
  if (branch !== state.run.checkout.branchRef.replace("refs/heads/", "")) {
    issues.push(
      `expected branch ${state.run.checkout.branchRef}, found ${branch || "detached HEAD"}`,
    );
  }
  const expectedHead = expectedTargetHead(state);
  if (head !== expectedHead) {
    issues.push(`expected HEAD ${expectedHead}, found ${head}`);
  }
  if (operation) {
    issues.push(`active Git operation: ${operation}`);
  }
  if (status.length > 0) {
    issues.push(
      `unsanctioned target changes:\n${status
        .map((entry) => `  ${entry.status} ${entry.path}`)
        .join("\n")}`,
    );
  }
  if (protectedIndexDirty) {
    issues.push("protected source artifacts have staged changes");
  }
  if (!protectedMatch) {
    issues.push(
      `protected source artifacts changed: ${protectedPaths.join(", ")}`,
    );
  }
  if (issues.length > 0) {
    throw new TargetPreconditionError(
      `Managed work cannot continue until the target checkout boundary is restored:\n${issues.join("\n")}`,
    );
  }
  return JSON.stringify({
    checkout,
    branch,
    head,
    operation,
    status,
    protected: protectedMatch,
  });
}

function expectedTargetHead(state: RunState): string {
  const pending = Object.values(state.publication.intents).filter(
    (intent) => !state.publication.receipts[intent.id],
  );
  if (pending.length === 1) {
    return pending[0]!.targetBaseSha;
  }
  if (pending.length > 1) {
    throw new Error("Resume found multiple unresolved publication intents.");
  }
  const receipts = Object.values(state.publication.receipts);
  const publishedBases = new Set(
    receipts.map((receipt) => receipt.targetBaseSha),
  );
  const tip = receipts.find(
    (receipt) => !publishedBases.has(receipt.publishedCommitSha),
  );
  return tip?.publishedCommitSha ?? state.run.checkout.startHead;
}

export async function stopRun(
  active: ActiveRun,
  category: NonNullable<RunState["failure"]>["category"] = "stopped",
): Promise<void> {
  try {
    await active.actor.stop(
      category === "interrupted"
        ? "Session ended before run completion."
        : "Stopped by user.",
      category,
    );
  } finally {
    await active.lease.release();
  }
}

export function createRuntime(args: {
  pi: ExtensionAPI;
  ctx: ExtensionCommandContext;
  git: ExecGitClient;
  store: RunStore;
  lease: CheckoutLeaseCapability;
  roles: ImplementRoles;
  plan: ReturnType<typeof parsePlan>;
  materialStore: ReturnType<typeof buildMaterialStore>;
  checkoutIdentity: string;
  baseSha: string;
  subagents?: SubagentClient;
  onTransition?: SchedulerActorOptions["onTransition"];
}): SchedulerActor {
  const subagents =
    args.subagents ??
    new RuntimeSubagentClient(args.pi, args.ctx, args.store.read().run.id);
  return new SchedulerActor({
    store: args.store,
    onTransition: args.onTransition,
    targetHead: () => args.git.head(),
    captureTargetBoundary: () =>
      captureTargetBoundary(args.store.read(), args.git),
    executeEffect: async ({ effect, signal, dispatch }) => {
      const state = args.store.read();
      const artifactsPath = join(
        args.lease.paths.runs,
        state.run.id,
        "artifacts",
      );
      if (effect.kind === "run_implementation") {
        const sourceWorkstreamId =
          effect.workstream.kind === "source"
            ? effect.workstream.id
            : undefined;
        const outcome =
          effect.workstream.kind === "source"
            ? await runWorkstreamCandidate({
                state,
                plan: readExecutionPlan(
                  join(args.lease.paths.runs, state.run.id),
                )!,
                workstreamId: effect.workstream.id,
                git: args.git,
                subagents,
                signal,
                roles: args.roles,
                recoveryObligations: Object.values(state.recoveryEpisodes)
                  .filter(
                    (episode) =>
                      episode.status === "open" &&
                      episode.workstream.kind === "source" &&
                      episode.workstream.id === sourceWorkstreamId,
                  )
                  .flatMap((episode) =>
                    episode.actions.map((action) => action.evidence),
                  ),
                trustedCheckpoint: Object.values(state.recoveryEpisodes).find(
                  (episode) =>
                    episode.status === "open" &&
                    episode.workstream.kind === "source" &&
                    episode.workstream.id === sourceWorkstreamId,
                )?.workspace.checkpoint,
                artifactsPath,
                artifactLeaseId: effect.leaseId,
              })
            : {
                kind: "candidate_ready" as const,
                ...(await runOverallRepair({
                  state,
                  plan: readExecutionPlan(
                    join(args.lease.paths.runs, state.run.id),
                  )!,
                  repairId: effect.workstream.repairId,
                  git: args.git,
                  subagents,
                  signal,
                  artifactsPath,
                  roles: args.roles,
                })),
              };
        await dispatch({
          kind: "implementation_completed",
          workstream: effect.workstream,
          leaseId: effect.leaseId,
          outcome,
        });
        return;
      }
      if (effect.kind === "run_review") {
        const outcome = await runWorkstreamReview({
          state,
          plan: readExecutionPlan(join(args.lease.paths.runs, state.run.id))!,
          workstream: effect.workstream,
          git: args.git,
          subagents,
          signal,
          artifactsPath,
          roles: args.roles,
        });
        const projectionDebt =
          outcome.kind !== "repository_state" ||
          effect.workstream.kind !== "source"
            ? undefined
            : (() => {
                const taskIds =
                  state.workstreams.source[effect.workstream.id]?.taskIds ?? [];
                const plan = readExecutionPlan(
                  join(args.lease.paths.runs, state.run.id),
                );
                if (!plan || taskIds.length === 0) {
                  return undefined;
                }
                const tasks = taskIds.map((taskId) =>
                  plan.tasks.find((task) => task.id === taskId),
                );
                if (tasks.some((task) => !task)) {
                  throw new Error(
                    "Satisfaction assessment task is missing its source anchor.",
                  );
                }
                const projection = createCheckboxProjectionIntent({
                  id: `projection:${state.run.id}:${effect.workstream.id}`,
                  checkoutRoot: state.run.checkout.root,
                  taskIds,
                  checkboxes: tasks.map((task) => task!.sourceAnchor),
                });
                return {
                  ...projection,
                  reason: "Approve repository-state satisfaction assessment.",
                  artifactPath: projection.canonicalPath,
                };
              })();
        await dispatch({
          kind: "review_completed",
          workstream: effect.workstream,
          leaseId: effect.leaseId,
          outcome,
          ...(projectionDebt ? { projectionDebt } : {}),
        });
        return;
      }
      if (effect.kind === "run_reconciliation") {
        const candidate = state.candidates[effect.candidateId];
        if (!candidate) {
          throw new Error("Reconciliation candidate is no longer retained.");
        }
        const targetBaseSha = await args.git.head();
        const retainedPreparation = Object.values(
          state.publication.preparations,
        ).find(
          (preparation) =>
            preparation.candidateId === candidate.id &&
            preparation.candidateCommitSha === candidate.commitSha &&
            preparation.targetBaseSha === targetBaseSha,
        );
        const replay = await new CandidateReplayEngine({
          git: args.git,
          worktreesRoot: join(args.lease.paths.worktrees, state.run.id),
          runId: state.run.id,
          protectedPaths: Object.keys(state.protectedArtifactHashes),
          protectedArtifactsMatch: () => protectedArtifactsMatch(state),
        }).prepare(candidate, signal, retainedPreparation);
        const workspace =
          replay.staging === undefined
            ? {
                id: `reconciliation:${effect.candidateId}`,
                changedPaths: [],
                stateEvidence: replay.kind,
              }
            : {
                id: replay.staging.id,
                checkpoint: replay.staging.preparedCommitSha,
                changedPaths: replay.staging.replayPaths ?? [],
                stateEvidence:
                  "evidence" in replay ? replay.evidence : replay.kind,
                ...(replay.staging.treeSha
                  ? {
                      stagingComparison: {
                        baseSha: replay.staging.targetBaseSha,
                        treeSha: replay.staging.treeSha,
                      },
                    }
                  : {}),
              };
        if (replay.kind === "repository_assessment_required") {
          if (effect.workstream.kind !== "source") {
            throw new Error("Only source workstreams may assess satisfaction.");
          }
          await dispatch({
            kind: "repository_assessment_required",
            workstream: effect.workstream,
            leaseId: effect.leaseId,
            targetSha: replay.staging.targetBaseSha,
            evidence: replay.evidence,
          });
          return;
        }
        if (replay.kind !== "prepared") {
          if (replay.kind === "cancelled") {
            return;
          }
          await dispatch({
            kind: "reconciliation_completed",
            workstream: effect.workstream,
            leaseId: effect.leaseId,
            outcome: {
              kind:
                replay.kind === "infrastructure_failure"
                  ? "execution_failed"
                  : replay.kind === "hook_rejected" ||
                      (replay.kind === "reconciliation_required" &&
                        replay.hookMutated)
                    ? "hook_rejected"
                    : "reconciliation_required",
              evidence:
                "evidence" in replay
                  ? replay.evidence
                  : "Replay did not produce a publishable candidate.",
              ...(replay.kind === "hook_rejected"
                ? { command: replay.command }
                : replay.kind === "reconciliation_required" &&
                    replay.hookMutated &&
                    replay.staging.hookCommand
                  ? { command: replay.staging.hookCommand }
                  : {}),
              workspace,
            },
          });
          return;
        }
        if (
          effect.workstream.kind === "source" &&
          candidate.commitSha === candidate.baseSha &&
          replay.staging.targetBaseSha === candidate.baseSha
        ) {
          const plan = readExecutionPlan(
            join(args.lease.paths.runs, state.run.id),
          );
          const taskIds =
            state.workstreams.source[effect.workstream.id]?.taskIds ?? [];
          const tasks = taskIds.map((taskId) =>
            plan?.tasks.find((task) => task.id === taskId),
          );
          if (!plan || tasks.some((task) => !task)) {
            throw new Error(
              "Satisfaction completion task is missing its source anchor.",
            );
          }
          const projection = createCheckboxProjectionIntent({
            id: `projection:${state.run.id}:${effect.workstream.id}`,
            checkoutRoot: state.run.checkout.root,
            taskIds,
            checkboxes: tasks.map((task) => task!.sourceAnchor),
          });
          await dispatch({
            kind: "satisfaction_completed",
            workstream: effect.workstream,
            leaseId: effect.leaseId,
            targetSha: replay.staging.targetBaseSha,
            evidence:
              "The reviewed satisfaction claim was assessed on its current target.",
            projectionDebt: {
              ...projection,
              reason: "Approve current-target satisfaction claim.",
              artifactPath: projection.canonicalPath,
            },
          });
          return;
        }
        const branch = await args.git.currentBranch();
        if (!branch) {
          throw new Error("Publication requires a named target branch.");
        }
        if (!replay.staging.hookCommand) {
          throw new Error(
            "Publishable staging commit is missing ordinary hook evidence.",
          );
        }
        const preparation = publicationPreparation(
          {
            runId: state.run.id,
            candidate,
            disposition: replay.disposition,
            targetRef: `refs/heads/${branch}`,
            hookEvidence: `Git commit completed with hooks: ${replay.staging.hookCommand.command}`,
            hookCommand: replay.staging.hookCommand,
          },
          replay.staging,
        );
        await dispatch({
          kind: "publication_preparation_recorded",
          preparation,
        });
        const intent = new WriteAheadPublisher({
          git: args.git,
          checkoutRoot: state.run.checkout.root,
          checkoutIdentity: state.run.checkout.gitDir,
          protectedPaths: Object.keys(state.protectedArtifactHashes),
        }).createIntent({
          id: `publication:${state.run.id}:${effect.workstream.kind === "source" ? effect.workstream.id : effect.workstream.repairId}:${replay.staging.preparedCommitSha}`,
          candidateId: candidate.id,
          targetBaseSha: preparation.targetBaseSha,
          preparedCommitSha: preparation.preparedCommitSha,
          preparedTreeSha: preparation.preparedTreeSha,
          targetRef: `refs/heads/${branch}`,
        });
        await dispatch({
          kind: "publication_intent_recorded",
          intent: {
            ...intent,
            workstream: effect.workstream,
            preparationId: preparation.id,
          },
        });
        await dispatch({
          kind: "reconciliation_completed",
          workstream: effect.workstream,
          leaseId: effect.leaseId,
          outcome: {
            kind: "prepared",
            evidence: `Prepared ${replay.disposition} replay at ${replay.staging.preparedCommitSha}.`,
            workspace,
          },
        });
        return;
      }
      if (effect.kind === "run_publication") {
        const plan = readExecutionPlan(
          join(args.lease.paths.runs, state.run.id),
        );
        const taskIds =
          effect.workstream.kind === "source"
            ? (state.workstreams.source[effect.workstream.id]?.taskIds ?? [])
            : [];
        let projectionDebt: RunState["projectionDebt"][number] | undefined;
        try {
          projectionDebt =
            taskIds.length === 0 || !plan
              ? undefined
              : (() => {
                  const tasks = taskIds.map((taskId) =>
                    plan.tasks.find((task) => task.id === taskId),
                  );
                  if (tasks.some((task) => !task)) {
                    throw new Error(
                      "Publication task is missing its source anchor.",
                    );
                  }
                  const projection = createCheckboxProjectionIntent({
                    id: `projection:${state.run.id}:${effect.workstream.kind === "source" ? effect.workstream.id : effect.workstream.repairId}`,
                    checkoutRoot: state.run.checkout.root,
                    taskIds,
                    checkboxes: tasks.map((task) => task!.sourceAnchor),
                  });
                  return {
                    ...projection,
                    reason: "Publish source workstream task completion.",
                    artifactPath: projection.canonicalPath,
                  };
                })();
        } catch (error) {
          await dispatch({
            kind: "process_abandoned",
            leaseId: effect.leaseId,
          });
          await dispatch({
            kind: "failure_requested",
            category: "safety",
            reason: error instanceof Error ? error.message : String(error),
            now: new Date().toISOString(),
          });
          return;
        }
        await runPublication({
          state,
          effect,
          publisher: new WriteAheadPublisher({
            git: args.git,
            checkoutRoot: state.run.checkout.root,
            checkoutIdentity: state.run.checkout.gitDir,
            protectedPaths: Object.keys(state.protectedArtifactHashes),
          }),
          dispatch,
          projectionDebt,
        });
        return;
      }
      if (effect.kind === "run_projection") {
        await runProjection({
          store: args.store,
          debtId: effect.debtId,
          dispatch,
        });
        return;
      }
      if (effect.kind === "run_whole_plan_review") {
        const plan = readExecutionPlan(
          join(args.lease.paths.runs, state.run.id),
        );
        if (!plan) {
          throw new Error(
            "Whole-plan review requires the durable execution plan.",
          );
        }
        await runWholePlanReview({
          state,
          plan,
          git: args.git,
          subagents,
          artifactsPath,
          signal,
          dispatch,
          roles: args.roles,
        });
        return;
      }
      if (effect.kind === "run_whole_plan_recovery") {
        const action = await runWholePlanRecovery({
          state,
          subagents,
          signal,
          roles: args.roles,
        });
        await dispatch({ kind: "whole_plan_recovery_completed", action });
        return;
      }
      if (effect.kind === "complete_whole_plan_run") {
        await completeWholePlanRun({
          state,
          git: args.git,
          dispatch,
        });
        return;
      }
      if (effect.kind === "run_recovery") {
        const outcome = await runRecovery({
          state,
          effect,
          git: args.git,
          subagents,
          artifactsPath,
          signal,
          roles: args.roles,
        });
        await dispatch({
          kind: "recovery_completed",
          workstream: effect.workstream,
          leaseId: effect.leaseId,
          ...outcome,
        });
        return;
      }
      throw new Error("Unsupported effect.");
    },
    executePlanner: async ({ signal }) => {
      const retained = readExecutionPlan(
        join(args.lease.paths.runs, args.store.read().run.id),
      );
      if (retained) {
        return retained;
      }
      const client = subagents;
      const result = await planExecution({
        plan: args.plan,
        planHash: sha256(args.plan.content),
        materialStore: args.materialStore,
        checkoutId: args.checkoutIdentity,
        baseSha: args.baseSha,
        workerConcurrency: args.store.read().run.workerConcurrency,
        runDir: join(args.lease.paths.runs, args.store.read().run.id),
        workspacePath: args.store.read().run.checkout.root,
        checkoutRoot: args.store.read().run.checkout.root,
        runId: args.store.read().run.id,
        requestPlanner: async (packet) => {
          const handle = await spawnValidatedWorker({
            packet,
            subagents: client,
            roles: args.roles,
            taskId: "planner",
            description: "Compile strict execution plan",
            render: buildStrictExecutionPlannerPrompt,
          });
          const response = await client.waitFor(handle, signal);
          if (response.status !== "completed") {
            throw new Error(`Planner ${response.status}: ${response.error}`);
          }
          return response.result;
        },
      });
      if (!result.ok || result.value.kind === "no-op") {
        throw new Error(
          result.ok ? "Plan became a no-op during planning." : result.reason,
        );
      }
      return result.value.plan;
    },
  });
}

async function readText(path: string): Promise<string> {
  const { readFile } = await import("node:fs/promises");
  return readFile(path, "utf-8");
}
