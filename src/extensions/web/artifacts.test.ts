import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import { ArtifactStore, ARTIFACT_LIMITS } from "./artifacts.js";
import { DeadlineError } from "./errors.js";
import { createInvocationDeadline } from "./transport.js";

function response(
  url: string,
  body: BodyInit,
  headers: Record<string, string> = {},
): Response {
  const value = new Response(body, { headers });
  Object.defineProperty(value, "url", { value: url });
  return value;
}

describe("web artifacts", () => {
  it("uses private modes, safe names, exclusive creation, and removes its session directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "pipkin-web-test-"));
    const artifacts = new ArtifactStore({ temporaryRoot: root });
    const deadline = createInvocationDeadline();
    try {
      const hostile = await artifacts.write(
        response("https://example.com/%2fescape", "safe", {
          "content-disposition": 'attachment; filename="../../escape"',
        }),
        { kind: "binary", maximumBytes: ARTIFACT_LIMITS.binaryBytes, deadline },
      );
      const named = await artifacts.write(
        response("https://example.com/report.pdf", "safe", {
          "content-disposition": 'attachment; filename="report.pdf"',
        }),
        { kind: "binary", maximumBytes: ARTIFACT_LIMITS.binaryBytes, deadline },
      );

      const [directory] = await readdir(root);
      expect(basename(hostile.path)).toMatch(/^artifact-[\da-f-]+\.bin$/u);
      expect(named.path).toMatch(/report\.pdf$/u);
      expect((await stat(join(root, directory!))).mode & 0o777).toBe(0o700);
      expect((await stat(named.path)).mode & 0o777).toBe(0o600);
      const initialBytes = await readFile(named.path);
      await expect(
        artifacts.write(
          response("https://example.com/report.pdf", "other", {
            "content-disposition": 'attachment; filename="report.pdf"',
          }),
          {
            kind: "binary",
            maximumBytes: ARTIFACT_LIMITS.binaryBytes,
            deadline,
          },
        ),
      ).rejects.toThrow("could not create a temporary artifact");
      await expect(readFile(named.path)).resolves.toEqual(initialBytes);
    } finally {
      deadline.dispose();
      await artifacts.dispose();
      await expect(readdir(root)).resolves.toEqual([]);
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a deadline during an active artifact stream without retaining a partial file", async () => {
    const root = await mkdtemp(join(tmpdir(), "pipkin-web-test-"));
    const artifacts = new ArtifactStore({ temporaryRoot: root });
    const controller = new AbortController();
    const deadline = {
      signal: controller.signal,
      remaining: () => 1_000,
      dispose: () => {},
    };
    let pulled!: () => void;
    const stream = new ReadableStream<Uint8Array>({
      pull() {
        pulled();
      },
    });
    const started = new Promise<void>((resolve) => {
      pulled = resolve;
    });
    try {
      const pending = artifacts.write(
        response("https://example.com/raw", stream),
        {
          kind: "raw-text",
          maximumBytes: ARTIFACT_LIMITS.rawBytes,
          deadline,
        },
      );
      await started;
      controller.abort(new DeadlineError());
      await expect(pending).rejects.toBeInstanceOf(DeadlineError);
      await expect(pending).rejects.toThrow(
        "Web Fetch timed out before the request could complete.",
      );
      const [directory] = await readdir(root);
      expect(directory).toBeDefined();
      await expect(readdir(join(root, directory!))).resolves.toEqual([]);
    } finally {
      await artifacts.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("bounds remote artifact metadata and cleans setup failures", async () => {
    const root = await mkdtemp(join(tmpdir(), "pipkin-web-test-"));
    const artifacts = new ArtifactStore({ temporaryRoot: root });
    const deadline = createInvocationDeadline();
    try {
      const artifact = await artifacts.write(
        response("https://example.com/%2fescape", "content", {
          "content-type": `text/${"x".repeat(2_000)}`,
          "content-disposition": `attachment; filename="${"x".repeat(2_000)}"`,
        }),
        {
          kind: "binary",
          maximumBytes: ARTIFACT_LIMITS.binaryBytes,
          deadline,
        },
      );
      expect(artifact.contentType.length).toBeLessThanOrEqual(512);
      expect(artifact.name).toMatch(/^artifact-[\da-f-]+\.bin$/u);
    } finally {
      deadline.dispose();
      await artifacts.dispose();
      await rm(root, { recursive: true, force: true });
    }

    const setupRoot = await mkdtemp(join(tmpdir(), "pipkin-web-test-"));
    const failing = new ArtifactStore({
      temporaryRoot: setupRoot,
      setDirectoryMode: async () => {
        throw new Error("host failure");
      },
    });
    const failureDeadline = createInvocationDeadline();
    try {
      await expect(
        failing.write(response("https://example.com/file", "content"), {
          kind: "binary",
          maximumBytes: ARTIFACT_LIMITS.binaryBytes,
          deadline: failureDeadline,
        }),
      ).rejects.toThrow("could not create its temporary artifact directory");
      await expect(readdir(setupRoot)).resolves.toEqual([]);
    } finally {
      failureDeadline.dispose();
      await failing.dispose();
      await rm(setupRoot, { recursive: true, force: true });
    }
  });

  it("removes an over-limit partial artifact despite a dishonest Content-Length", async () => {
    const root = await mkdtemp(join(tmpdir(), "pipkin-web-test-"));
    const artifacts = new ArtifactStore({ temporaryRoot: root });
    const deadline = createInvocationDeadline();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(ARTIFACT_LIMITS.rawBytes + 1));
        controller.close();
      },
    });
    try {
      await expect(
        artifacts.write(
          response("https://example.com/raw", stream, {
            "content-length": "1",
            "content-type": "text/plain",
          }),
          {
            kind: "raw-text",
            maximumBytes: ARTIFACT_LIMITS.rawBytes,
            maximumPreviewChars: 10,
            deadline,
          },
        ),
      ).rejects.toThrow("5 MiB");
      const [directory] = await readdir(root);
      expect(directory).toBeDefined();
      await expect(readdir(join(root, directory!))).resolves.toEqual([]);
    } finally {
      deadline.dispose();
      await artifacts.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });
});
