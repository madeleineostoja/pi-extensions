import type {
  Policy,
  FsPolicy,
  NetworkPolicy,
  AuditPolicy,
  EnforcementPolicy,
} from "./defaults.js";

export type PartialPolicy = {
  fs?: Partial<FsPolicy>;
  network?: Partial<NetworkPolicy>;
  audit?: Partial<AuditPolicy>;
  enforcement?: Partial<EnforcementPolicy>;
};

export class PolicyValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PolicyValidationError";
  }
}

const NETWORK_MODES = new Set(["non-interactive-only", "always", "off"]);

const KNOWN_TOP_LEVEL = new Set([
  "enabled",
  "fs",
  "network",
  "audit",
  "enforcement",
]);
const KNOWN_ENFORCEMENT = new Set(["requireKernelSandbox"]);
const KNOWN_FS = new Set(["allowRead", "allowWrite", "denyPatterns"]);
const KNOWN_NETWORK = new Set(["mode", "allow"]);
const KNOWN_AUDIT = new Set(["log", "logFile"]);

function rejectUnknownKeys(
  obj: Record<string, unknown>,
  known: Set<string>,
  path: string,
): void {
  for (const key of Object.keys(obj)) {
    if (!known.has(key)) {
      throw new PolicyValidationError(`Unknown field "${path}.${key}"`);
    }
  }
}

function requireStringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) {
    throw new PolicyValidationError(`"${path}" must be an array`);
  }
  for (let i = 0; i < value.length; i++) {
    if (typeof value[i] !== "string") {
      throw new PolicyValidationError(`"${path}[${i}]" must be a string`);
    }
  }
  return value as string[];
}

function validateFs(raw: unknown): Partial<FsPolicy> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new PolicyValidationError('"fs" must be an object');
  }
  const obj = raw as Record<string, unknown>;
  rejectUnknownKeys(obj, KNOWN_FS, "fs");

  const allowRead =
    obj.allowRead !== undefined
      ? requireStringArray(obj.allowRead, "fs.allowRead")
      : undefined;
  const allowWrite =
    obj.allowWrite !== undefined
      ? requireStringArray(obj.allowWrite, "fs.allowWrite")
      : undefined;
  const denyPatterns =
    obj.denyPatterns !== undefined
      ? requireStringArray(obj.denyPatterns, "fs.denyPatterns")
      : undefined;

  return {
    ...(allowRead !== undefined && { allowRead }),
    ...(allowWrite !== undefined && { allowWrite }),
    ...(denyPatterns !== undefined && { denyPatterns }),
  };
}

// Accepts bare hostnames ("example.com", "api.github.com") and wildcard prefixes
// ("*.example.com", "*.github.com"). Rejects CIDR ranges and malformed entries.
export function isValidNetworkAllowEntry(entry: string): boolean {
  // Wildcard: must be exactly "*.something"
  const normalized = entry.startsWith("*.") ? entry.slice(2) : entry;
  // After stripping wildcard prefix, must be a valid hostname label sequence.
  // Labels: 1-63 chars each, alphanumeric or hyphen, not starting/ending with hyphen.
  // CIDR (contains '/') is explicitly rejected.
  if (normalized.includes("/")) return false;
  if (normalized.length === 0) return false;
  const labelRe = /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/;
  const labels = normalized.split(".");
  if (labels.length === 0) return false;
  for (const label of labels) {
    if (!labelRe.test(label) && label.length !== 1) {
      // Allow single-char labels (e.g. "a.b.c")
      if (!/^[a-zA-Z0-9]$/.test(label)) return false;
    }
  }
  return true;
}

function validateNetwork(raw: unknown): Partial<NetworkPolicy> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new PolicyValidationError('"network" must be an object');
  }
  const obj = raw as Record<string, unknown>;
  rejectUnknownKeys(obj, KNOWN_NETWORK, "network");

  let mode: NetworkPolicy["mode"] | undefined;
  if (obj.mode !== undefined) {
    if (!NETWORK_MODES.has(obj.mode as string)) {
      throw new PolicyValidationError(
        `"network.mode" must be one of: ${[...NETWORK_MODES].map((m) => `"${m}"`).join(", ")}`,
      );
    }
    mode = obj.mode as NetworkPolicy["mode"];
  }

  let allow: string[] | undefined;
  if (obj.allow !== undefined) {
    allow = requireStringArray(obj.allow, "network.allow");
    for (const entry of allow) {
      if (!isValidNetworkAllowEntry(entry)) {
        throw new PolicyValidationError(
          `"network.allow" entry "${entry}" is invalid: must be a hostname (e.g. "example.com") or wildcard (e.g. "*.example.com"). CIDR ranges are not supported.`,
        );
      }
    }
  }

  return {
    ...(mode !== undefined && { mode }),
    ...(allow !== undefined && { allow }),
  };
}

function validateAudit(raw: unknown): Partial<AuditPolicy> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new PolicyValidationError('"audit" must be an object');
  }
  const obj = raw as Record<string, unknown>;
  rejectUnknownKeys(obj, KNOWN_AUDIT, "audit");

  let log: boolean | undefined;
  if (obj.log !== undefined) {
    if (typeof obj.log !== "boolean") {
      throw new PolicyValidationError('"audit.log" must be a boolean');
    }
    log = obj.log;
  }

  let logFile: string | undefined;
  if (obj.logFile !== undefined) {
    if (typeof obj.logFile !== "string") {
      throw new PolicyValidationError('"audit.logFile" must be a string');
    }
    logFile = obj.logFile;
  }

  return {
    ...(log !== undefined && { log }),
    ...(logFile !== undefined && { logFile }),
  };
}

function validateEnforcement(raw: unknown): Partial<EnforcementPolicy> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new PolicyValidationError('"enforcement" must be an object');
  }
  const obj = raw as Record<string, unknown>;
  rejectUnknownKeys(obj, KNOWN_ENFORCEMENT, "enforcement");

  let requireKernelSandbox: boolean | undefined;
  if (obj.requireKernelSandbox !== undefined) {
    if (typeof obj.requireKernelSandbox !== "boolean") {
      throw new PolicyValidationError(
        '"enforcement.requireKernelSandbox" must be a boolean',
      );
    }
    requireKernelSandbox = obj.requireKernelSandbox;
  }

  return {
    ...(requireKernelSandbox !== undefined && { requireKernelSandbox }),
  };
}

/**
 * Validate a raw parsed object as a partial Policy. Returns the validated
 * partial, or throws PolicyValidationError on schema violations.
 */
export function validatePolicy(
  raw: unknown,
): PartialPolicy & Pick<Partial<Policy>, "enabled"> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new PolicyValidationError("Policy must be an object");
  }
  const obj = raw as Record<string, unknown>;
  rejectUnknownKeys(obj, KNOWN_TOP_LEVEL, "policy");

  const result: PartialPolicy & Pick<Partial<Policy>, "enabled"> = {};

  if (obj.enabled !== undefined) {
    if (typeof obj.enabled !== "boolean") {
      throw new PolicyValidationError('"enabled" must be a boolean');
    }
    result.enabled = obj.enabled;
  }

  if (obj.fs !== undefined) {
    result.fs = validateFs(obj.fs);
  }

  if (obj.network !== undefined) {
    result.network = validateNetwork(obj.network);
  }

  if (obj.audit !== undefined) {
    result.audit = validateAudit(obj.audit);
  }

  if (obj.enforcement !== undefined) {
    result.enforcement = validateEnforcement(obj.enforcement);
  }

  return result;
}
