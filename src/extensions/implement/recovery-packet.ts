import { isAbsolute, resolve } from "node:path";
import { overallRepairWorkspace } from "./overall-repair.js";
import type { RuntimeWorkstream, SchedulerEffect } from "./scheduler.js";
import type { RunState } from "./store.js";
import { WorkerPacketError } from "./worker-invocation.js";
import { workstreamWorkspace } from "./workstream-candidate.js";

type Workstream = RuntimeWorkstream;
type Candidate = RunState["candidates"][string];
type Gate = RunState["gates"][number];
type Finding = RunState["findings"][string];

export type ArtifactProvenance = {
  kind: "retained-artifact";
  path: string;
};

export type RecoveryWorkerPacket = {
  role: "recovery";
  identity: string;
  workspace: {
    path: string;
    correctionPath: string;
    mutationBoundary: string;
  };
  target: {
    branchRef: string;
    startHead: string;
  };
  episode: {
    id: string;
    gateId: string;
    gateAttempts: string[];
    workstream: Workstream;
    candidateId?: string;
    workspace: RunState["recoveryEpisodes"][string]["workspace"];
    priorActions: RunState["recoveryEpisodes"][string]["actions"];
  };
  gate: {
    id: string;
    kind: Gate["kind"];
    attempt: number;
    evidence: string;
    command?: Gate["command"];
    targetEvidence?: string;
    artifactProvenance?: ArtifactProvenance;
  };
  candidate?: Candidate;
  outstandingFindings: Finding[];
};

export function buildRecoveryPacket(args: {
  state: RunState;
  effect: Extract<SchedulerEffect, { kind: "run_recovery" }>;
}): RecoveryWorkerPacket {
  const episode = args.state.recoveryEpisodes[args.effect.episodeId];
  if (!episode || episode.status !== "open") {
    throw packetError(
      args.effect,
      "does not reference an open durable episode",
    );
  }
  if (!sameWorkstream(episode.workstream, args.effect.workstream)) {
    throw packetError(
      args.effect,
      "does not own the recovery episode workstream",
    );
  }
  const gate = args.state.gates.find((entry) => entry.id === episode.gateId);
  if (!gate) {
    throw packetError(args.effect, `references missing gate ${episode.gateId}`);
  }
  if (
    gate.outcome !== "failed" ||
    episode.gateAttempts.at(-1) !== gate.id ||
    !sameWorkstream(gate.workstream, episode.workstream) ||
    gate.candidateId !== episode.candidateId ||
    !sameIds(gate.outstandingFindingIds, episode.outstandingFindingIds)
  ) {
    throw packetError(args.effect, "has an inconsistent current failed gate");
  }
  if (
    new Set(episode.gateAttempts).size !== episode.gateAttempts.length ||
    new Set(episode.outstandingFindingIds).size !==
      episode.outstandingFindingIds.length
  ) {
    throw packetError(args.effect, "lists duplicate retained references");
  }
  const candidate = episode.candidateId
    ? args.state.candidates[episode.candidateId]
    : undefined;
  if (episode.candidateId && !candidate) {
    throw packetError(
      args.effect,
      `references missing candidate ${episode.candidateId}`,
    );
  }
  if (candidate && !sameWorkstream(candidate.workstream, episode.workstream)) {
    throw packetError(
      args.effect,
      "references a candidate from another workstream",
    );
  }
  const runtime = currentRuntime(args.state, episode.workstream);
  if (
    !runtime ||
    (candidate &&
      (runtime.candidateId !== candidate.id ||
        (episode.workstream.kind === "source" &&
          (runtime.kind !== "source" ||
            candidate.baseSha !== runtime.baseSha)) ||
        (episode.workspace.checkpoint !== undefined &&
          ![candidate.baseSha, candidate.commitSha].includes(
            episode.workspace.checkpoint,
          ))))
  ) {
    throw packetError(
      args.effect,
      "does not match its current candidate or retained workspace checkpoint",
    );
  }
  const review = args.state.reviews?.[workstreamIdentity(episode.workstream)];
  if (
    episode.outstandingFindingIds.length > 0 &&
    (!review ||
      review.candidateId !== episode.candidateId ||
      !sameIds(review.outstandingIds, episode.outstandingFindingIds))
  ) {
    throw packetError(args.effect, "does not match its active review epoch");
  }
  const outstandingFindings = episode.outstandingFindingIds.map((id) => {
    const finding = args.state.findings[id];
    const findingCandidate = finding
      ? args.state.candidates[finding.candidateId]
      : undefined;
    if (
      !finding ||
      !findingCandidate ||
      finding.status !== "open" ||
      !sameWorkstream(finding.workstream, episode.workstream) ||
      !sameWorkstream(findingCandidate.workstream, episode.workstream)
    ) {
      throw packetError(args.effect, `references inconsistent finding ${id}`);
    }
    return finding;
  });
  validateRecoveryWorkspace(args.state, args.effect.workstream);
  const correctionPath = candidateWorktree(
    args.state,
    args.effect.workstream,
    candidate,
  );
  const workspacePath = recoveryWorktree(
    args.state,
    args.effect.workstream,
    candidate,
    episode.workspace,
    gate.kind,
  );
  const usesHookStaging = workspacePath !== correctionPath;
  const artifactProvenance =
    gate.kind === "review" && isAbsolute(gate.evidence)
      ? { kind: "retained-artifact" as const, path: gate.evidence }
      : undefined;
  return {
    role: "recovery",
    identity: `${episode.id}/${gate.id}`,
    workspace: {
      path: workspacePath,
      correctionPath,
      mutationBoundary: usesHookStaging
        ? `Ignored/runtime hook repair belongs in ${workspacePath}; tracked candidate corrections belong in ${correctionPath}. The target checkout is read-only.`
        : "The assigned disposable worktree only; the target checkout is read-only.",
    },
    target: {
      branchRef: args.state.run.checkout.branchRef,
      startHead: args.state.run.checkout.startHead,
    },
    episode: {
      id: episode.id,
      gateId: episode.gateId,
      gateAttempts: [...episode.gateAttempts],
      workstream: episode.workstream,
      ...(episode.candidateId ? { candidateId: episode.candidateId } : {}),
      workspace: episode.workspace,
      priorActions: episode.actions,
    },
    gate: {
      id: gate.id,
      kind: gate.kind,
      attempt: gate.attempt,
      evidence: artifactProvenance
        ? "The gate evidence is retained by the orchestrator."
        : gate.evidence,
      ...(gate.command ? { command: gate.command } : {}),
      ...(gate.targetEvidence ? { targetEvidence: gate.targetEvidence } : {}),
      ...(artifactProvenance ? { artifactProvenance } : {}),
    },
    ...(candidate ? { candidate } : {}),
    outstandingFindings,
  };
}

