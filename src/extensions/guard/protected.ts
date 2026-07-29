import { homedir } from "node:os";
import { basename, extname, relative, resolve, sep } from "node:path";

function under(path: string, root: string): boolean {
  const result = relative(root, path);
  return result === "" || (!result.startsWith(`..${sep}`) && result !== "..");
}

function workspaceProtected(path: string, cwd: string): boolean {
  if (!under(path, cwd)) {
    return false;
  }
  const name = basename(path);
  return (
    name === ".env" ||
    name.startsWith(".env.") ||
    name === "id_rsa" ||
    name === "id_ed25519" ||
    [".pem", ".key", ".p12"].includes(extname(name))
  );
}

function homeCredential(path: string): boolean {
  const home = homedir();
  return (
    under(path, resolve(home, ".ssh")) ||
    under(path, resolve(home, ".gnupg")) ||
    path === resolve(home, ".aws/credentials") ||
    path === resolve(home, ".aws/config") ||
    path === resolve(home, ".netrc")
  );
}

export function isProtectedReadTarget(
  requested: string,
  canonical: string,
  cwd: string,
): boolean {
  return (
    workspaceProtected(requested, cwd) ||
    workspaceProtected(canonical, cwd) ||
    homeCredential(requested) ||
    homeCredential(canonical)
  );
}
