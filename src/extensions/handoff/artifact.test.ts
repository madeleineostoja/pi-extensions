import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { createChildArtifact } from "./artifact";
import { DRAFT_TYPE, type DraftData } from "./state";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true })),
  );
});

describe("child artifact", () => {
  it("reopens its atomic header and entries through SessionManager", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pipkin-handoff-"));
    directories.push(directory);
    const parentPath = join(directory, "parent.jsonl");
    const draft: DraftData = {
      version: 1,
      transitionId: "transition",
      source: { provider: "source", id: "one" },
      target: { provider: "target", id: "two" },
      prompt: "Continue the task.",
    };

    const child = await createChildArtifact({
      cwd: directory,
      sessionDir: directory,
      parentPath,
      target: draft.target,
      draft,
    });

    const reopened = SessionManager.open(child.path, directory);
    expect(reopened.getHeader()).toMatchObject({
      cwd: directory,
      parentSession: parentPath,
    });
    expect(reopened.getEntries()).toEqual([
      expect.objectContaining({
        type: "model_change",
        provider: "target",
        modelId: "two",
      }),
      expect.objectContaining({
        id: child.draftEntryId,
        type: "custom",
        customType: DRAFT_TYPE,
        data: draft,
      }),
    ]);
  });
});
