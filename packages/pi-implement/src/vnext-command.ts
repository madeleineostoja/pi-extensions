import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { buildMaterialStore } from "./material-store.js";
import { parsePlan } from "./plan.js";
import { planExecution, readExecutionPlan } from "./execution-plan-vnext.js";
import {
  CandidateReplayEngine,
  publicationPreparation,
} from "./candidate-replay.js";
import { ExecGitClient } from "./git.js";
import { RuntimeSubagentClient } from "./subagents.js";
import { runVNextProjection } from "./vnext-projection-runner.js";
import { createCheckboxProjectionIntent } from "./vnext-projection.js";
import { runVNextPublication } from "./vnext-publication.js";
import {
  completeVNextWholePlanRun,
  runVNextWholePlanReview,
} from "./vnext-whole-plan-review.js";
import { settleVNextCleanupDebt } from "./vnext-cleanup.js";
import { WriteAheadPublisher } from "./write-ahead-publication.js";
import { strictExecutionPlanSchema } from "./result-schemas.js";
import { sha256 } from "./source-integrity.js";
import {
  runWorkstreamCandidate,
  TargetBoundaryError,
} from "./workstream-candidate.js";
import { runVNextOverallRepair } from "./vnext-overall-repair.js";
import { runVNextWorkstreamReview } from "./vnext-review.js";
import { runVNextRecovery } from "./recovery-service.js";
import { reduceVNextRunEvent, VNextSchedulerActor } from "./scheduler-vnext.js";
import {
  acquireCheckoutLease,
  checkoutPaths,
  createPlanningRun,
  loadVNextRunState,
  makeVNextRunId,
  protectedArtifactsMatch,
  sourceIdentityForPlanning,
  sourceIdentityMatches,
  type CheckoutLeaseCapability,
  type VNextRunState,
  VNextRunStore,
} from "./vnext-store.js";
import type { EffectiveRoles } from "./config.js";

export type ActiveVNextRun = {
  runId: string;
  actor: VNextSchedulerActor;
  lease: CheckoutLeaseCapability;
  store: VNextRunStore;
};

export async function startVNextRun(args: {
  pi: ExtensionAPI;
  ctx: ExtensionCommandContext;
  planPath: string;
  roles: EffectiveRoles;
  workerConcurrency: number;
}): Promise<{ kind: "no-op" } | { kind: "started"; active: ActiveVNextRun }> {
  const planPath = resolve(args.ctx.cwd, args.planPath);
  const content = await readText(planPath);
  const parsed = parsePlan(planPath, content);
  if (parsed.tasks.every((task) => task.checked)) {
    return { kind: "no-op" };
  }
  const git = new ExecGitClient(args.ctx.cwd);
  const [checkoutRoot, checkoutIdentity, baseSha, branch] = await Promise.all([
    git.root(),
    git.checkoutIdentity(),
    git.head(),
    git.currentBranch(),
  ]);
  const materialStore = buildMaterialStore({
    plan: parsed,
    planPath,
    repoRoot: checkoutRoot,
  });
  const runId = makeVNextRunId();
  const lease = await acquireCheckoutLease({
    checkoutRoot,
    gitDir: checkoutIdentity,
    runId,
    timeoutMs: 10_000,
  });
  try {
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
    const actor = createVNextRuntime({
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
    });
    await actor.start();
    return { kind: "started", active: { runId, actor, lease, store } };
  } catch (error) {
    await lease.release();
    throw error;
  }
}

export async function resumeVNextRun(args: {
  pi: ExtensionAPI;
  ctx: ExtensionCommandContext;
  planPath: string;
  runId: string;
  roles: EffectiveRoles;
}): Promise<ActiveVNextRun> {
  const planPath = resolve(args.ctx.cwd, args.planPath);
  const git = new ExecGitClient(args.ctx.cwd);
  const [checkoutRoot, checkoutIdentity] = await Promise.all([
    git.root(),
    git.checkoutIdentity(),
  ]);
  if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(args.runId)) {
    throw new Error(
      "Run ID is invalid; inspect or remove historical artifacts manually.",
    );
  }
  const runPath = join(checkoutPaths(checkoutRoot).runs, args.runId);
  if (!existsSync(join(runPath, "run-state.json"))) {
    throw new Error(
      `Run ${args.runId} is not a VNext run in this checkout. Historical runs are unsupported; inspect or remove them manually.`,
    );
  }
  const retained = loadVNextRunState(join(runPath, "run-state.json"));
  if (
    retained.run.checkout.root !== checkoutRoot ||
    retained.run.checkout.gitDir !== checkoutIdentity
  ) {
    throw new Error(
      "Run belongs to a different checkout; inspect it from that checkout.",
    );
  }
  const lease = await acquireCheckoutLease({
    checkoutRoot,
    gitDir: checkoutIdentity,
    runId: args.runId,
    timeoutMs: 10_000,
  });
  try {
    const store = VNextRunStore.open(
      lease,
      join(lease.paths.runs, args.runId, "run-state.json"),
    );
    const content = await readText(planPath);
    const parsed = parsePlan(planPath, content);
    const materialStore = buildMaterialStore({
      plan: parsed,
      planPath,
      repoRoot: checkoutRoot,
    });
    await recoverPublicationTransactions({ store, git });
    const current = store.read();
    if (current.phase === "planning") {
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
      if (JSON.stringify(source) !== JSON.stringify(current.run.source)) {
        throw new Error("Plan corpus changed; planning resume is unsafe.");
      }
    } else if (
      !projectionDebtMatchesIntent(current) &&
      (!sourceIdentityMatches(current) || !protectedArtifactsMatch(current))
    ) {
      throw new Error(
        "Plan corpus or protected artifacts changed; resume is unsafe.",
      );
    }
    const plan = readExecutionPlan(runPath);
    if (current.phase !== "planning" && !plan) {
      throw new Error(
        "Bound VNext run is missing execution-plan.json; inspect or remove it manually.",
      );
    }
    const actor = createVNextRuntime({
      pi: args.pi,
      ctx: args.ctx,
      git,
      store,
      lease,
      roles: args.roles,
      plan: parsed,
      materialStore,
      checkoutIdentity,
      baseSha: store.read().run.checkout.startHead,
    });
    if (store.read().phase === "paused") {
      await actor.resume();
    }
    await actor.start();
    return { runId: args.runId, actor, lease, store };
  } catch (error) {
    await lease.release();
    throw error;
  }
}

