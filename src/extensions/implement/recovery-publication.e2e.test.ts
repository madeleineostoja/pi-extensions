import { execFileSync } from "node:child_process";
import { ensureGitInfoExclude } from "#lib/git";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ScriptedSubagentClient } from "./e2e-test-support.js";
import { ExecGitClient } from "./git.js";
import { WriteAheadPublisher } from "./write-ahead-publication.js";

const roots = new Set<string>();

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

afterEach(() => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
  roots.clear();
});

describe("recovery correction publication journey", () => {
  it("refuses artifact and target reads outside the assigned candidate root", () => {
    const candidate = "/workspace/candidate";
    const client = new ScriptedSubagentClient([], [candidate]);

    expect(() =>
      client.assertReadable("/workspace/candidate/src/app.ts"),
    ).not.toThrow();
    expect(() =>
      client.assertReadable("/workspace/artifacts/review.json"),
    ).toThrow("outside its assigned roots");
    expect(() => client.assertReadable("/workspace/target/app.ts")).toThrow(
      "outside its assigned roots",
    );
  });

  it("publishes a committed correction from an owned Pipkin branch", async () => {
    const root = mkdtempSync(join(tmpdir(), "pipkin-implement-e2e-"));
    roots.add(root);
    git(root, "init", "-q");
    git(root, "config", "user.email", "test@example.com");
    git(root, "config", "user.name", "Test");
    writeFileSync(join(root, "app.txt"), "base\n");
    writeFileSync(join(root, "plan.md"), "# Plan\n");
    git(root, "add", ".");
    git(root, "commit", "-m", "chore: init");
    await ensureGitInfoExclude(root, ".pi/");

    const target = new ExecGitClient(root);
    const base = await target.head();
    const branch = "pipkin/implement/run-1/work";
    const candidatePath = join(
      root,
      ".pi",
      "pipkin",
      "implement",
      "worktrees",
      "run-1",
      "work",
    );
    await target.createTaskBranch(branch, base);
    await target.addWorktree(candidatePath, branch);
    writeFileSync(join(candidatePath, "app.txt"), "candidate\n");
    git(candidatePath, "add", "app.txt");
    git(candidatePath, "commit", "-m", "feat: candidate");
    const candidate = target.forWorktree(candidatePath);
    const initialCandidate = await candidate.head();

    const artifact = join(
      root,
      ".pi",
      "pipkin",
      "implement",
      "artifacts",
      "review.json",
    );
    mkdirSync(join(artifact, ".."), { recursive: true });
    writeFileSync(artifact, "orchestrator-only evidence");
    expect(() =>
      execFileSync("test", ["!", "-e", join(candidatePath, "review.json")]),
    ).not.toThrow();

    writeFileSync(join(candidatePath, "app.txt"), "corrected\n");
    git(candidatePath, "add", "app.txt");
    git(candidatePath, "commit", "-m", "fix: address remaining finding");
    const corrected = await candidate.head();
    expect(await candidate.isAncestor(initialCandidate, corrected)).toBe(true);
    expect(await candidate.currentBranch()).toBe(branch);
    expect(await candidate.isClean()).toBe(true);

    const preparedBranch = "pipkin/implement/run-1/prepared";
    const preparedPath = join(
      root,
      ".pi",
      "pipkin",
      "implement",
      "worktrees",
      "run-1",
      "prepared",
    );
    await target.createTaskBranch(preparedBranch, base);
    await target.addWorktree(preparedPath, preparedBranch);
    writeFileSync(join(preparedPath, "app.txt"), "corrected\n");
    git(preparedPath, "add", "app.txt");
    git(preparedPath, "commit", "-m", "fix: prepare corrected publication");
    const preparedGit = target.forWorktree(preparedPath);
    const prepared = await preparedGit.head();

    const publisher = new WriteAheadPublisher({
      git: target,
      checkoutRoot: root,
      checkoutIdentity: await target.checkoutIdentity(),
      protectedPaths: [join(root, "plan.md")],
    });
    const intent = publisher.createIntent({
      id: "intent:run-1:work",
      candidateId: `candidate:work:${corrected}`,
      targetBaseSha: base,
      preparedCommitSha: prepared,
      preparedTreeSha: await preparedGit.treeAt(prepared),
      targetRef: `refs/heads/${await target.currentBranch()}`,
    });
    const published = await publisher.publish(intent);

    if (published.kind !== "published") {
      throw new Error(`Publication failed: ${JSON.stringify(published)}`);
    }
    expect(published).toMatchObject({
      kind: "published",
      receipt: {
        intentId: intent.id,
        candidateId: intent.candidateId,
        publishedCommitSha: prepared,
      },
    });
    expect(await target.head()).toBe(prepared);
    expect(git(root, "show", "HEAD:app.txt")).toBe("corrected");
    expect(git(candidatePath, "show", "HEAD:app.txt")).toBe("corrected");
  });
});
