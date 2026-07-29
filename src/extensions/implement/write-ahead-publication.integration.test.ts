import { execFileSync } from "node:child_process";
import { ensureGitInfoExclude } from "#lib/git";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ExecGitClient } from "./git.js";
import { WriteAheadPublisher } from "./write-ahead-publication.js";

const temporaryDirectories = new Set<string>();

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pipkin-implement-publication-"));
  temporaryDirectories.add(root);
  git(root, "init", "-q");
  git(root, "config", "user.email", "test@example.com");
  git(root, "config", "user.name", "Test");
  writeFileSync(join(root, "app.txt"), "base\n");
  writeFileSync(join(root, "plan.md"), "plan draft\n");
  git(root, "add", ".");
  git(root, "commit", "-m", "chore: init");
  const client = new ExecGitClient(root);
  const base = await client.head();
  const branch = "pipkin/implement/prepared";
  const staging = join(root, ".pi", "staging");
  await ensureGitInfoExclude(root, ".pi/");
  await client.createTaskBranch(branch, base);
  await client.addWorktree(staging, branch);
  const stagingGit = client.forWorktree(staging);
  writeFileSync(join(staging, "app.txt"), "prepared\n");
  git(staging, "add", "-A");
  await stagingGit.checkpoint("feat: prepared", false);
  const prepared = await stagingGit.head();
  const tree = await stagingGit.treeAt(prepared);
  const targetRef = `refs/heads/${await client.currentBranch()}`;
  writeFileSync(join(root, "plan.md"), "operator draft\n");
  return { root, client, base, prepared, tree, targetRef };
}

afterEach(() => {
  for (const directory of temporaryDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
  temporaryDirectories.clear();
});

describe("WriteAheadPublisher", () => {
  it("publishes with a ref compare-and-swap and restores sanctioned plan dirtiness", async () => {
    const setup = await fixture();
    const publisher = new WriteAheadPublisher({
      git: setup.client,
      checkoutRoot: setup.root,
      checkoutIdentity: await setup.client.checkoutIdentity(),
      protectedPaths: [join(setup.root, "plan.md")],
    });
    const intent = publisher.createIntent({
      id: "intent-1",
      candidateId: "candidate-1",
      targetBaseSha: setup.base,
      preparedCommitSha: setup.prepared,
      preparedTreeSha: setup.tree,
      targetRef: setup.targetRef,
    });

    const result = await publisher.publish(intent);

    expect(result).toMatchObject({
      kind: "published",
      receipt: { publishedCommitSha: setup.prepared },
    });
    expect(await setup.client.head()).toBe(setup.prepared);
    expect(git(setup.root, "show", "HEAD:app.txt")).toBe("prepared");
    expect(git(setup.root, "diff", "--", "plan.md")).toContain(
      "operator draft",
    );
  });

  it("recovers a crash after ref update without publishing twice", async () => {
    const setup = await fixture();
    const crashing = new WriteAheadPublisher({
      git: setup.client,
      checkoutRoot: setup.root,
      checkoutIdentity: await setup.client.checkoutIdentity(),
      protectedPaths: [join(setup.root, "plan.md")],
      hooks: {
        afterRefUpdate: () => {
          throw new Error("crash");
        },
      },
    });
    const intent = crashing.createIntent({
      id: "intent-1",
      candidateId: "candidate-1",
      targetBaseSha: setup.base,
      preparedCommitSha: setup.prepared,
      preparedTreeSha: setup.tree,
      targetRef: setup.targetRef,
    });

    await expect(crashing.publish(intent)).rejects.toThrow("crash");
    const recovered = await new WriteAheadPublisher({
      git: setup.client,
      checkoutRoot: setup.root,
      checkoutIdentity: await setup.client.checkoutIdentity(),
      protectedPaths: [join(setup.root, "plan.md")],
    }).recover(intent);

    expect(recovered).toMatchObject({
      kind: "published",
      receipt: { publishedCommitSha: setup.prepared },
    });
    expect(await setup.client.head()).toBe(setup.prepared);
  });

  it("restores the base and sanctioned artifacts when settling before ref update", async () => {
    const setup = await fixture();
    const publisher = new WriteAheadPublisher({
      git: setup.client,
      checkoutRoot: setup.root,
      checkoutIdentity: await setup.client.checkoutIdentity(),
      protectedPaths: [join(setup.root, "plan.md")],
    });
    const intent = publisher.createIntent({
      id: "intent-1",
      candidateId: "candidate-1",
      targetBaseSha: setup.base,
      preparedCommitSha: setup.prepared,
      preparedTreeSha: setup.tree,
      targetRef: setup.targetRef,
    });
    writeFileSync(join(setup.root, "plan.md"), "partially restored\n");

    const result = await publisher.recover(intent);

    expect(result).toEqual({ kind: "retry_from_base" });
    expect(await setup.client.head()).toBe(setup.base);
    expect(git(setup.root, "diff", "--", "plan.md")).toContain(
      "operator draft",
    );
  });

  it("refuses publication when protected artifacts change after the intent", async () => {
    const setup = await fixture();
    const publisher = new WriteAheadPublisher({
      git: setup.client,
      checkoutRoot: setup.root,
      checkoutIdentity: await setup.client.checkoutIdentity(),
      protectedPaths: [join(setup.root, "plan.md")],
    });
    const intent = publisher.createIntent({
      id: "intent-1",
      candidateId: "candidate-1",
      targetBaseSha: setup.base,
      preparedCommitSha: setup.prepared,
      preparedTreeSha: setup.tree,
      targetRef: setup.targetRef,
    });
    writeFileSync(join(setup.root, "plan.md"), "unproven change\n");

    expect(await publisher.publish(intent)).toMatchObject({
      kind: "safety_paused",
      reason: expect.stringMatching(/Protected artifacts changed/),
    });
    expect(await setup.client.head()).toBe(setup.base);
  });

  it("does not overwrite target movement before the compare-and-swap", async () => {
    const setup = await fixture();
    const publisher = new WriteAheadPublisher({
      git: setup.client,
      checkoutRoot: setup.root,
      checkoutIdentity: await setup.client.checkoutIdentity(),
      protectedPaths: [join(setup.root, "plan.md")],
    });
    const intent = publisher.createIntent({
      id: "intent-1",
      candidateId: "candidate-1",
      targetBaseSha: setup.base,
      preparedCommitSha: setup.prepared,
      preparedTreeSha: setup.tree,
      targetRef: setup.targetRef,
    });
    writeFileSync(join(setup.root, "other.txt"), "moved\n");
    git(setup.root, "add", "other.txt");
    git(setup.root, "commit", "-m", "feat: move target");
    const moved = await setup.client.head();

    const result = await publisher.publish(intent);

    expect(result).toEqual({
      kind: "target_moved",
      expected: setup.base,
      actual: moved,
    });
    expect(await setup.client.head()).toBe(moved);
  });
});