async function recoverPublicationTransactions(args: {
  store: VNextRunStore;
  git: ExecGitClient;
}): Promise<void> {
  for (const intent of Object.values(args.store.read().publication.intents)) {
    const state = args.store.read();
    const workstream =
      intent.workstream.kind === "source"
        ? state.workstreams.source[intent.workstream.id]
        : state.workstreams.overall[intent.workstream.repairId];
    if (workstream?.phase === "completed") {
      continue;
    }
    const outcome = await new WriteAheadPublisher({
      git: args.git,
      checkoutRoot: state.run.checkout.root,
      checkoutIdentity: state.run.checkout.gitDir,
      protectedPaths: Object.keys(state.protectedArtifactHashes),
    }).recover(intent);
    if (outcome.kind === "published") {
      if (!state.publication.receipts[intent.id]) {
        const transition = reduceVNextRunEvent(args.store.read(), {
          kind: "publication_receipt_recorded",
          receipt: outcome.receipt,
        });
        if (!transition.accepted) {
          throw new Error(
            transition.error ?? "Publication recovery receipt was rejected.",
          );
        }
        const revision = args.store.read().revision;
        await args.store.update(revision, () => transition.state);
      }
      continue;
    }
    if (
      outcome.kind !== "retry_from_base" ||
      state.publication.receipts[intent.id]
    ) {
      throw new Error(
        outcome.kind === "safety_paused"
          ? outcome.reason
          : "Publication recovery could not prove an exact durable transaction state.",
      );
    }
  }
}

function projectionDebtMatchesIntent(state: VNextRunState): boolean {
  if (state.projectionDebt.length === 0) {
    return false;
  }
  const projectedPaths = new Set(
    state.projectionDebt.map((debt) => debt.canonicalPath),
  );
  return (
    state.projectionDebt.every((debt) => {
      try {
        const content = readFileSync(debt.canonicalPath, "utf-8");
        const hash = sha256(content);
        return (
          (hash === debt.expectedOldHash &&
            content === debt.expectedOldContent) ||
          (hash === debt.expectedNewHash && content === debt.expectedNewContent)
        );
      } catch {
        return false;
      }
    }) &&
    state.run.source.corpus
      .filter((artifact) => !projectedPaths.has(artifact.path))
      .every((artifact) => {
        try {
          return sha256(readFileSync(artifact.path, "utf-8")) === artifact.hash;
        } catch {
          return false;
        }
      })
  );
}

export async function stopVNextRun(active: ActiveVNextRun): Promise<void> {
  try {
    await active.actor.stop("Stopped by user.");
  } finally {
    await active.lease.release();
  }
}

export function vnextRunIds(checkoutRoot: string): string[] {
  const runs = checkoutPaths(checkoutRoot).runs;
  if (!existsSync(runs)) {
    return [];
  }
  return readdirSync(runs).filter((runId) =>
    existsSync(join(runs, runId, "run-state.json")),
  );
}

