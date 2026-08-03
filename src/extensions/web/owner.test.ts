import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { ArtifactStore, ARTIFACT_LIMITS } from "./artifacts.js";
import { WebFetchOwner } from "./owner.js";
import { createInvocationDeadline } from "./transport.js";

describe("WebFetchOwner", () => {
  it("removes completed artifacts idempotently at session shutdown", async () => {
    const root = await mkdtemp(join(tmpdir(), "pipkin-web-test-"));
    const owner = new WebFetchOwner(new ArtifactStore({ temporaryRoot: root }));
    const deadline = createInvocationDeadline();
    try {
      const response = new Response("temporary", {
        headers: { "content-type": "text/plain" },
      });
      Object.defineProperty(response, "url", {
        value: "https://example.com/temporary",
      });
      const artifact = await owner.artifacts.write(response, {
        kind: "raw-text",
        maximumBytes: ARTIFACT_LIMITS.rawBytes,
        maximumPreviewChars: 10,
        deadline,
      });

      await owner.shutdown();
      await owner.shutdown();
      await expect(access(artifact.path)).rejects.toThrow();

      const replacement = new WebFetchOwner(
        new ArtifactStore({ temporaryRoot: root }),
      );
      const next = new Response("fresh", {
        headers: { "content-type": "text/plain" },
      });
      Object.defineProperty(next, "url", {
        value: "https://example.com/fresh",
      });
      const fresh = await replacement.artifacts.write(next, {
        kind: "raw-text",
        maximumBytes: ARTIFACT_LIMITS.rawBytes,
        maximumPreviewChars: 10,
        deadline,
      });
      expect(dirname(fresh.path)).not.toBe(dirname(artifact.path));
      await replacement.shutdown();
    } finally {
      deadline.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });
});
