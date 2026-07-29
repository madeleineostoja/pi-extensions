import { lstatSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import {
  getAgentDir,
  getDocsPath,
  getExamplesPath,
  getPackageDir,
} from "@earendil-works/pi-coding-agent";

export type AccessMode = "read" | "write";
export type GrantKind = "file" | "directory";
export type GrantEffect = "outside-boundary" | "protected-read";
export type FilesystemGrant = Readonly<{
  path: string;
  access: AccessMode;
  kind: GrantKind;
  effects: readonly GrantEffect[];
}>;

export type FixedCapabilities = Readonly<{
  cwd: string;
  grants: readonly FilesystemGrant[];
}>;

function existingCanonical(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

export function canonicalizeTarget(path: string, cwd: string): string {
  const absolute = resolve(cwd, path);
  const existing = existingCanonical(absolute);
  if (existing) {
    return existing;
  }

  const missing: string[] = [];
  let ancestor = absolute;
  while (true) {
    const canonical = existingCanonical(ancestor);
    if (canonical) {
      return join(canonical, ...missing.reverse());
    }
    const parent = dirname(ancestor);
    if (parent === ancestor) {
      return absolute;
    }
    missing.push(basename(ancestor));
    ancestor = parent;
  }
}

function kindForExisting(path: string): GrantKind | null {
  try {
    return lstatSync(path).isDirectory() ? "directory" : "file";
  } catch {
    return null;
  }
}

function under(path: string, root: string): boolean {
  const result = relative(root, path);
  return result === "" || (!result.startsWith(`..${sep}`) && result !== "..");
}

export function grantMatches(
  grant: FilesystemGrant,
  target: string,
  access: AccessMode,
): boolean {
  return (
    grant.access === access &&
    (grant.kind === "file" ? grant.path === target : under(target, grant.path))
  );
}

export function hasGrant(
  grants: readonly FilesystemGrant[],
  target: string,
  access: AccessMode,
): boolean {
  return grants.some((grant) => grantMatches(grant, target, access));
}

function makeGrant(
  raw: string,
  access: AccessMode,
  kind: GrantKind,
): FilesystemGrant | null {
  const canonical = existingCanonical(raw);
  if (canonical === null) {
    return null;
  }
  const actualKind = kindForExisting(canonical);
  if (actualKind === null || actualKind !== kind) {
    return null;
  }
  return { path: canonical, access, kind, effects: [] };
}

function fixedRoots(cwd: string): Array<[string, AccessMode, GrantKind]> {
  const home = homedir();
  const xdgCache = process.env.XDG_CACHE_HOME;
  const npmCache = process.env.npm_config_cache ?? join(home, ".npm");
  const nodePrefix = dirname(
    dirname(canonicalizeTarget(process.execPath, cwd)),
  );
  const agent = getAgentDir();
  const grant = (
    path: string,
    access: AccessMode,
    kind: GrantKind,
  ): [string, AccessMode, GrantKind] => [path, access, kind];
  const readDirectories = (roots: string[]) =>
    roots.map((root) => grant(root, "read", "directory"));
  const readWriteDirectories = (roots: string[]) =>
    roots.flatMap((root) => [
      grant(root, "read", "directory"),
      grant(root, "write", "directory"),
    ]);
  return [
    ...readWriteDirectories([
      cwd,
      tmpdir(),
      "/tmp",
      "/private/tmp",
      ...(xdgCache ? [xdgCache] : []),
      npmCache,
    ]),
    ...readDirectories([
      "/bin",
      "/sbin",
      "/usr",
      "/System",
      "/Library/Developer",
      "/etc",
      "/private/etc",
      "/opt",
      "/private/var/db/dyld",
      "/var/db/dyld",
    ]),
    ...[
      "/dev/null",
      "/dev/tty",
      "/dev/stdout",
      "/dev/stderr",
      "/dev/fd/1",
      "/dev/fd/2",
    ].flatMap((root) => [
      grant(root, "read", "file"),
      grant(root, "write", "file"),
    ]),
    ...[
      "/dev/zero",
      "/dev/random",
      "/dev/urandom",
      "/dev/stdin",
      "/dev/fd/0",
    ].map((root) => grant(root, "read", "file")),
    grant("/dev/fd", "read", "directory"),
    ...readDirectories([
      "/nix/store",
      "/run/current-system/sw",
      "/etc/profiles/per-user",
      join(home, ".nix-profile"),
      join(home, ".local/state/nix/profile"),
      join(home, ".local/state/nix/profiles"),
      nodePrefix,
      getPackageDir(),
      getDocsPath(),
      getExamplesPath(),
      ...["pipkin", "bin", "extensions", "skills", "prompts", "themes"].map(
        (name) => join(agent, name),
      ),
    ]),
  ];
}

export function createFixedCapabilities(
  sessionCwd: string,
  sessionFile?: string | undefined,
): FixedCapabilities {
  const cwd = canonicalizeTarget(sessionCwd, process.cwd());
  const grants: FilesystemGrant[] = [];
  const add = (raw: string, access: AccessMode, kind: GrantKind) => {
    const grant = makeGrant(raw, access, kind);
    if (!grant || (grant.path !== cwd && under(grant.path, cwd))) {
      return;
    }
    if (
      grants.some(
        (current) =>
          (current.path === grant.path &&
            current.access === grant.access &&
            current.kind === grant.kind) ||
          (grant.kind === "directory" &&
            current.kind === "directory" &&
            current.access === grant.access &&
            under(grant.path, current.path)),
      )
    ) {
      return;
    }
    grants.push(grant);
  };
  for (const [root, access, kind] of fixedRoots(cwd)) {
    add(root, access, kind);
  }
  if (sessionFile) {
    add(sessionFile, "read", "file");
  }
  return { cwd, grants };
}

export function createFilesystemGrant(
  rawPath: string,
  cwd: string,
  access: AccessMode,
  effects: readonly GrantEffect[],
  missingMutationTarget = false,
): FilesystemGrant | null {
  const canonical = canonicalizeTarget(rawPath, cwd);
  const kind =
    kindForExisting(canonical) ?? (missingMutationTarget ? "file" : null);
  return kind === null
    ? null
    : { path: canonical, access, kind, effects: [...new Set(effects)] };
}