export function recoveryTaskId(workstream: Workstream): string {
  return workstream.kind === "source" ? workstream.id : workstream.repairId;
}

function recoveryWorktree(
  state: RunState,
  workstream: Workstream,
  candidate: Candidate | undefined,
  workspace: RunState["recoveryEpisodes"][string]["workspace"],
  gateKind: Gate["kind"],
): string {
  if (gateKind === "hook" && workspace.id.startsWith("staging-")) {
    const root = resolve(
      state.run.checkout.root,
      ".pi",
      "pipkin",
      "implement",
      "worktrees",
      state.run.id,
    );
    const staging = resolve(root, workspace.id);
    if (!staging.startsWith(`${root}/`)) {
      throw packetErrorForWorkspace(
        workstream,
        "Hook staging workspace escapes its run root",
      );
    }
    return staging;
  }
  return candidateWorktree(state, workstream, candidate);
}

function currentRuntime(state: RunState, workstream: Workstream) {
  return workstream.kind === "source"
    ? state.workstreams.source[workstream.id]
    : state.workstreams.overall[workstream.repairId];
}

function validateRecoveryWorkspace(
  state: RunState,
  workstream: Workstream,
): void {
  if (workstream.kind === "source") {
    const runtime = state.workstreams.source[workstream.id];
    if (!runtime) {
      throw packetErrorForWorkspace(
        workstream,
        "references an unknown source workstream",
      );
    }
    if (!runtime.baseSha) {
      throw packetErrorForWorkspace(workstream, "has no assigned runtime base");
    }
    return;
  }
  if (!state.workstreams.overall[workstream.repairId]) {
    throw packetErrorForWorkspace(
      workstream,
      "references an unknown overall repair",
    );
  }
}

function candidateWorktree(
  state: RunState,
  workstream: Workstream,
  candidate: Candidate | undefined,
): string {
  if (workstream.kind === "source") {
    return workstreamWorkspace(state, workstream.id).worktreePath;
  }
  return overallRepairWorkspace(
    state,
    workstream.repairId,
    candidate?.commitSha ?? state.run.checkout.startHead,
  ).worktreePath;
}

function sameWorkstream(left: Workstream, right: Workstream): boolean {
  return (
    left.kind === right.kind &&
    (left.kind === "source" && right.kind === "source"
      ? left.id === right.id
      : left.kind === "overall" && right.kind === "overall"
        ? left.repairId === right.repairId
        : false)
  );
}

function workstreamIdentity(workstream: Workstream): string {
  return workstream.kind === "source"
    ? `source:${workstream.id}`
    : `overall:${workstream.repairId}`;
}

function sameIds(left: string[], right: string[]): boolean {
  return (
    left.length === right.length &&
    left.every((id, index) => id === right[index])
  );
}

function packetError(
  effect: Extract<SchedulerEffect, { kind: "run_recovery" }>,
  invariant: string,
): WorkerPacketError {
  return new WorkerPacketError(
    `Recovery packet ${effect.episodeId} for ${recoveryTaskId(effect.workstream)} ${invariant}.`,
  );
}

function packetErrorForWorkspace(
  workstream: Workstream,
  invariant: string,
): WorkerPacketError {
  return new WorkerPacketError(
    `Recovery packet workspace for ${recoveryTaskId(workstream)} ${invariant}.`,
  );
}
