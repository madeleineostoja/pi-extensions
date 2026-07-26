import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runRecovery } from "./recovery-service.js";
import type { SpawnArgs } from "./subagents.js";
import type { RunState } from "./store.js";

const directories = new Set<string>();

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
        probe: async () => ({ ok: true }),
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
});
