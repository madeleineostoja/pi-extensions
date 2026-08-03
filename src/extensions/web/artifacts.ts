import { constants } from "node:fs";
import { chmod, mkdtemp, open, realpath, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { randomUUID } from "node:crypto";
import { assertActive, type Deadline } from "./cancellation.js";
import { LIMITS } from "./constants.js";
import { abortReason, DeadlineError, WebError } from "./errors.js";

export type Artifact = {
  path: string;
  bytes: number;
  contentType: string;
  name: string;
  kind: "raw-text" | "binary";
  preview?: string;
  previewTruncated?: boolean;
};

type ArtifactStoreDependencies = {
  temporaryRoot?: string;
  setDirectoryMode?: (path: string, mode: number) => Promise<void>;
  resolveDirectory?: (path: string) => Promise<string>;
};

export class ArtifactStore {
  #directory: Promise<string> | undefined;
  #createdDirectory: string | undefined;
  #active = new Map<string, Awaited<ReturnType<typeof open>>>();
  #completed = new Set<string>();
  #disposed = false;

  constructor(private readonly dependencies: ArtifactStoreDependencies = {}) {}

  async write(
    response: Response,
    options: {
      kind: Artifact["kind"];
      maximumBytes: number;
      maximumPreviewChars?: number;
      signal?: AbortSignal;
      deadline: Deadline;
    },
  ): Promise<Artifact> {
    if (this.#disposed) {
      throw new WebError(
        "artifact",
        "Web Fetch artifacts are no longer available.",
      );
    }
    const contentType = artifactContentType(
      response.headers.get("content-type"),
    );
    const contentLength = parseContentLength(
      response.headers.get("content-length"),
    );
    if (contentLength !== undefined && contentLength > options.maximumBytes) {
      await response.body?.cancel().catch(() => {});
      throw oversize(options.kind);
    }
    const directory = await this.#ensureDirectory();
    assertActive(options.deadline, options.signal);
    const name = artifactName(
      response.headers.get("content-disposition"),
      response.url,
      options.kind,
    );
    const path = join(directory, name);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let created = false;
    let completed = false;
    let bytes = 0;
    let preview = "";
    let previewTruncated = false;
    const decoder = options.kind === "raw-text" ? new TextDecoder() : undefined;
    try {
      try {
        handle = await open(
          path,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
          0o600,
        );
        created = true;
      } catch {
        throw new WebError(
          "artifact",
          "Web Fetch could not create a temporary artifact.",
        );
      }
      this.#active.set(path, handle);
      if (response.body) {
        reader = response.body.getReader();
        const onAbort = () =>
          void reader?.cancel(
            options.signal?.reason ?? options.deadline.signal.reason,
          );
        options.signal?.addEventListener("abort", onAbort, { once: true });
        options.deadline.signal.addEventListener("abort", onAbort, {
          once: true,
        });
        try {
          while (true) {
            assertActive(options.deadline, options.signal);
            const next = await reader.read();
            assertActive(options.deadline, options.signal);
            if (next.done) {
              break;
            }
            bytes += next.value.byteLength;
            if (bytes > options.maximumBytes) {
              await reader.cancel().catch(() => {});
              throw oversize(options.kind);
            }
            await writeAll(handle, next.value);
            if (decoder) {
              const appended = appendPreview(
                preview,
                decoder.decode(next.value, { stream: true }),
                options.maximumPreviewChars ?? 0,
              );
              preview = appended.value;
              previewTruncated ||= appended.truncated;
            }
          }
          if (decoder) {
            const appended = appendPreview(
              preview,
              decoder.decode(),
              options.maximumPreviewChars ?? 0,
            );
            preview = appended.value;
            previewTruncated ||= appended.truncated;
          }
        } finally {
          options.signal?.removeEventListener("abort", onAbort);
          options.deadline.signal.removeEventListener("abort", onAbort);
          reader.releaseLock();
        }
      }
      assertActive(options.deadline, options.signal);
      await handle.close();
      this.#active.delete(path);
      this.#completed.add(path);
      completed = true;
      return {
        path,
        bytes,
        contentType,
        name,
        kind: options.kind,
        ...(decoder ? { preview, previewTruncated } : {}),
      };
    } catch (error) {
      await reader?.cancel().catch(() => {});
      if (options.signal?.aborted) {
        throw abortReason(options.signal);
      }
      if (options.deadline.signal.aborted) {
        throw abortReason(options.deadline.signal);
      }
      if (error instanceof DeadlineError || error instanceof WebError) {
        throw error;
      }
      throw new WebError(
        "artifact",
        "Web Fetch could not save the temporary artifact.",
      );
    } finally {
      this.#active.delete(path);
      await handle?.close().catch(() => {});
      if (created && !completed) {
        await unlink(path).catch(() => {});
      }
    }
  }

  async dispose(): Promise<void> {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    const active = [...this.#active.entries()];
    this.#active.clear();
    await Promise.all(
      active.map(async ([path, handle]) => {
        await handle.close().catch(() => {});
        await unlink(path).catch(() => {});
      }),
    );
    this.#completed.clear();
    const directory =
      (await this.#directory?.catch(() => undefined)) ?? this.#createdDirectory;
    if (directory) {
      await rm(directory, { recursive: true, force: true }).catch(() => {});
    }
  }

  async #ensureDirectory(): Promise<string> {
    if (!this.#directory) {
      this.#directory = (async () => {
        let created: string | undefined;
        try {
          created = await mkdtemp(
            join(this.dependencies.temporaryRoot ?? tmpdir(), "pipkin-web-"),
          );
          this.#createdDirectory = created;
          await (this.dependencies.setDirectoryMode ?? chmod)(created, 0o700);
          const directory = await (
            this.dependencies.resolveDirectory ?? realpath
          )(created);
          this.#createdDirectory = directory;
          return directory;
        } catch {
          if (created) {
            await rm(created, { recursive: true, force: true }).catch(() => {});
          }
          this.#createdDirectory = undefined;
          throw new WebError(
            "artifact",
            "Web Fetch could not create its temporary artifact directory.",
          );
        }
      })();
    }
    try {
      return await this.#directory;
    } catch {
      throw new WebError(
        "artifact",
        "Web Fetch could not create its temporary artifact directory.",
      );
    }
  }
}

