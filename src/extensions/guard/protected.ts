import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, extname, relative, resolve, sep, win32 } from "node:path";
import type { PiPathCompatibility } from "./capabilities.js";

function pathFor(compatibility: PiPathCompatibility) {
  return (compatibility.platform ?? process.platform) === "win32"
    ? win32
    : { basename, extname, relative, resolve, sep };
}

function under(
  path: string,
  root: string,
  compatibility: PiPathCompatibility,
): boolean {
  const pathApi = pathFor(compatibility);
  const result = pathApi.relative(root, path);
  return (
    result === "" || (!result.startsWith(`..${pathApi.sep}`) && result !== "..")
  );
}

function workspaceProtected(
  path: string,
  cwd: string,
  compatibility: PiPathCompatibility,
): boolean {
  if (!under(path, cwd, compatibility)) {
    return false;
  }
  const pathApi = pathFor(compatibility);
  const name = pathApi.basename(path);
  return (
    name === ".env" ||
    name.startsWith(".env.") ||
    name === "id_rsa" ||
    name === "id_ed25519" ||
    [".pem", ".key", ".p12"].includes(pathApi.extname(name))
  );
}

function canonical(path: string): string | undefined {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}

function homeCredential(
  path: string,
  compatibility: PiPathCompatibility,
): boolean {
  const pathApi = pathFor(compatibility);
  const home = compatibility.homeDir ?? homedir();
  const directories = [
    pathApi.resolve(home, ".ssh"),
    pathApi.resolve(home, ".gnupg"),
  ];
  const files = [
    pathApi.resolve(home, ".aws/credentials"),
    pathApi.resolve(home, ".aws/config"),
    pathApi.resolve(home, ".netrc"),
  ];
  return (
    directories.some((directory) => under(path, directory, compatibility)) ||
    files.includes(path) ||
    directories.some((directory) => {
      const target = canonical(directory);
      return target !== undefined && under(path, target, compatibility);
    }) ||
    files.some((file) => canonical(file) === path)
  );
}

export function isProtectedReadTarget(
  requested: string,
  canonical: string,
  cwd: string,
  compatibility: PiPathCompatibility = {},
): boolean {
  return (
    workspaceProtected(requested, cwd, compatibility) ||
    workspaceProtected(canonical, cwd, compatibility) ||
    homeCredential(requested, compatibility) ||
    homeCredential(canonical, compatibility)
  );
}