export function createVNextRuntime(args: {
  pi: ExtensionAPI;
  ctx: ExtensionCommandContext;
  git: ExecGitClient;
  store: VNextRunStore;
  lease: CheckoutLeaseCapability;
  roles: EffectiveRoles;
  plan: ReturnType<typeof parsePlan>;
  materialStore: ReturnType<typeof buildMaterialStore>;
  checkoutIdentity: string;
  baseSha: string;
}): VNextSchedulerActor {
  return new VNextSchedulerActor({
    store: args.store,
    targetHead: () => args.git.head(),
    targetDiff: (from, to) => args.git.diffRange(from, to),
    captureTargetBoundary: async () => {
      const state = args.store.read();
      const protectedPaths = Object.keys(state.protectedArtifactHashes);
      const [checkout, branch, head, operation, clean] = await Promise.all([
        args.git.checkoutIdentity(),
        args.git.currentBranch(),
        args.git.head(),
        args.git.activeOperation(),
        args.git.isCleanExcept(protectedPaths),
      ]);
      const protectedMatch = protectedArtifactsMatch(state);
      if (
        checkout !== state.run.checkout.gitDir ||
        branch !== state.run.checkout.branchRef.replace("refs/heads/", "") ||
        operation !== undefined ||
        !clean ||
        !protectedMatch
      ) {
        throw new TargetBoundaryError(
          "Managed work requires an unchanged, clean target checkout boundary.",
        );
      }
      return JSON.stringify({
        checkout,
        branch,
        head,
        operation,
        clean,
        protected: protectedMatch,
      });
    },
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
                subagents: new RuntimeSubagentClient(
                  args.pi,
                  args.ctx,
                  state.run.id,
                ),
                signal,
                roles: args.roles.implementer,
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
              })
            : {
                kind: "candidate_ready" as const,
                ...(await runVNextOverallRepair({
                  state,
                  plan: readExecutionPlan(
                    join(args.lease.paths.runs, state.run.id),
                  )!,
                  repairId: effect.workstream.repairId,
                  git: args.git,
                  subagents: new RuntimeSubagentClient(
                    args.pi,
                    args.ctx,
                    state.run.id,
                  ),
                  signal,
                  artifactsPath,
                  roles: args.roles.implementer,
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
        const outcome = await runVNextWorkstreamReview({
          state,
          plan: readExecutionPlan(join(args.lease.paths.runs, state.run.id))!,
          workstream: effect.workstream,
          git: args.git,
          subagents: new RuntimeSubagentClient(args.pi, args.ctx, state.run.id),
          signal,
          artifactsPath,
          roles: args.roles.reviewer,
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
                stateEvidence: replay.kind,
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
            interveningDiff: await args.git.diffRange(
              candidate.baseSha,
              replay.staging.targetBaseSha,
            ),
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
                  : "reconciliation_required",
              evidence:
                "evidence" in replay
                  ? replay.evidence
                  : "Replay did not produce a publishable candidate.",
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
        const preparation = publicationPreparation(
          {
            runId: state.run.id,
            candidate,
            disposition: replay.disposition,
            targetRef: `refs/heads/${branch}`,
            hookEvidence: "Candidate checkpoints completed through Git hooks.",
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
        let projectionDebt: VNextRunState["projectionDebt"][number] | undefined;
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
            kind: "projection_safety_paused",
            reason: error instanceof Error ? error.message : String(error),
          });
          return;
        }
        await runVNextPublication({
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
        await runVNextProjection({
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
        await runVNextWholePlanReview({
          state,
          plan,
          git: args.git,
          subagents: new RuntimeSubagentClient(args.pi, args.ctx, state.run.id),
          artifactsPath,
          signal,
          dispatch,
          roles: args.roles.reviewer,
        });
        return;
      }
      if (effect.kind === "complete_whole_plan_run") {
        await completeVNextWholePlanRun({
          state,
          git: args.git,
          dispatch,
        });
        return;
      }
      if (effect.kind === "run_cleanup") {
        await settleVNextCleanupDebt({
          store: args.store,
          git: args.git,
          debtId: effect.debtId,
          dispatch,
        });
        return;
      }
      if (effect.kind === "run_recovery") {
        const outcome = await runVNextRecovery({
          state,
          effect,
          git: args.git,
          subagents: new RuntimeSubagentClient(args.pi, args.ctx, state.run.id),
          artifactsPath,
          signal,
          roles: args.roles.recovery,
        });
        await dispatch({
          kind: "recovery_completed",
          workstream: effect.workstream,
          leaseId: effect.leaseId,
          ...outcome,
        });
        return;
      }
      throw new Error("Unsupported VNext effect.");
    },
    executePlanner: async ({ signal }) => {
      const retained = readExecutionPlan(
        join(args.lease.paths.runs, args.store.read().run.id),
      );
      if (retained) {
        return retained;
      }
      const client = new RuntimeSubagentClient(
        args.pi,
        args.ctx,
        args.store.read().run.id,
      );
      const result = await planExecution({
        plan: args.plan,
        planHash: sha256(args.plan.content),
        materialStore: args.materialStore,
        checkoutId: args.checkoutIdentity,
        baseSha: args.baseSha,
        workerConcurrency: args.store.read().run.workerConcurrency,
        runDir: join(args.lease.paths.runs, args.store.read().run.id),
        requestPlanner: async (prompt) => {
          const handle = await client.spawn({
            type: args.roles.planner.type,
            role: "planner",
            model: args.roles.planner.model,
            thinking: args.roles.planner.thinking,
            description: "Compile strict VNext execution plan",
            prompt,
            cwd: args.ctx.cwd,
            readOnly: true,
            completion: {
              description: "Return the strict execution plan.",
              schema: strictExecutionPlanSchema,
            },
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
