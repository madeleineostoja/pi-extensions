import { isAbsolute, normalize } from "node:path";
import { pathIsWithin, type SandboxPolicy } from "./policy.js";

export const SANDBOX_EXECUTABLE = "/usr/bin/sandbox-exec";

export const SANDBOX_PROFILE = String.raw`(version 1)
; Process compatibility rules adapted from OpenAI Codex's Apache-2.0 Seatbelt policy.
(deny default)
(allow file-read*)
(allow process-exec)
(allow process-fork)
(allow process-info* (target same-sandbox))
(allow signal (target same-sandbox))
(allow file-write-data
  (require-all
    (path "/dev/null")
    (vnode-type CHARACTER-DEVICE)))
(allow sysctl-read
  (sysctl-name "hw.activecpu")
  (sysctl-name "hw.busfrequency_compat")
  (sysctl-name "hw.byteorder")
  (sysctl-name "hw.cacheconfig")
  (sysctl-name "hw.cachelinesize_compat")
  (sysctl-name "hw.cpufamily")
  (sysctl-name "hw.cpufrequency_compat")
  (sysctl-name "hw.cputype")
  (sysctl-name "hw.l1dcachesize_compat")
  (sysctl-name "hw.l1icachesize_compat")
  (sysctl-name "hw.l2cachesize_compat")
  (sysctl-name "hw.l3cachesize_compat")
  (sysctl-name "hw.logicalcpu_max")
  (sysctl-name "hw.machine")
  (sysctl-name "hw.model")
  (sysctl-name "hw.memsize")
  (sysctl-name "hw.ncpu")
  (sysctl-name "hw.nperflevels")
  (sysctl-name-prefix "hw.optional.arm.")
  (sysctl-name-prefix "hw.optional.armv8_")
  (sysctl-name "hw.packages")
  (sysctl-name "hw.pagesize_compat")
  (sysctl-name "hw.pagesize")
  (sysctl-name "hw.physicalcpu")
  (sysctl-name "hw.physicalcpu_max")
  (sysctl-name "hw.logicalcpu")
  (sysctl-name "hw.cpufrequency")
  (sysctl-name "hw.tbfrequency_compat")
  (sysctl-name "hw.vectorunit")
  (sysctl-name "machdep.cpu.brand_string")
  (sysctl-name "kern.argmax")
  (sysctl-name "kern.hostname")
  (sysctl-name "kern.maxfilesperproc")
  (sysctl-name "kern.maxproc")
  (sysctl-name "kern.osproductversion")
  (sysctl-name "kern.osrelease")
  (sysctl-name "kern.ostype")
  (sysctl-name "kern.osvariant_status")
  (sysctl-name "kern.osversion")
  (sysctl-name "kern.secure_kernel")
  (sysctl-name "kern.usrstack64")
  (sysctl-name "kern.version")
  (sysctl-name "sysctl.proc_cputype")
  (sysctl-name "vm.loadavg")
  (sysctl-name-prefix "hw.perflevel")
  (sysctl-name-prefix "kern.proc.pgrp.")
  (sysctl-name-prefix "kern.proc.pid.")
  (sysctl-name-prefix "net.routetable."))
(allow sysctl-write
  (sysctl-name "kern.grade_cputype"))
(allow iokit-open
  (iokit-registry-entry-class "RootDomainUserClient"))
(allow mach-lookup
  (global-name "com.apple.system.opendirectoryd.libinfo")
  (global-name "com.apple.PowerManagement.control")
  (global-name "com.apple.bsd.dirhelper")
  (global-name "com.apple.system.opendirectoryd.membership")
  (global-name "com.apple.SecurityServer")
  (global-name "com.apple.networkd")
  (global-name "com.apple.ocspd")
  (global-name "com.apple.trustd.agent")
  (global-name "com.apple.SystemConfiguration.DNSConfiguration")
  (global-name "com.apple.SystemConfiguration.configd")
  (global-name "com.apple.cfprefsd.daemon")
  (global-name "com.apple.cfprefsd.agent")
  (local-name "com.apple.cfprefsd.agent"))
(allow ipc-posix-sem)
(allow ipc-posix-shm-read-data
  ipc-posix-shm-write-create
  ipc-posix-shm-write-unlink
  (ipc-posix-name-regex #"^/__KMP_REGISTERED_LIB_[0-9]+$"))
(allow pseudo-tty)
(allow file-read* file-write* file-ioctl (literal "/dev/ptmx"))
(allow file-read* file-write*
  (require-all
    (regex #"^/dev/ttys[0-9]+")
    (extension "com.apple.sandbox.pty")))
(allow file-ioctl (regex #"^/dev/ttys[0-9]+"))
(allow ipc-posix-shm-read* (ipc-posix-name-prefix "apple.cfprefs."))
(allow user-preference-read)
(allow system-socket
  (require-all
    (socket-domain AF_SYSTEM)
    (socket-protocol 2)))
(allow network*)`;

function assertPaths(paths: readonly string[], allowEmpty: boolean): void {
  if (!allowEmpty && paths.length === 0) {
    throw new Error("Sandbox: invalid writable roots.");
  }
  const seen = new Set<string>();
  for (const path of paths) {
    if (
      !isAbsolute(path) ||
      path.includes("\0") ||
      normalize(path) !== path ||
      seen.has(path)
    ) {
      throw new Error("Sandbox: invalid writable roots.");
    }
    seen.add(path);
  }
}

export function assertWritableRoots(roots: readonly string[]): void {
  assertPaths(roots, false);
}

function assertCreationRoots(
  creationRoots: readonly string[],
  writableRoots: readonly string[],
): void {
  assertPaths(creationRoots, true);
  if (
    creationRoots.some(
      (creationRoot) =>
        !writableRoots.some(
          (writableRoot) =>
            creationRoot !== writableRoot &&
            pathIsWithin(writableRoot, creationRoot),
        ),
    )
  ) {
    throw new Error("Sandbox: invalid writable roots.");
  }
}

export function sandboxParameters(roots: readonly string[]): string[] {
  assertWritableRoots(roots);
  return roots.map((root, index) => `root${index}=${root}`);
}

function creationParameters(roots: readonly string[]): string[] {
  return roots.map((root, index) => `create${index}=${root}`);
}

export function sandboxProfile(policy: SandboxPolicy): string {
  assertWritableRoots(policy.writableRoots);
  assertCreationRoots(policy.creationRoots, policy.writableRoots);
  const recursiveRules = policy.writableRoots.flatMap((_, index) => [
    `  (literal (param "root${index}"))`,
    `  (subpath (param "root${index}"))`,
  ]);
  const creationRules = policy.creationRoots.map(
    (_, index) => `  (literal (param "create${index}"))`,
  );
  return `${SANDBOX_PROFILE}\n(allow file-write*\n${[
    ...recursiveRules,
    ...creationRules,
  ].join("\n")})`;
}

export function sandboxArguments(
  options: Readonly<{
    policy: SandboxPolicy;
    shell: Readonly<{ shell: string; args: readonly string[] }>;
  }>,
): string[] {
  const definitions = [
    ...sandboxParameters(options.policy.writableRoots),
    ...creationParameters(options.policy.creationRoots),
  ];
  return [
    ...definitions.flatMap((value) => ["-D", value]),
    "-p",
    sandboxProfile(options.policy),
    "--",
    options.shell.shell,
    ...options.shell.args,
  ];
}
