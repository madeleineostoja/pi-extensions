import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { FilesystemGrant, FixedCapabilities } from "../capabilities.js";

export type NonoManifestGrant = Readonly<{
  path: string;
  access: "read" | "write" | "readwrite";
  type: "file" | "directory";
}>;
export type NonoManifest = Readonly<{
  version: "0.1.0";
  filesystem: { grants: NonoManifestGrant[] };
  network: { mode: "unrestricted" };
}>;

function manifestGrants(
  grants: readonly FilesystemGrant[],
): NonoManifestGrant[] {
  const modes = new Map<string, Set<"read" | "write">>();
  for (const grant of grants) {
    const key = `${grant.kind}\0${grant.path}`;
    const entry = modes.get(key) ?? new Set<"read" | "write">();
    entry.add(grant.access);
    modes.set(key, entry);
  }
  return [...modes].map(([key, access]) => {
    const [type, path] = key.split("\0") as ["file" | "directory", string];
    return {
      path,
      type,
      access:
        access.size === 2 ? "readwrite" : access.has("read") ? "read" : "write",
    };
  });
}

export function buildNonoManifest(
  fixed: FixedCapabilities,
  activeGrants: readonly FilesystemGrant[],
): NonoManifest {
  return {
    version: "0.1.0",
    filesystem: {
      grants: manifestGrants([
        ...fixed.grants,
        ...activeGrants.filter((grant) =>
          grant.effects.includes("outside-boundary"),
        ),
      ]),
    },
    network: { mode: "unrestricted" },
  };
}

export type NonoManifestFile = Readonly<{
  path: string;
  cleanup: () => void;
}>;

export function writeNonoManifest(manifest: NonoManifest): NonoManifestFile {
  const directory = mkdtempSync(join(tmpdir(), "pipkin-nono-run-"));
  const path = join(directory, "pipkin-nono-manifest.json");
  writeFileSync(path, JSON.stringify(manifest), { mode: 0o600 });
  let removed = false;
  return {
    path,
    cleanup() {
      if (!removed) {
        removed = true;
        rmSync(directory, { recursive: true, force: true });
      }
    },
  };
}

export function runNono(
  binary: string,
  manifest: NonoManifestFile,
  command: string,
  args: readonly string[],
): ReturnType<typeof execFile> {
  return execFile(
    resolve(binary),
    ["run", "--config", manifest.path, "--", command, ...args],
    (error) => {
      manifest.cleanup();
      if (error) {
        return;
      }
    },
  );
}
