import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as nodeModule from "node:module";
import { fileURLToPath } from "node:url";

import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_POLICY,
  type DegradedPolicy,
  type Policy,
} from "./defaults.js";
import {
  validatePolicy,
  PolicyValidationError,
  type PartialPolicy,
} from "./schema.js";
import { literalPrefix } from "../enforcement/glob-prefix.js";

export type NotifyTarget = Pick<ExtensionUIContext, "notify">;

export type LoadPolicyOptions = {
  ui?: NotifyTarget;
  home?: string;
  platform?: NodeJS.Platform;
};

export function getUserConfigPath(homeDir = os.homedir()): string {
  return path.join(
    homeDir,
    ".pi",
    "agent",
    "extensions",
    "pi-sandbox",
    "config.json",
  );
}

function getDefaultTempDirs(platform: NodeJS.Platform): string[] {
  const dirs = new Set<string>([os.tmpdir()]);

  if (platform !== "win32") {
    dirs.add("/tmp");
  }

  if (platform === "darwin") {
    dirs.add("/private/tmp");
  }

  return [...dirs];
}

function ensureAllowedPath(entries: string[], entry: string): void {
  if (!entries.includes(entry)) {
    entries.push(entry);
  }
}

function allowDefaultTempDirs(policy: Policy, platform: NodeJS.Platform): void {
  for (const tempDir of getDefaultTempDirs(platform)) {
    ensureAllowedPath(policy.fs.allowRead, tempDir);
    ensureAllowedPath(policy.fs.allowWrite, tempDir);
  }
}

function allowNixStore(policy: Policy): void {
  if (fs.existsSync("/nix/store")) {
    ensureAllowedPath(policy.fs.allowRead, "/nix/store");
  }
}

export type PolicyManager = {
  loadPolicy(cwd: string, uiOrOpts?: NotifyTarget | LoadPolicyOptions): Policy;
  reloadPolicy(
    cwd: string,
    uiOrOpts?: NotifyTarget | LoadPolicyOptions,
  ): Policy;
  subscribe(fn: (policy: Policy) => void): () => void;
  getPolicy(): Policy;
};

export function expandPaths(value: string, cwd: string, home?: string): string {
  const homeDir = home ?? os.homedir();
  let result = value;

  result = result.replaceAll("<cwd>", cwd);

  result = result.replace(/^~(?=\/|$)/, homeDir);

  result = result.replace(
    /\$([A-Z_][A-Z0-9_]*)/gi,
    (_, name) => process.env[name] ?? _,
  );

  return result;
}

export function expandPathsInPolicy(
  policy: Policy,
  cwd: string,
  home?: string,
): Policy {
  return {
    ...policy,
    fs: {
      ...policy.fs,
      allowRead: policy.fs.allowRead.map((p) => expandPaths(p, cwd, home)),
      allowWrite: policy.fs.allowWrite.map((p) => expandPaths(p, cwd, home)),
      denyPatterns: policy.fs.denyPatterns.map((p) =>
        expandPaths(p, cwd, home),
      ),
    },
    audit: {
      ...policy.audit,
      logFile: expandPaths(policy.audit.logFile, cwd, home),
    },
  };
}

function deepMerge(
  base: Policy,
  override: PartialPolicy & Pick<Partial<Policy>, "enabled">,
): Policy {
  const result = structuredClone(base);

  if (override.enabled !== undefined) {
    result.enabled = override.enabled;
  }

  if (override.fs !== undefined) {
    result.fs = { ...result.fs, ...override.fs };
  }

  if (override.network !== undefined) {
    result.network = { ...result.network, ...override.network };
  }

  if (override.audit !== undefined) {
    result.audit = { ...result.audit, ...override.audit };
  }

  if (override.enforcement !== undefined) {
    result.enforcement = { ...result.enforcement, ...override.enforcement };
  }

  if (override.degraded !== undefined) {
    result.degraded = {
      ...result.degraded,
      ...override.degraded,
    } as DegradedPolicy;
  }

  return result;
}

