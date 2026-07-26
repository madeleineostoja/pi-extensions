import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stagingIdentity } from "./candidate-replay.js";
import { ExecGitClient } from "./git.js";
import { runRecovery } from "./recovery-service.js";
import type { SpawnArgs } from "./subagents.js";
import type { RunState } from "./store.js";

const directories = new Set<string>();

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

afterEach(() => {
  for (const directory of directories) {
    rmSync(directory, { force: true, recursive: true });
  }
  directories.clear();
});

describe(" recovery service", () => {
  it("launches the configured recovery role with the retained episode", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pi-implement-recovery-"));
    directories.add(directory);
    const spawned: Array<Record<string, unknown>> = [];
    const state = {
      run: {
        id: "run-1",
        checkout: {
          root: directory,
          branchRef: "refs/heads/main",
          startHead: "base-sha",
        },
      },
      workstreams: {
        source: {
          work: { kind: "source", id: "work", baseSha: "base-sha" },
        },
        overall: {},
      },
      gates: [
        {
          id: "hook:work:1",
          kind: "hook",
          command: {
            command: "git commit -m chore",
            cwd: "/tmp/staging",
            exitCode: 1,
            timedOut: false,
            output: "pre-commit rejected",
          },
        },
      ],
      recoveryEpisodes: {
        episode: {
          id: "episode",
          gateId: "hook:work:1",
          workstream: { kind: "source", id: "work" },
          workspace: {
            id: "staging-test",
            changedPaths: [],
            stateEvidence: "provider disconnected",
          },
          actions: [],
        },
      },
      candidates: {},
      protectedArtifactHashes: {},
    } as unknown as RunState;

    const outcome = await runRecovery({
      state,
      effect: {
        kind: "run_recovery",
        workstream: { kind: "source", id: "work" },
        leaseId: "lease",
        episodeId: "episode",
        independentlyEscalated: false,
      },
      git: {} as never,
      subagents: {
        stop: async () => undefined,
        spawn: async (args: SpawnArgs) => {
          spawned.push(args as unknown as Record<string, unknown>);
          return "recovery-agent" as never;
        },
        waitFor: async () => ({
          status: "completed" as const,
          result: {
            action: "repair_environment" as const,
            summary: "Restored ignored dependencies.",
            evidence: "npm install completed in the owned worktree.",
          },
        }),
      } as never,
      artifactsPath: directory,
      roles: {
        type: "recovery-role",
        model: "model/recovery",
        thinking: "high",
      },
    });

    expect(outcome.action).toMatchObject({
      kind: "repair_environment",
      outcome: "completed",
    });
    expect(spawned).toHaveLength(1);
    expect(spawned[0]).toMatchObject({
      type: "recovery-role",
      role: "recovery",
      model: "model/recovery",
      thinking: "high",
    });
    expect(spawned[0]).toMatchObject({
      cwd: join(
        directory,
        ".pi",
        "implement",
        "worktrees",
        "run-1",
        "staging-test",
      ),
    });
    expect(String(spawned[0]?.prompt)).toContain("pre-commit rejected");
  });

  it("validates tracked hook corrections from the candidate worktree", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-implement-hook-recovery-"));
    directories.add(root);
    git(root, "init");
    git(root, "config", "user.email", "test@example.com");
    git(root, "config", "user.name", "Test");
    writeFileSync(join(root, "base.txt"), "base\n");
    git(root, "add", ".");
    git(root, "commit", "-m", "chore: init");
    const client = new ExecGitClient(root);
    const baseSha = await client.head();
    const worktreesRoot = join(root, ".pi", "implement", "worktrees", "run-1");
    const candidatePath = join(worktreesRoot, "work");
    await client.createTaskBranch("pi-implement/run-1/work", baseSha);
    await client.addWorktree(candidatePath, "pi-implement/run-1/work");
    writeFileSync(join(candidatePath, "candidate.txt"), "candidate\n");
    git(candidatePath, "add", ".");
    git(candidatePath, "commit", "-m", "feat: candidate");
    const candidateGit = client.forWorktree(candidatePath);
    const candidateSha = await candidateGit.head();
    const candidateId = `candidate:work:${candidateSha}`;
    const staging = stagingIdentity({
      runId: "run-1",
      candidateId,
      candidateCommitSha: candidateSha,
      targetBaseSha: baseSha,
    });
    const stagingPath = join(worktreesRoot, staging.id);
    await client.createTaskBranch(staging.branchName, baseSha);
    await client.addWorktree(stagingPath, staging.branchName);
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
      gates: [{ id: "hook:work:1", kind: "hook" }],
      recoveryEpisodes: {
        episode: {
          id: "episode",
          gateId: "hook:work:1",
          workstream: { kind: "source", id: "work" },
          candidateId,
          workspace: {
            id: staging.id,
            checkpoint: baseSha,
            changedPaths: [],
            stateEvidence: "hook changed tracked content",
          },
          actions: [],
        },
      },
      candidates: {
        [candidateId]: {
          id: candidateId,
          workstream: { kind: "source", id: "work" },
          baseSha,
          commitSha: candidateSha,
          treeSha: await candidateGit.treeAt(candidateSha),
        },
      },
      protectedArtifactHashes: {},
    } as unknown as RunState;
    let prompt = "";
    let correctedTip = "";

    const outcome = await runRecovery({
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
          prompt = args.prompt;
          return "recovery-agent" as never;
        },
        waitFor: async () => {
          writeFileSync(join(candidatePath, "correction.txt"), "corrected\n");
          git(candidatePath, "add", ".");
          git(candidatePath, "commit", "-m", "fix: correct candidate");
          correctedTip = await candidateGit.head();
          return {
            status: "completed" as const,
            result: {
              action: "rework_candidate" as const,
              summary: "Corrected the hook failure.",
              evidence: "Committed the tracked correction.",
              candidateTip: correctedTip,
              changedPaths: ["correction.txt"],
            },
          } as never;
        },
      },
      artifactsPath: join(root, ".pi", "implement", "artifacts"),
      roles: { type: "recovery-role" },
    });

    expect(prompt).toContain(stagingPath);
    expect(prompt).toContain(candidatePath);
    expect(outcome).toMatchObject({
      candidate: { commitSha: correctedTip },
      correction: { changedPaths: ["correction.txt"] },
    });
  });
});
