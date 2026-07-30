import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ExecGitClient } from "../git.js";
import { runRecovery } from "./recovery-service.js";
import type { ImplementRoles, SpawnArgs } from "../subagents.js";
import type { RunState } from "../store.js";

const directories = new Set<string>();

function recoveryRoles(): ImplementRoles {
  return {
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
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

afterEach(() => {
  for (const directory of directories) {
    rmSync(directory, { force: true, recursive: true });
  }
  directories.clear();
});

describe("recovery service Git boundary", () => {
  it("repairs a hook failure only through the retained candidate workspace", async () => {
    const root = mkdtempSync(join(tmpdir(), "pipkin-implement-hook-recovery-"));
    directories.add(root);
    git(root, "init");
    git(root, "config", "user.email", "test@example.com");
    git(root, "config", "user.name", "Test");
    writeFileSync(join(root, "base.txt"), "base\n");
    git(root, "add", ".");
    git(root, "commit", "-m", "chore: init");
    const client = new ExecGitClient(root);
    const baseSha = await client.head();
    const candidatePath = join(
      root,
      ".pi",
      "pipkin",
      "implement",
      "worktrees",
      "run-1",
      "work",
    );
    await client.createTaskBranch("pipkin/implement/run-1/work", baseSha);
    await client.addWorktree(candidatePath, "pipkin/implement/run-1/work");
    writeFileSync(join(candidatePath, "candidate.txt"), "candidate\n");
    git(candidatePath, "add", ".");
    git(candidatePath, "commit", "-m", "feat: candidate");
    const candidateGit = client.forWorktree(candidatePath);
    const candidateSha = await candidateGit.head();
    const candidateTreeSha = await candidateGit.treeAt(candidateSha);
    const candidateId = `candidate:work:${candidateSha}`;
    const state = {
      run: {
        id: "run-1",
        checkout: {
          root,
          branchRef: `refs/heads/${await client.currentBranch()}`,
          startHead: baseSha,
        },
      },
      workstreams: {
        source: {
          work: {
            kind: "source",
            id: "work",
            baseSha,
            candidateId,
          },
        },
        overall: {},
      },
      gates: [
        {
          id: "hook:work:1",
          kind: "hook",
          workstream: { kind: "source", id: "work" },
          candidateId,
          attempt: 1,
          outcome: "failed",
          evidence: "hook changed tracked content",
          outstandingFindingIds: [],
        },
      ],
      recoveryEpisodes: {
        episode: {
          id: "episode",
          gateId: "hook:work:1",
          gateAttempts: ["hook:work:1"],
          workstream: { kind: "source", id: "work" },
          candidateId,
          workspace: {
            id: "source:work",
            checkpoint: candidateSha,
            changedPaths: ["generated.txt"],
            stateEvidence: "The commit hook changed tracked content.",
            stagingComparison: {
              baseSha,
              treeSha: candidateTreeSha,
            },
          },
          outstandingFindingIds: [],
          status: "open",
          cycle: {
            signature: "initial",
            identicalNoActionCycles: 0,
            independentlyEscalated: false,
          },
          executionFailures: 0,
          actions: [],
        },
      },
      candidates: {
        [candidateId]: {
          id: candidateId,
          workstream: { kind: "source", id: "work" },
          baseSha,
          commitSha: candidateSha,
          treeSha: candidateTreeSha,
        },
      },
      protectedArtifactHashes: {},
    } as unknown as RunState;
    let spawned: SpawnArgs | undefined;

    const result = await runRecovery({
      state,
      effect: {
        kind: "run_recovery",
        workstream: { kind: "source", id: "work" },
        leaseId: "lease",
        episodeId: "episode",
        independentlyEscalated: false,
      },
      git: client,
      subagents: {
        stop: async () => undefined,
        spawn: async (args: SpawnArgs) => {
          spawned = args;
          return "recovery-agent" as never;
        },
        waitFor: async () => {
          writeFileSync(join(candidatePath, "correction.txt"), "fixed\n");
          git(candidatePath, "add", ".");
          git(candidatePath, "commit", "-m", "fix: correct hook output");
          const candidateTip = await candidateGit.head();
          return {
            status: "completed" as const,
            result: {
              action: "rework_candidate" as const,
              summary: "Committed the hook correction.",
              evidence: "The candidate now includes the tracked correction.",
              candidateTip,
              changedPaths: ["correction.txt"],
            },
          } as never;
        },
      },
      artifactsPath: join(root, ".pi", "pipkin", "implement", "artifacts"),
      roles: recoveryRoles(),
    });

    expect(spawned).toMatchObject({ cwd: candidatePath });
    expect(spawned?.prompt).not.toContain("Staging diff:");
    expect(spawned?.prompt).not.toContain("generated hook correction");
    expect(spawned?.prompt).toContain("Retained failed staging state");
    expect(spawned?.prompt).toContain(
      `git diff --stat ${baseSha} ${candidateTreeSha}`,
    );
    expect(spawned?.prompt).not.toContain("staging-");
    expect(result.correction).toMatchObject({
      changedPaths: ["correction.txt"],
    });
    expect(result.candidate?.commitSha).toBe(await candidateGit.head());
  });
});
