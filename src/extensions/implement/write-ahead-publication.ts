import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { writeAtomicFile } from "./atomic-file.js";
import type { GitClient } from "./git.js";

export type WriteAheadPublicationIntent = {
  id: string;
  candidateId: string;
  targetBaseSha: string;
  preparedCommitSha: string;
  preparedTreeSha: string;
  targetRef: string;
  protectedArtifactSnapshots: Record<string, string>;
  protectedArtifactHashes: Record<string, string>;
};

export type PublicationReceipt = {
  intentId: string;
  candidateId: string;
  targetBaseSha: string;
  publishedCommitSha: string;
  publishedTreeSha: string;
  targetRef: string;
  protectedArtifactHashes: Record<string, string>;
  publishedAt: string;
};

export type PublicationOutcome =
  | { kind: "published"; receipt: PublicationReceipt }
  | { kind: "retry_from_base" }
  | { kind: "retryable"; reason: string }
  | { kind: "safety_paused"; reason: string }
  | { kind: "target_moved"; expected: string; actual: string };

export type WriteAheadPublicationOptions = {
  git: GitClient;
  checkoutRoot: string;
  checkoutIdentity: string;
  protectedPaths: string[];
  hooks?: {
    afterRefUpdate?: () => void;
    afterSynchronize?: () => void;
    afterRestore?: () => void;
  };
};

export class WriteAheadPublisher {
  constructor(private readonly options: WriteAheadPublicationOptions) {}

  createIntent(args: {
    id: string;
    candidateId: string;
    targetBaseSha: string;
    preparedCommitSha: string;
    preparedTreeSha: string;
    targetRef: string;
  }): WriteAheadPublicationIntent {
    const snapshots = this.captureProtectedArtifacts();
    return {
      ...args,
      protectedArtifactSnapshots: snapshots,
      protectedArtifactHashes: hashes(snapshots),
    };
  }

  async publish(
    intent: WriteAheadPublicationIntent,
  ): Promise<PublicationOutcome> {
    const preflight = await this.preflight(intent);
    if (preflight) {
      return preflight.kind === "target_moved"
        ? this.provenPreCasTargetMove(intent, preflight.actual)
        : preflight;
    }
    if (!this.options.git.updateRef) {
      return {
        kind: "safety_paused",
        reason: "Git client does not support atomic ref publication.",
      };
    }
    if (intent.preparedCommitSha === intent.targetBaseSha) {
      return this.finishPublished(intent);
    }
    const updated = await this.options.git.updateRef(
      intent.targetRef,
      intent.preparedCommitSha,
      intent.targetBaseSha,
    );
    if (updated.exitCode !== 0) {
      const actual = await this.options.git.head();
      return actual === intent.targetBaseSha
        ? {
            kind: "retryable",
            reason:
              "Atomic ref update failed while the target remained at its expected base.",
          }
        : actual === intent.preparedCommitSha
          ? await this.finishPublished(intent)
          : this.provenPreCasTargetMove(intent, actual);
    }
    this.options.hooks?.afterRefUpdate?.();
    return this.finishPublished(intent);
  }

  async recover(
    intent: WriteAheadPublicationIntent,
  ): Promise<PublicationOutcome> {
    const identity = await this.identityError(intent);
    if (identity) {
      return { kind: "safety_paused", reason: identity };
    }
    const [head, operation] = await Promise.all([
      this.options.git.head(),
      this.options.git.activeOperation(),
    ]);
    if (operation) {
      return {
        kind: "safety_paused",
        reason: `Target checkout has an active ${operation} operation.`,
      };
    }
    if (head === intent.targetBaseSha) {
      if (!(await this.isCleanForSynchronization())) {
        return {
          kind: "safety_paused",
          reason:
            "Target checkout is dirty outside sanctioned artifacts during recovery.",
        };
      }
      try {
        await this.synchronize(intent.targetBaseSha);
        this.restoreProtectedArtifacts(intent);
        return { kind: "retry_from_base" };
      } catch (error) {
        return { kind: "safety_paused", reason: message(error) };
      }
    }
    if (head === intent.preparedCommitSha) {
      return this.finishPublished(intent);
    }
    return {
      kind: "safety_paused",
      reason:
        "Target ref matches neither side of the durable publication intent.",
    };
  }

