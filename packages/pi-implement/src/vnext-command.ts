import { createHash } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { buildMaterialStore } from "./material-store.js";
import { parsePlan } from "./plan.js";
import { planExecution, readExecutionPlan } from "./execution-plan-vnext.js";
import { ExecGitClient } from "./git.js";
import { RuntimeSubagentClient } from "./subagents.js";
import { strictExecutionPlanSchema } from "./result-schemas.js";
import { runWorkstreamCandidate } from "./workstream-candidate.js";
import { runVNextOverallRepair } from "./vnext-overall-repair.js";
import { runVNextWorkstreamReview } from "./vnext-review.js";
import { VNextSchedulerActor } from "./scheduler-vnext.js";
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
    const actor = createActor({
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
      !sourceIdentityMatches(current) ||
      !protectedArtifactsMatch(current)
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
    const actor =
      store.read().phase === "planning"
        ? createActor({
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
          })
        : new VNextSchedulerActor({ store });
    if (store.read().phase === "paused") {
      await actor.dispatch({ kind: "resume_requested" });
    }
    await actor.start();
    return { runId: args.runId, actor, lease, store };
  } catch (error) {
    await lease.release();
    throw error;
  }
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

function createActor(args: {
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
    executeEffect: async ({ effect, signal, dispatch }) => {
      const state = args.store.read();
      const artifactsPath = join(
        args.lease.paths.runs,
        state.run.id,
        "artifacts",
      );
      if (effect.kind === "run_implementation") {
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
                })),
              };
        await dispatch({
          kind: "implementation_completed",
          workstream: effect.workstream,
          leaseId: effect.leaseId,
          outcome,
        });
        await dispatch({
          kind: "review_requested",
          workstream: effect.workstream,
          now: new Date().toISOString(),
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
        });
        await dispatch({
          kind: "review_completed",
          workstream: effect.workstream,
          leaseId: effect.leaseId,
          outcome,
        });
        const runtime =
          effect.workstream.kind === "source"
            ? args.store.read().workstreams.source[effect.workstream.id]
            : args.store.read().workstreams.overall[effect.workstream.repairId];
        if (runtime?.phase === "approved") {
          await dispatch({
            kind: "reconciliation_requested",
            workstream: effect.workstream,
            now: new Date().toISOString(),
          });
        }
        return;
      }
      throw new Error(`VNext effect ${effect.kind} is not wired yet.`);
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
        planHash: hash(args.plan.content),
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

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
