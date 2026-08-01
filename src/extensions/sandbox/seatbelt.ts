import { isAbsolute, normalize } from "node:path";
import type { SandboxPolicy } from "./policy.js";

export const SANDBOX_EXECUTABLE = "/usr/bin/sandbox-exec";

export const SANDBOX_PROFILE = String.raw`(version 1)
(deny default)
(import "system.sb")
(allow file-read*)
(allow file-read-metadata)
(allow process-exec)
(allow process-fork)
(allow process-info* (target same-sandbox))
(allow signal (target self))
(allow signal (target same-sandbox))
(allow file-ioctl)
(allow ipc-posix-shm)
(allow ipc-posix-sem)
(allow sysctl-read)
(allow network*)
(allow mach-lookup
  (global-name "com.apple.system.opendirectoryd.libinfo"))
(allow file-write*
  (literal (param "root0"))
  (subpath (param "root0"))
  (literal (param "root1"))
  (subpath (param "root1"))
  (literal (param "root2"))
  (subpath (param "root2"))
  (literal (param "root3"))
  (subpath (param "root3"))
  (literal (param "root4"))
  (subpath (param "root4"))
  (literal (param "root5"))
  (subpath (param "root5"))
  (literal (param "root6"))
  (subpath (param "root6"))
  (literal (param "root7"))
  (subpath (param "root7"))
  (literal (param "root8"))
  (subpath (param "root8"))
  (literal (param "root9"))
  (subpath (param "root9"))
  (literal (param "root10"))
  (subpath (param "root10"))
  (literal (param "root11"))
  (subpath (param "root11"))
  (literal (param "root12"))
  (subpath (param "root12"))
  (literal (param "root13"))
  (subpath (param "root13"))
  (literal (param "root14"))
  (subpath (param "root14"))
  (literal (param "root15"))
  (subpath (param "root15")))`;

const MAX_WRITABLE_ROOTS = 16;

export function assertWritableRoots(roots: readonly string[]): void {
  if (roots.length === 0 || roots.length > MAX_WRITABLE_ROOTS) {
    throw new Error("Sandbox: invalid writable roots.");
  }
  const seen = new Set<string>();
  for (const root of roots) {
    if (
      !isAbsolute(root) ||
      root.includes("\0") ||
      normalize(root) !== root ||
      seen.has(root)
    ) {
      throw new Error("Sandbox: invalid writable roots.");
    }
    seen.add(root);
  }
}

export function sandboxParameters(roots: readonly string[]): string[] {
  assertWritableRoots(roots);
  return roots.map((root, index) => `root${index}=${root}`);
}

function profileParameters(roots: readonly string[]): string[] {
  const parameters = sandboxParameters(roots);
  return [
    ...parameters,
    ...Array.from(
      { length: MAX_WRITABLE_ROOTS - roots.length },
      (_, index) => `root${roots.length + index}=${roots[0]}`,
    ),
  ];
}

export function sandboxArguments(
  options: Readonly<{
    policy: SandboxPolicy;
    shell: Readonly<{ shell: string; args: readonly string[] }>;
  }>,
): string[] {
  return [
    ...profileParameters(options.policy.writableRoots).flatMap((value) => [
      "-D",
      value,
    ]),
    "-p",
    SANDBOX_PROFILE,
    "--",
    options.shell.shell,
    ...options.shell.args,
  ];
}