  private async provenPreCasTargetMove(
    intent: WriteAheadPublicationIntent,
    actual: string,
  ): Promise<PublicationOutcome> {
    try {
      const [
        head,
        identity,
        branch,
        operation,
        clean,
        protectedIndexDirty,
        descendant,
      ] = await Promise.all([
        this.options.git.head(),
        this.options.git.checkoutIdentity(),
        this.options.git.currentBranch(),
        this.options.git.activeOperation(),
        this.options.git.isCleanExcept([
          ...this.options.protectedPaths,
          join(this.options.checkoutRoot, ".pi", "pipkin", "implement"),
        ]),
        this.options.git.hasStagedChangesInPaths(this.options.protectedPaths),
        this.options.git.isAncestor(intent.targetBaseSha, actual),
      ]);
      if (
        head !== actual ||
        actual === intent.targetBaseSha ||
        actual === intent.preparedCommitSha ||
        identity !== this.options.checkoutIdentity ||
        `refs/heads/${branch}` !== intent.targetRef ||
        operation ||
        !clean ||
        protectedIndexDirty ||
        !descendant ||
        JSON.stringify(hashes(this.captureProtectedArtifacts())) !==
          JSON.stringify(intent.protectedArtifactHashes)
      ) {
        return {
          kind: "safety_paused",
          reason:
            "Target movement cannot be proved as a clean descendant before publication compare-and-swap.",
        };
      }
      return {
        kind: "target_moved",
        expected: intent.targetBaseSha,
        actual,
      };
    } catch (error) {
      return {
        kind: "safety_paused",
        reason: `Target movement could not be observed safely: ${message(error)}`,
      };
    }
  }

  private async finishPublished(
    intent: WriteAheadPublicationIntent,
  ): Promise<PublicationOutcome> {
    try {
      const [head, tree] = await Promise.all([
        this.options.git.head(),
        this.options.git.treeAt(intent.preparedCommitSha),
      ]);
      if (
        head !== intent.preparedCommitSha ||
        tree !== intent.preparedTreeSha
      ) {
        return {
          kind: "safety_paused",
          reason: "Published ref does not match the durable prepared identity.",
        };
      }
      await this.synchronize(intent.preparedCommitSha);
      this.options.hooks?.afterSynchronize?.();
      this.restoreProtectedArtifacts(intent);
      this.options.hooks?.afterRestore?.();
      const after = await this.preflight(intent, intent.preparedCommitSha);
      if (after) {
        return after.kind === "target_moved"
          ? {
              kind: "safety_paused",
              reason: "Target moved while synchronizing a published intent.",
            }
          : after;
      }
      return {
        kind: "published",
        receipt: {
          intentId: intent.id,
          candidateId: intent.candidateId,
          targetBaseSha: intent.targetBaseSha,
          publishedCommitSha: intent.preparedCommitSha,
          publishedTreeSha: intent.preparedTreeSha,
          targetRef: intent.targetRef,
          protectedArtifactHashes: intent.protectedArtifactHashes,
          publishedAt: new Date().toISOString(),
        },
      };
    } catch (error) {
      return { kind: "safety_paused", reason: message(error) };
    }
  }

  private async synchronize(expectedHead: string): Promise<void> {
    if (!this.options.git.synchronizeWorktree) {
      throw new Error(
        "Git client does not support ref-safe worktree synchronization.",
      );
    }
    await this.options.git.synchronizeWorktree(expectedHead);
    if ((await this.options.git.head()) !== expectedHead) {
      throw new Error("Target ref moved while synchronizing the checkout.");
    }
  }

