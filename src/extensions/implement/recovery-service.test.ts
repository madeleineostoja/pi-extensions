import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runRecovery } from "./recovery-service.js";
import type { ImplementRoles, SpawnArgs } from "./subagents.js";
import type { RunState } from "./store.js";

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

afterEach(() => {
  for (const directory of directories) {
    rmSync(directory, { force: true, recursive: true });
  }
  directories.clear();
});

describe("recovery service packets", () => {
  it("launches the configured recovery role with the retained episode", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pipkin-implement-recovery-"));
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
          workstream: { kind: "source", id: "work" },
          attempt: 1,
          outcome: "failed",
          evidence: "pre-commit rejected",
          outstandingFindingIds: [],
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
          gateAttempts: ["hook:work:1"],
          workstream: { kind: "source", id: "work" },
          workspace: {
            id: "staging-test",
            changedPaths: [],
            stateEvidence: "provider disconnected",
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
            action: "retry" as const,
            summary: "Restored ignored dependencies.",
            evidence: "npm install completed in the owned worktree.",
          },
        }),
      } as never,
      artifactsPath: directory,
      roles: recoveryRoles(),
    });

    expect(outcome.action).toMatchObject({
      kind: "retry",
      outcome: "completed",
    });
    expect(spawned).toHaveLength(1);
    expect(spawned[0]).toMatchObject({
      type: "pipkin:implement:recovery",
      role: "recovery",
      model: "test/medium",
      thinking: "medium",
    });
    expect(spawned[0]).toMatchObject({
      cwd: join(
        directory,
        ".pi",
        "pipkin",
        "implement",
        "worktrees",
        "run-1",
        "work",
      ),
    });
    expect(String(spawned[0]?.prompt)).toContain("pre-commit rejected");
  });

  it("embeds current findings when review provenance is outside the recovery workspace", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pipkin-implement-recovery-"));
    directories.add(directory);
    const artifactPath = "/unreadable/review-evidence.json";
    const candidateId = "candidate:work:tip";
    let prompt = "";

    const outcome = await runRecovery({
      state: {
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
            work: {
              kind: "source",
              id: "work",
              baseSha: "base-sha",
              candidateId,
            },
          },
          overall: {},
        },
        gates: [
          {
            id: "review:work:1",
            kind: "review",
            workstream: { kind: "source", id: "work" },
            candidateId,
            attempt: 1,
            outcome: "failed",
            evidence: artifactPath,
            outstandingFindingIds: ["finding-1"],
          },
        ],
        recoveryEpisodes: {
          episode: {
            id: "episode",
            gateId: "review:work:1",
            gateAttempts: ["review:work:1"],
            workstream: { kind: "source", id: "work" },
            candidateId,
            workspace: {
              id: "source:work",
              checkpoint: "tip",
              changedPaths: [],
              stateEvidence: "Review requested a correction.",
            },
            outstandingFindingIds: ["finding-1"],
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
        reviews: {
          "source:work": {
            candidateId,
            round: 1,
            outstandingIds: ["finding-1"],
            evidence: [artifactPath],
            observations: [],
          },
        },
        candidates: {
          [candidateId]: {
            id: candidateId,
            workstream: { kind: "source", id: "work" },
            baseSha: "base-sha",
            commitSha: "tip",
            treeSha: "tree",
          },
        },
        findings: {
          "finding-1": {
            id: "finding-1",
            candidateId,
            workstream: { kind: "source", id: "work" },
            summary: "Missing handler",
            evidence: "The route returns 404.",
            requiredChange: "Add the handler.",
            acceptanceCriteria: ["The route returns 200."],
            origin: "initial",
            introducedRound: 0,
            status: "open",
          },
        },
        protectedArtifactHashes: {},
      } as unknown as RunState,
      effect: {
        kind: "run_recovery",
        workstream: { kind: "source", id: "work" },
        leaseId: "lease",
        episodeId: "episode",
        independentlyEscalated: false,
      },
      git: {
        forWorktree: () => ({
          currentBranch: async () => "pipkin/implement/run-1/work",
          head: async () => "tip",
          isClean: async () => true,
          activeOperation: async () => undefined,
        }),
      } as never,
      subagents: {
        stop: async () => undefined,
        spawn: async (args: SpawnArgs) => {
          prompt = args.prompt;
          return "recovery-agent" as never;
        },
        waitFor: async () => {
          expect(() => readFileSync(artifactPath, "utf-8")).toThrow();
          if (
            ![
              "Missing handler",
              "The route returns 404.",
              "Add the handler.",
              "The route returns 200.",
            ].every((evidence) => prompt.includes(evidence))
          ) {
            throw new Error("The recovery packet omitted actionable evidence.");
          }
          return {
            status: "completed" as const,
            result: {
              action: "diagnose" as const,
              summary: "The correction can proceed.",
              evidence: "The inline finding identifies the missing handler.",
            },
          };
        },
      } as never,
      artifactsPath: directory,
      roles: recoveryRoles(),
    });

    expect(outcome.action.kind).toBe("diagnose");
    expect(prompt).toContain("Missing handler");
    expect(prompt).toContain("The route returns 404.");
    expect(prompt).toContain("Add the handler.");
    expect(prompt).toContain("The route returns 200.");
    expect(prompt).toContain(artifactPath);
    expect(prompt).toContain("not readable from the assigned workspace");
  });
});