function artifactContentType(value: string | null): string {
  const token = boundedHeader(value)?.split(";", 1)[0]?.trim().toLowerCase();
  return token || "unknown";
}

function parseContentLength(value: string | null): number | undefined {
  return value && /^\d+$/u.test(value) ? Number(value) : undefined;
}

function oversize(kind: Artifact["kind"]): WebError {
  return new WebError(
    "oversize",
    kind === "raw-text"
      ? "Web Fetch raw response exceeds its 5 MiB text limit."
      : "Web Fetch artifact exceeds its 25 MiB binary limit.",
  );
}

function artifactName(
  disposition: string | null,
  url: string,
  kind: Artifact["kind"],
): string {
  const suggestion =
    safeName(dispositionName(disposition)) ?? safeName(urlName(url));
  return (
    suggestion ??
    `artifact-${randomUUID()}${kind === "raw-text" ? ".txt" : ".bin"}`
  );
}

function dispositionName(value: string | null): string | undefined {
  const header = boundedHeader(value);
  if (!header) {
    return undefined;
  }
  const encoded = /(?:^|;)\s*filename\*\s*=\s*([^;]+)/iu.exec(header)?.[1];
  const plain = /(?:^|;)\s*filename\s*=\s*(?:"([^"]*)"|([^;]*))/iu.exec(header);
  const candidate = encoded ?? plain?.[1] ?? plain?.[2];
  if (!candidate) {
    return undefined;
  }
  try {
    const parts = candidate.trim().replace(/^"|"$/gu, "").split("''", 2);
    return encoded ? decodeURIComponent(parts.at(-1)!) : candidate.trim();
  } catch {
    return undefined;
  }
}

function urlName(value: string): string | undefined {
  try {
    const name = new URL(value).pathname.split("/").at(-1) ?? "";
    return decodeURIComponent(name.slice(0, LIMITS.metadataChars));
  } catch {
    return undefined;
  }
}

function boundedHeader(value: string | null): string | undefined {
  return value?.slice(0, LIMITS.metadataChars);
}

function safeName(value: string | undefined): string | undefined {
  if (
    !value ||
    value.length > 100 ||
    /[\\/]/u.test(value) ||
    hasControlText(value)
  ) {
    return undefined;
  }
  const name = basename(value).trim();
  if (
    !name ||
    name.startsWith(".") ||
    /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu.test(name)
  ) {
    return undefined;
  }
  return name;
}

function hasControlText(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0)!;
    return code < 32 || code === 127;
  });
}

async function writeAll(
  handle: Awaited<ReturnType<typeof open>>,
  value: Uint8Array,
): Promise<void> {
  let offset = 0;
  while (offset < value.byteLength) {
    const result = await handle.write(value, offset);
    if (result.bytesWritten <= 0) {
      throw new Error("short write");
    }
    offset += result.bytesWritten;
  }
}

function appendPreview(
  value: string,
  addition: string,
  maximum: number,
): { value: string; truncated: boolean } {
  const characters = Array.from(addition);
  if (maximum <= 0) {
    return { value: "", truncated: characters.length > 0 };
  }
  const remaining = maximum - Array.from(value).length;
  return remaining > 0
    ? {
        value: `${value}${characters.slice(0, remaining).join("")}`,
        truncated: characters.length > remaining,
      }
    : { value, truncated: characters.length > 0 };
}

export const ARTIFACT_LIMITS = {
  rawBytes: LIMITS.responseBytes,
  binaryBytes: 25 * 1024 * 1024,
} as const;