  private async preflight(
    intent: WriteAheadPublicationIntent,
    expectedHead = intent.targetBaseSha,
  ): Promise<PublicationOutcome | undefined> {
    if (
      JSON.stringify(hashes(intent.protectedArtifactSnapshots)) !==
      JSON.stringify(intent.protectedArtifactHashes)
    ) {
      return {
        kind: "safety_paused",
        reason:
          "Protected artifact snapshots do not match their durable hashes.",
      };
    }
    if (
      JSON.stringify(hashes(this.captureProtectedArtifacts())) !==
      JSON.stringify(intent.protectedArtifactHashes)
    ) {
      return {
        kind: "safety_paused",
        reason:
          "Protected artifacts changed after publication intent persistence.",
      };
    }
    const identity = await this.identityError(intent);
    if (identity) {
      return { kind: "safety_paused", reason: identity };
    }
    const protectedPaths = this.options.protectedPaths;
    const [head, operation, clean, protectedIndexDirty, parent, tree] =
      await Promise.all([
        this.options.git.head(),
        this.options.git.activeOperation(),
        this.options.git.isCleanExcept([
          ...protectedPaths,
          join(this.options.checkoutRoot, ".pi", "pipkin", "implement"),
        ]),
        this.options.git.hasStagedChangesInPaths(protectedPaths),
        this.options.git.parent(intent.preparedCommitSha),
        this.options.git.treeAt(intent.preparedCommitSha),
      ]);
    if (head !== expectedHead) {
      return { kind: "target_moved", expected: expectedHead, actual: head };
    }
    if (operation) {
      return {
        kind: "safety_paused",
        reason: `Target checkout has an active ${operation} operation.`,
      };
    }
    if (!clean || protectedIndexDirty) {
      return {
        kind: "safety_paused",
        reason: "Target checkout is dirty outside sanctioned artifacts.",
      };
    }
    if (
      tree !== intent.preparedTreeSha ||
      (intent.preparedCommitSha !== intent.targetBaseSha &&
        parent !== intent.targetBaseSha)
    ) {
      return {
        kind: "safety_paused",
        reason:
          "Prepared commit does not exactly descend from the intended target base.",
      };
    }
    return undefined;
  }

  private async isCleanForSynchronization(): Promise<boolean> {
    const [clean, protectedIndexDirty] = await Promise.all([
      this.options.git.isCleanExcept([
        ...this.options.protectedPaths,
        join(this.options.checkoutRoot, ".pi", "pipkin", "implement"),
      ]),
      this.options.git.hasStagedChangesInPaths(this.options.protectedPaths),
    ]);
    return clean && !protectedIndexDirty;
  }

  private async identityError(
    intent: WriteAheadPublicationIntent,
  ): Promise<string | undefined> {
    const [identity, branch] = await Promise.all([
      this.options.git.checkoutIdentity(),
      this.options.git.currentBranch(),
    ]);
    if (identity !== this.options.checkoutIdentity) {
      return "Target checkout identity changed.";
    }
    if (`refs/heads/${branch}` !== intent.targetRef) {
      return "Target checkout branch changed.";
    }
    return undefined;
  }

  private captureProtectedArtifacts(): Record<string, string> {
    return Object.fromEntries(
      this.options.protectedPaths.map((path) => [
        path,
        readFileSync(this.assertProtectedPath(path), "utf-8"),
      ]),
    );
  }

  private restoreProtectedArtifacts(intent: WriteAheadPublicationIntent): void {
    const snapshots = intent.protectedArtifactSnapshots;
    if (
      JSON.stringify(hashes(snapshots)) !==
      JSON.stringify(intent.protectedArtifactHashes)
    ) {
      throw new Error("Protected artifact snapshot is malformed.");
    }
    for (const [path, content] of Object.entries(snapshots)) {
      const destination = this.assertProtectedPath(path);
      writeAtomicFile(destination, content);
    }
    if (
      JSON.stringify(hashes(this.captureProtectedArtifacts())) !==
      JSON.stringify(hashes(snapshots))
    ) {
      throw new Error("Protected artifact restoration could not be verified.");
    }
  }

  private assertProtectedPath(path: string): string {
    const root = resolve(this.options.checkoutRoot);
    const destination = resolve(path);
    const relativePath = relative(root, destination);
    if (
      !isAbsolute(path) ||
      relativePath === "" ||
      relativePath.startsWith("..")
    ) {
      throw new Error(
        `Protected artifact is not a regular checkout file: ${path}`,
      );
    }
    let current = root;
    for (const component of relativePath.split("/")) {
      current = join(current, component);
      if (!existsSync(current) || lstatSync(current).isSymbolicLink()) {
        throw new Error(
          `Protected artifact path is missing or symlinked: ${path}`,
        );
      }
    }
    return destination;
  }
}

function hashes(snapshots: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(snapshots)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([path, content]) => [
        path,
        createHash("sha256").update(content).digest("hex"),
      ]),
  );
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
