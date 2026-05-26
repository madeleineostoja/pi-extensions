import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createRequire } from "node:module";

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

function resolveHostDocsDir(): string | null {
  try {
    const require = createRequire(import.meta.url);
    const pkgJsonPath =
      require.resolve("@earendil-works/pi-coding-agent/package.json");
    const docsDir = path.join(path.dirname(pkgJsonPath), "docs");
    return fs.existsSync(docsDir) ? docsDir : null;
  } catch {
    return null;
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

    const globalPath = path.join(homeDir, ".pi", "agent", "sandbox.json");
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

    const hostDocsDir = resolveHostDocsDir();
    if (hostDocsDir && !policy.fs.allowRead.includes(hostDocsDir)) {
      policy.fs.allowRead.push(hostDocsDir);
    }

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
