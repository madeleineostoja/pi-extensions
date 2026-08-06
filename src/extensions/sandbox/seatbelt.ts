import { isAbsolute, normalize } from "node:path";
import { pathIsWithin, type SandboxPolicy } from "./policy.js";
import type { SandboxWriteMode } from "./write-mode.js";

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
(allow file-write-data file-ioctl
  (literal "/dev/dtracehelper"))
(allow file-write-data
  (literal "/dev/tty")
  (literal "/dev/fd/1")
  (literal "/dev/fd/2"))
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
    (regex #"^/dev/ttys[0-9]+$")
    (extension "com.apple.sandbox.pty")))
(allow file-ioctl (regex #"^/dev/ttys[0-9]+$"))
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

function markedDenyDefault(marker: string | undefined): string {
  if (marker === undefined) {
    return "(deny default)";
  }
  if (!/^PIPKIN_[A-Za-z0-9]+$/.test(marker)) {
    throw new Error("Sandbox: invalid denial marker.");
  }
  return `(deny default (with message "${marker}"))`;
}

function protectedRoots(policy: SandboxPolicy): readonly string[] {
  return Object.freeze(
    [
      policy.workspaceRoot,
      ...(policy.git
        ? [policy.git.worktreeGitDir, policy.git.commonGitDir]
        : []),
    ].filter(
      (root, index, roots) =>
        roots.findIndex((candidate) => candidate === root) === index,
    ),
  );
}

function writableProjection(
  policy: SandboxPolicy,
  writeMode: SandboxWriteMode,
): readonly string[] {
  if (writeMode === "workspace-write") {
    return policy.writableRoots;
  }
  return [
    ...policy.temporaryRoots,
    ...policy.cacheRoots,
    ...policy.dependencyRoots,
  ].filter(
    (root, index, roots) =>
      roots.findIndex((candidate) => candidate === root) === index,
  );
}

function creationProjection(
  policy: SandboxPolicy,
  writeMode: SandboxWriteMode,
  writableRoots: readonly string[],
): readonly string[] {
  if (writeMode === "workspace-write") {
    return policy.creationRoots;
  }
  return policy.creationRoots.filter((creationRoot) =>
    writableRoots.some(
      (writableRoot) =>
        creationRoot !== writableRoot &&
        pathIsWithin(writableRoot, creationRoot),
    ),
  );
}

function protectedParameters(roots: readonly string[]): string[] {
  return roots.map((root, index) => `protected${index}=${root}`);
}

function exceptionParameters(roots: readonly string[]): string[] {
  return roots.map((root, index) => `exception${index}=${root}`);
}

function repositoryExceptions(
  policy: SandboxPolicy,
  repositoryRoots: readonly string[],
): readonly string[] {
  return policy.dependencyRoots.filter((dependencyRoot) =>
    repositoryRoots.some(
      (repositoryRoot) =>
        dependencyRoot !== repositoryRoot &&
        pathIsWithin(dependencyRoot, repositoryRoot),
    ),
  );
}

function exceptionIndices(
  repositoryRoot: string,
  exceptions: readonly string[],
): readonly number[] {
  return exceptions.flatMap((exception, index) =>
    exception !== repositoryRoot && pathIsWithin(exception, repositoryRoot)
      ? [index]
      : [],
  );
}

function protectedFilter(
  kind: "literal" | "subpath",
  protectedIndex: number,
  exceptionIndices: readonly number[],
): string {
  const protectedPath = `(${kind} (param "protected${protectedIndex}"))`;
  if (exceptionIndices.length === 0) {
    return protectedPath;
  }
  const exceptions = exceptionIndices
    .map((index) => `      (${kind} (param "exception${index}"))`)
    .join("\n");
  return `(require-all
    ${protectedPath}
    (require-not
      (require-any
${exceptions})))`;
}

export function sandboxProfile(
  policy: SandboxPolicy,
  marker?: string,
  writeMode: SandboxWriteMode = "workspace-write",
): string {
  const writableRoots = writableProjection(policy, writeMode);
  const creationRoots = creationProjection(policy, writeMode, writableRoots);
  const repositoryRoots = protectedRoots(policy);
  const exceptions = repositoryExceptions(policy, repositoryRoots);
  assertPaths(writableRoots, true);
  assertPaths(repositoryRoots, true);
  assertCreationRoots(creationRoots, writableRoots);
  const recursiveRules = writableRoots.flatMap((_, index) => [
    `  (literal (param "root${index}"))`,
    `  (subpath (param "root${index}"))`,
  ]);
  const creationRules = creationRoots.map(
    (_, index) => `  (literal (param "create${index}"))`,
  );
  const allow =
    recursiveRules.length || creationRules.length
      ? `\n(allow file-write*\n${[...recursiveRules, ...creationRules].join("\n")})`
      : "";
  const denies =
    writeMode === "repository-read-only"
      ? `\n${repositoryRoots
          .flatMap((repositoryRoot, index) => {
            const indices = exceptionIndices(repositoryRoot, exceptions);
            return [
              `(deny file-write* (with message "${marker ?? "PIPKIN_REPOSITORY_READ_ONLY"}") ${protectedFilter("literal", index, indices)})`,
              `(deny file-write* (with message "${marker ?? "PIPKIN_REPOSITORY_READ_ONLY"}") ${protectedFilter("subpath", index, indices)})`,
            ];
          })
          .join("\n")}`
      : "";
  return `${SANDBOX_PROFILE.replace("(deny default)", markedDenyDefault(marker))}${allow}${denies}`;
}

export function sandboxArguments(
  options: Readonly<{
    policy: SandboxPolicy;
    shell: Readonly<{ shell: string; args: readonly string[] }>;
    marker?: string;
    writeMode?: SandboxWriteMode;
  }>,
): string[] {
  const writeMode = options.writeMode ?? "workspace-write";
  const writableRoots = writableProjection(options.policy, writeMode);
  const repositoryRoots = protectedRoots(options.policy);
  const exceptions = repositoryExceptions(options.policy, repositoryRoots);
  assertPaths(repositoryRoots, true);
  const creationRoots = creationProjection(
    options.policy,
    writeMode,
    writableRoots,
  );
  const definitions = [
    ...writableRoots.map((root, index) => `root${index}=${root}`),
    ...creationParameters(creationRoots),
    ...(writeMode === "repository-read-only"
      ? [
          ...protectedParameters(repositoryRoots),
          ...exceptionParameters(exceptions),
        ]
      : []),
  ];
  return [
    ...definitions.flatMap((value) => ["-D", value]),
    "-p",
    sandboxProfile(options.policy, options.marker, writeMode),
    "--",
    options.shell.shell,
    ...options.shell.args,
  ];
}