const PI_PACKAGE_NAME = "@earendil-works/pi-coding-agent";
const PI_DOCUMENTATION_SURFACES = [
  "docs",
  "examples",
  "README.md",
  "CHANGELOG.md",
  "containerization.md",
] as const;

type FindPackageJSON = (specifier: string, base: string) => string | undefined;

type HostDocumentationResolverOptions = {
  findPackageJSON?: FindPackageJSON | null;
  importMetaResolve?: (specifier: string) => string;
  argv1?: string;
};

function canonicalPath(filePath: string): string {
  const resolved = path.resolve(filePath);
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function pathFromMaybeFileUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "file:" ? fileURLToPath(url) : null;
  } catch {
    return value;
  }
}

function readPackageName(packageJsonPath: string): string | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as {
      name?: unknown;
    };
    return typeof parsed.name === "string" ? parsed.name : null;
  } catch {
    return null;
  }
}

function directoryForUpwardWalk(startPath: string): string {
  const resolved = path.resolve(startPath);
  try {
    return fs.statSync(resolved).isDirectory()
      ? resolved
      : path.dirname(resolved);
  } catch {
    return path.dirname(resolved);
  }
}

function findPiPackageRootUpward(startPath: string): string | null {
  let current = directoryForUpwardWalk(startPath);

  while (true) {
    const packageJsonPath = path.join(current, "package.json");
    if (readPackageName(packageJsonPath) === PI_PACKAGE_NAME) {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

function getNodeFindPackageJSON(): FindPackageJSON | null {
  try {
    const maybeModule = nodeModule as typeof nodeModule & {
      findPackageJSON?: FindPackageJSON;
    };
    return typeof maybeModule.findPackageJSON === "function"
      ? maybeModule.findPackageJSON
      : null;
  } catch {
    return null;
  }
}

function addPiPackageRoot(
  rootsByRealPath: Map<string, string>,
  root: string,
): void {
  const packageJsonPath = path.join(root, "package.json");
  if (readPackageName(packageJsonPath) !== PI_PACKAGE_NAME) {
    return;
  }

  rootsByRealPath.set(canonicalPath(root), root);
}

export function resolveHostDocumentationPaths(
  options: HostDocumentationResolverOptions = {},
): string[] {
  const rootsByRealPath = new Map<string, string>();

  try {
    const findPackageJSON =
      options.findPackageJSON === undefined
        ? getNodeFindPackageJSON()
        : options.findPackageJSON;
    const packageJsonPath = findPackageJSON?.(PI_PACKAGE_NAME, import.meta.url);
    if (packageJsonPath) {
      addPiPackageRoot(rootsByRealPath, path.dirname(packageJsonPath));
    }
  } catch {}

  try {
    const importMetaResolve =
      options.importMetaResolve ??
      ((specifier: string) => import.meta.resolve(specifier));
    const resolved = importMetaResolve(PI_PACKAGE_NAME);
    const entryPath = pathFromMaybeFileUrl(resolved);
    if (entryPath) {
      const root = findPiPackageRootUpward(entryPath);
      if (root) {
        addPiPackageRoot(rootsByRealPath, root);
      }
    }
  } catch {}

  try {
    const argvPath = options.argv1 ?? process.argv[1];
    if (argvPath) {
      const entryPath = pathFromMaybeFileUrl(argvPath);
      if (entryPath) {
        const root = findPiPackageRootUpward(entryPath);
        if (root) {
          addPiPackageRoot(rootsByRealPath, root);
        }
      }
    }
  } catch {}

  const documentationPaths: string[] = [];
  const documentationRealPaths = new Set<string>();
  for (const root of rootsByRealPath.values()) {
    for (const surface of PI_DOCUMENTATION_SURFACES) {
      const candidate = path.join(root, surface);
      if (!fs.existsSync(candidate)) {
        continue;
      }

      const realPath = canonicalPath(candidate);
      if (!documentationRealPaths.has(realPath)) {
        documentationRealPaths.add(realPath);
        documentationPaths.push(realPath);
      }
    }
  }

  return documentationPaths;
}

function allowHostDocumentation(policy: Policy): void {
  const allowedRealPaths = new Set(policy.fs.allowRead.map(canonicalPath));
  for (const documentationPath of resolveHostDocumentationPaths()) {
    const realPath = canonicalPath(documentationPath);
    if (!allowedRealPaths.has(realPath)) {
      allowedRealPaths.add(realPath);
      policy.fs.allowRead.push(documentationPath);
    }
  }
}

function tryLoadFile(
  filePath: string,
  ui: NotifyTarget | undefined,
): (PartialPolicy & Pick<Partial<Policy>, "enabled">) | null {
  if (!fs.existsSync(filePath)) {
    return null;
  }

  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    ui?.notify(`pi-sandbox: could not read ${filePath}`, "error");
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    ui?.notify(`pi-sandbox: invalid JSON in ${filePath}`, "error");
    return null;
  }

  try {
    return validatePolicy(parsed);
  } catch (err) {
    const message =
      err instanceof PolicyValidationError ? err.message : String(err);
    ui?.notify(`pi-sandbox: config error in ${filePath}: ${message}`, "error");
    return null;
  }
}

export function createPolicyManager(): PolicyManager {
  type Subscriber = (policy: Policy) => void;
  const subscribers: Set<Subscriber> = new Set();
  let currentPolicy: Policy = structuredClone(DEFAULT_POLICY);

  function notify(policy: Policy): void {
    for (const fn of subscribers) {
      fn(policy);
    }
  }

  function loadPolicy(
    cwd: string,
    uiOrOpts?: NotifyTarget | LoadPolicyOptions,
  ): Policy {
    const opts: LoadPolicyOptions =
      uiOrOpts && "notify" in uiOrOpts ? { ui: uiOrOpts } : (uiOrOpts ?? {});
    const { ui, home } = opts;
    const platform = opts.platform ?? process.platform;
    const homeDir = home ?? os.homedir();

    const globalPath = getUserConfigPath(homeDir);
    const projectPath = path.join(cwd, ".pi", "sandbox.json");

    let policy: Policy = structuredClone(DEFAULT_POLICY);

    const globalOverride = tryLoadFile(globalPath, ui);
    if (globalOverride) {
      policy = deepMerge(policy, globalOverride);
    }

    const projectOverride = tryLoadFile(projectPath, ui);
    if (projectOverride) {
      policy = deepMerge(policy, projectOverride);
    }

    policy = expandPathsInPolicy(policy, cwd, homeDir);
    allowDefaultTempDirs(policy, platform);
    allowNixStore(policy);

    allowHostDocumentation(policy);

    if (platform === "darwin" && ui) {
      for (const pattern of policy.fs.denyPatterns) {
        if (literalPrefix(pattern) === null) {
          ui.notify(
            `pi-sandbox: deny pattern '${pattern}' has no literal prefix and will only be enforced by the in-process gate. Anchor it (e.g. '<cwd>/${pattern}' or '~/${pattern}') for kernel-level enforcement.`,
            "warning",
          );
        }
      }
    }

    if (policy.network.mode === "always" && policy.network.allow.length === 0) {
      ui?.notify(
        "pi-sandbox: network mode is 'always' with no allowed hosts — all outbound network from sandboxed subprocesses will be blocked. If unintended, add hosts to network.allow.",
        "warning",
      );
    }

    currentPolicy = policy;
    return policy;
  }

  function reloadPolicy(
    cwd: string,
    uiOrOpts?: NotifyTarget | LoadPolicyOptions,
  ): Policy {
    const policy = loadPolicy(cwd, uiOrOpts);
    notify(policy);
    return policy;
  }

  function subscribe(fn: Subscriber): () => void {
    subscribers.add(fn);
    return () => subscribers.delete(fn);
  }

  function getPolicy(): Policy {
    return currentPolicy;
  }

  return { loadPolicy, reloadPolicy, subscribe, getPolicy };
}
