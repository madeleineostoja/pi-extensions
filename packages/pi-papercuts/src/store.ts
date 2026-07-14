import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { ensureGitInfoExclude } from "@pi-extensions/lib";

const execFileAsync = promisify(execFile);
const VERSION = 1 as const;
const SOURCE_LIMIT = 20;
const LOCK_WAIT_MS = 2_000;
const LOCK_RETRY_MS = 25;
const LOCK_OWNER_FILE = "owner.json";
const CLAIM_TAKEOVER_DIR = "takeover";
const queues = new Map<string, Promise<unknown>>();
const statuses = ["pending", "resolved", "ignored"] as const;
const destinations = [
  "agents",
  "skill",
  "test",
  "lint",
  "tooling",
  "docs",
  "code",
] as const;
const sourceKinds = ["agent", "pi-implement", "user"] as const;

type LockOwner = { id: string; pid: number; at: string; host: string };
type DirectoryLock =
  | { kind: "absent" }
  | { kind: "blocked" }
  | { kind: "owner"; owner: LockOwner };
type ClaimState =
  | { kind: "absent" }
  | { kind: "blocked" }
  | { kind: "owner"; owner: LockOwner; path: string };
type ClaimLease = { root: string; released: boolean };

export type PapercutStatus = (typeof statuses)[number];
export type PapercutSource = {
  kind: (typeof sourceKinds)[number];
  sessionId?: string;
  runId?: string;
  taskId?: string;
  role?: string;
};
export type PapercutProposal = {
  key: string;
  title: string;
  trigger: string;
  impact: string;
  currentGap: string;
  proposedResolution: string;
  suggestedDestination: (typeof destinations)[number];
};
export type PapercutRecord = PapercutProposal & {
  status: PapercutStatus;
  occurrences: number;
  firstSeenAt: string;
  lastSeenAt: string;
  sources: PapercutSource[];
  disposition?: { at: string; note?: string; target?: string };
};
export type PapercutFile = { version: 1; records: PapercutRecord[] };
export type ProposalOutcome =
  | { kind: "created"; record: PapercutRecord }
  | { kind: "merged"; record: PapercutRecord }
  | { kind: "ignored"; record: PapercutRecord }
  | { kind: "resolved"; record: PapercutRecord }
  | { kind: "rejected"; reason: string };

export type PapercutStore = ReturnType<typeof createPapercutStore>;
export type PapercutChange = { registryPath: string };

type PapercutChangeListener = (change: PapercutChange) => void;

const changeListeners = new Set<PapercutChangeListener>();

export function onPapercutChange(listener: PapercutChangeListener): () => void {
  changeListeners.add(listener);
  return () => changeListeners.delete(listener);
}

function emitPapercutChange(change: PapercutChange): void {
  for (const listener of changeListeners) {
    try {
      listener(change);
    } catch {
      // Store mutations must not fail because a UI observer cannot refresh.
    }
  }
}

export function normalizeKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function normalizedText(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function identity(record: Pick<PapercutProposal, "title" | "trigger">): string {
  return `${normalizedText(record.title)}\u0000${normalizedText(record.trigger)}`;
}

function sourceKey(source: PapercutSource): string {
  return JSON.stringify(source);
}

function stableFile(file: PapercutFile): PapercutFile {
  return {
    version: VERSION,
    records: [...file.records].sort((a, b) => a.key.localeCompare(b.key)),
  };
}

function serialize(file: PapercutFile): string {
  return `${JSON.stringify(stableFile(file), null, 2)}\n`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function hasOnlyKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

export function isPapercutStatus(value: unknown): value is PapercutStatus {
  return (
    typeof value === "string" && statuses.includes(value as PapercutStatus)
  );
}

function isSource(value: unknown): value is PapercutSource {
  if (
    !isObject(value) ||
    !hasOnlyKeys(value, ["kind", "sessionId", "runId", "taskId", "role"]) ||
    !sourceKinds.includes(value.kind as PapercutSource["kind"])
  ) {
    return false;
  }
  return ["sessionId", "runId", "taskId", "role"].every(
    (key) => value[key] === undefined || typeof value[key] === "string",
  );
}

function isProposal(value: unknown): value is PapercutProposal {
  if (
    !isObject(value) ||
    !hasOnlyKeys(value, [
      "key",
      "title",
      "trigger",
      "impact",
      "currentGap",
      "proposedResolution",
      "suggestedDestination",
    ])
  ) {
    return false;
  }
  return (
    [
      "key",
      "title",
      "trigger",
      "impact",
      "currentGap",
      "proposedResolution",
    ].every((key) => isString(value[key])) &&
    destinations.includes(
      value.suggestedDestination as PapercutProposal["suggestedDestination"],
    )
  );
}

function isDisposition(
  value: unknown,
): value is { note?: string; target?: string } | undefined {
  return (
    value === undefined ||
    (isObject(value) &&
      hasOnlyKeys(value, ["note", "target"]) &&
      (value.note === undefined || typeof value.note === "string") &&
      (value.target === undefined || typeof value.target === "string"))
  );
}

function isRecord(value: unknown): value is PapercutRecord {
  if (
    !isObject(value) ||
    !hasOnlyKeys(value, [
      "key",
      "title",
      "trigger",
      "impact",
      "currentGap",
      "proposedResolution",
      "suggestedDestination",
      "status",
      "occurrences",
      "firstSeenAt",
      "lastSeenAt",
      "sources",
      "disposition",
    ]) ||
    !isProposal({
      key: value.key,
      title: value.title,
      trigger: value.trigger,
      impact: value.impact,
      currentGap: value.currentGap,
      proposedResolution: value.proposedResolution,
      suggestedDestination: value.suggestedDestination,
    })
  ) {
    return false;
  }
  const record = value as PapercutRecord;
  const disposition = record.disposition;
  return (
    isPapercutStatus(record.status) &&
    Number.isInteger(record.occurrences) &&
    record.occurrences > 0 &&
    typeof record.firstSeenAt === "string" &&
    typeof record.lastSeenAt === "string" &&
    Array.isArray(record.sources) &&
    record.sources.every(isSource) &&
    (disposition === undefined ||
      (isObject(disposition) &&
        typeof disposition.at === "string" &&
        (disposition.note === undefined ||
          typeof disposition.note === "string") &&
        (disposition.target === undefined ||
          typeof disposition.target === "string")))
  );
}

function canonicalizeFile(value: { records: PapercutRecord[] }): PapercutFile {
  const keys = new Set<string>();
  const identities = new Set<string>();
  const records = value.records.map((record) => {
    const key = normalizeKey(record.key);
    const duplicateIdentity = identity(record);
    if (!key || keys.has(key)) {
      throw new Error("Papercut registry contains duplicate or invalid keys.");
    }
    if (identities.has(duplicateIdentity)) {
      throw new Error(
        "Papercut registry contains duplicate title and trigger.",
      );
    }
    keys.add(key);
    identities.add(duplicateIdentity);
    return { ...record, key };
  });
  return { version: VERSION, records };
}

export function parsePapercutFile(text: string): PapercutFile {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("Papercut registry contains invalid JSON.");
  }
  if (
    !isObject(value) ||
    value.version !== VERSION ||
    !Array.isArray(value.records)
  ) {
    throw new Error("Papercut registry has an unsupported version or shape.");
  }
  if (!value.records.every(isRecord)) {
    throw new Error("Papercut registry contains an invalid record.");
  }
  return canonicalizeFile({ records: value.records });
}

async function gitRoot(cwd: string): Promise<string> {
  const { stdout } = await execFileAsync(
    "git",
    ["rev-parse", "--show-toplevel"],
    { cwd },
  );
  return stdout.trim();
}

function readRegistry(path: string): PapercutFile {
  if (!existsSync(path)) {
    return { version: VERSION, records: [] };
  }
  return parsePapercutFile(readFileSync(path, "utf-8"));
}

function isOwnerGone(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return isObject(error) && error.code === "ESRCH";
  }
}

function readOwner(path: string): LockOwner | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf-8"));
    if (
      !isObject(value) ||
      typeof value.id !== "string" ||
      typeof value.pid !== "number" ||
      typeof value.at !== "string" ||
      typeof value.host !== "string"
    ) {
      return undefined;
    }
    return value as LockOwner;
  } catch {
    return undefined;
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function readDirectoryLock(path: string): DirectoryLock {
  if (!existsSync(path)) {
    return { kind: "absent" };
  }
  if (!isDirectory(path)) {
    return { kind: "blocked" };
  }
  const owner = readOwner(join(path, LOCK_OWNER_FILE));
  return owner ? { kind: "owner", owner } : { kind: "blocked" };
}

function readClaim(path: string): ClaimState {
  const root = readDirectoryLock(path);
  if (root.kind !== "owner") {
    return root;
  }

  let currentPath = path;
  let currentOwner = root.owner;
  while (existsSync(join(currentPath, CLAIM_TAKEOVER_DIR))) {
    currentPath = join(currentPath, CLAIM_TAKEOVER_DIR);
    const takeover = readDirectoryLock(currentPath);
    if (takeover.kind !== "owner") {
      return { kind: "blocked" };
    }
    currentOwner = takeover.owner;
  }
  return { kind: "owner", owner: currentOwner, path: currentPath };
}

function isStaleOwner(owner: LockOwner | undefined): owner is LockOwner {
  return (
    owner !== undefined && owner.host === hostname() && isOwnerGone(owner.pid)
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function newLockOwner(): LockOwner {
  return {
    id: randomUUID(),
    pid: process.pid,
    at: new Date().toISOString(),
    host: hostname(),
  };
}

function isErrorCode(error: unknown, code: string): boolean {
  return isObject(error) && error.code === code;
}

function createLockDirectory(path: string, owner: LockOwner): void {
  const pendingPath = `${path}.${owner.id}.pending`;
  mkdirSync(pendingPath);
  try {
    writeFileSync(
      join(pendingPath, LOCK_OWNER_FILE),
      `${JSON.stringify(owner)}\n`,
    );
    try {
      renameSync(pendingPath, path);
    } catch (error) {
      if (
        isErrorCode(error, "EEXIST") ||
        isErrorCode(error, "ENOTEMPTY") ||
        isErrorCode(error, "ENOTDIR")
      ) {
        throw Object.assign(new Error(`Lock already exists: ${path}`), {
          code: "EEXIST",
        });
      }
      throw error;
    }
  } finally {
    rmSync(pendingPath, { recursive: true, force: true });
  }
}

function releaseDirectory(path: string): void {
  rmSync(path, { recursive: true, force: true });
}

function releaseMainLock(lockPath: string): () => void {
  let released = false;
  return () => {
    if (!released) {
      released = true;
      releaseDirectory(lockPath);
    }
  };
}

function createClaim(claimPath: string): ClaimLease | undefined {
  const owner = newLockOwner();
  try {
    createLockDirectory(claimPath, owner);
    return { root: claimPath, released: false };
  } catch (error) {
    if (isErrorCode(error, "EEXIST")) {
      return undefined;
    }
    throw error;
  }
}

function takeOverClaim(
  claimPath: string,
  claim: Extract<ClaimState, { kind: "owner" }>,
): ClaimLease | undefined {
  const path = join(claim.path, CLAIM_TAKEOVER_DIR);
  try {
    createLockDirectory(path, newLockOwner());
    return { root: claimPath, released: false };
  } catch (error) {
    if (isErrorCode(error, "EEXIST")) {
      return undefined;
    }
    throw error;
  }
}

function releaseClaim(claim: ClaimLease): void {
  if (!claim.released) {
    claim.released = true;
    releaseDirectory(claim.root);
  }
}

function moveDirectory(fromPath: string, toPath: string): boolean {
  try {
    renameSync(fromPath, toPath);
    return true;
  } catch (error) {
    if (
      isErrorCode(error, "EEXIST") ||
      isErrorCode(error, "ENOENT") ||
      isErrorCode(error, "ENOTEMPTY")
    ) {
      return false;
    }
    throw error;
  }
}

function recoverClaim(
  lockPath: string,
  recoveryPath: string,
  claim: ClaimLease,
): (() => void) | undefined {
  const recovery = readDirectoryLock(recoveryPath);
  if (recovery.kind === "blocked") {
    releaseClaim(claim);
    return undefined;
  }
  if (recovery.kind === "owner") {
    if (!isStaleOwner(recovery.owner)) {
      releaseClaim(claim);
      return undefined;
    }
    releaseDirectory(recoveryPath);
  }

  const main = readDirectoryLock(lockPath);
  if (main.kind === "blocked") {
    releaseClaim(claim);
    return undefined;
  }
  if (main.kind === "owner") {
    if (!isStaleOwner(main.owner)) {
      releaseClaim(claim);
      return undefined;
    }
    if (!moveDirectory(lockPath, recoveryPath)) {
      releaseClaim(claim);
      return undefined;
    }
  }

  const owner = newLockOwner();
  try {
    createLockDirectory(lockPath, owner);
  } catch (error) {
    releaseClaim(claim);
    if (isErrorCode(error, "EEXIST")) {
      return undefined;
    }
    throw error;
  }
  releaseDirectory(recoveryPath);
  releaseClaim(claim);
  return releaseMainLock(lockPath);
}

function acquireFreshLock(
  lockPath: string,
  recoveryPath: string,
  claimPath: string,
): (() => void) | undefined {
  const owner = newLockOwner();
  try {
    createLockDirectory(lockPath, owner);
  } catch (error) {
    if (isErrorCode(error, "EEXIST")) {
      return undefined;
    }
    throw error;
  }

  if (
    readDirectoryLock(recoveryPath).kind !== "absent" ||
    readDirectoryLock(claimPath).kind !== "absent"
  ) {
    releaseDirectory(lockPath);
    return undefined;
  }
  return releaseMainLock(lockPath);
}

async function acquireLock(lockPath: string): Promise<() => void> {
  const recoveryPath = `${lockPath}.recovery`;
  const claimPath = `${lockPath}.claim`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  let claimLease: ClaimLease | undefined;

  while (Date.now() < deadline) {
    if (claimLease) {
      const release = recoverClaim(lockPath, recoveryPath, claimLease);
      if (release) {
        return release;
      }
      if (claimLease.released) {
        claimLease = undefined;
      }
      await sleep(LOCK_RETRY_MS);
      continue;
    }

    const claim = readClaim(claimPath);
    if (claim.kind === "blocked") {
      await sleep(LOCK_RETRY_MS);
      continue;
    }
    if (claim.kind === "owner") {
      if (isStaleOwner(claim.owner)) {
        claimLease = takeOverClaim(claimPath, claim);
      }
      await sleep(LOCK_RETRY_MS);
      continue;
    }

    const recovery = readDirectoryLock(recoveryPath);
    if (recovery.kind === "blocked") {
      await sleep(LOCK_RETRY_MS);
      continue;
    }
    if (recovery.kind === "owner") {
      if (isStaleOwner(recovery.owner)) {
        claimLease = createClaim(claimPath);
      }
      await sleep(LOCK_RETRY_MS);
      continue;
    }

    const release = acquireFreshLock(lockPath, recoveryPath, claimPath);
    if (release) {
      return release;
    }

    const main = readDirectoryLock(lockPath);
    if (main.kind === "owner" && isStaleOwner(main.owner)) {
      claimLease = createClaim(claimPath);
    }
    await sleep(LOCK_RETRY_MS);
  }

  if (claimLease && !claimLease.released) {
    releaseClaim(claimLease);
  }
  throw new Error(
    "Papercut registry is locked by another active or unverifiable process.",
  );
}

function atomicWrite(path: string, file: PapercutFile): void {
  mkdirSync(dirname(path), { recursive: true });
  const tempPath = join(
    dirname(path),
    `.${process.pid}-${randomUUID()}.papercuts.tmp`,
  );
  try {
    writeFileSync(tempPath, serialize(file), "utf-8");
    renameSync(tempPath, path);
  } finally {
    rmSync(tempPath, { force: true });
  }
}

function queue<T>(path: string, operation: () => Promise<T>): Promise<T> {
  const previous = queues.get(path) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(operation);
  queues.set(path, next);
  void next.then(
    () => queues.get(path) === next && queues.delete(path),
    () => queues.get(path) === next && queues.delete(path),
  );
  return next;
}

function mergeSources(
  current: PapercutSource[],
  source: PapercutSource,
): PapercutSource[] {
  const sources = [...current];
  if (
    !sources.some((candidate) => sourceKey(candidate) === sourceKey(source))
  ) {
    sources.push(source);
  }
  return sources.slice(-SOURCE_LIMIT);
}

function normalizeProposal(proposal: PapercutProposal): PapercutProposal {
  return { ...proposal, key: normalizeKey(proposal.key) };
}

function validateProposal(proposal: unknown): string | undefined {
  if (!isProposal(proposal) || !normalizeKey(proposal.key)) {
    return "All proposal fields must be concrete and valid.";
  }
  return undefined;
}

function normalizeLookupKey(key: unknown): string {
  if (typeof key !== "string" || !normalizeKey(key)) {
    throw new Error("Papercut key must be a non-empty string.");
  }
  return normalizeKey(key);
}

export function createPapercutStore(root: string) {
  const canonicalRoot = realpathSync(root);
  const registryPath = join(canonicalRoot, ".pi", "papercuts.json");
  const lockPath = `${registryPath}.lock`;

  async function initialize(): Promise<void> {
    return queue(registryPath, async () => {
      mkdirSync(dirname(registryPath), { recursive: true });
      const release = await acquireLock(lockPath);
      try {
        await ensureGitInfoExclude(root, "/.pi/papercuts.json");
        if (!existsSync(registryPath)) {
          atomicWrite(registryPath, { version: VERSION, records: [] });
        } else {
          readRegistry(registryPath);
        }
      } finally {
        release();
      }
    });
  }

  async function load(): Promise<PapercutFile> {
    return queue(registryPath, async () => readRegistry(registryPath));
  }

  async function mutate<T>(
    operation: (file: PapercutFile) => { file: PapercutFile; result: T },
  ): Promise<T> {
    return queue(registryPath, async () => {
      mkdirSync(dirname(registryPath), { recursive: true });
      const release = await acquireLock(lockPath);
      try {
        const current = readRegistry(registryPath);
        const { file, result } = operation(current);
        atomicWrite(registryPath, canonicalizeFile(file));
        emitPapercutChange({ registryPath });
        return result;
      } finally {
        release();
      }
    });
  }

  return {
    root,
    registryPath,
    initialize,
    load,
    async propose(
      proposal: unknown,
      source: unknown,
    ): Promise<ProposalOutcome> {
      const reason = validateProposal(proposal);
      if (reason || !isProposal(proposal) || !isSource(source)) {
        return {
          kind: "rejected",
          reason: reason ?? "Papercut source must be valid.",
        };
      }
      const normalizedProposal = normalizeProposal(proposal);
      await initialize();
      return mutate<ProposalOutcome>((file) => {
        const existing = file.records.find(
          (record) =>
            record.key === normalizedProposal.key ||
            identity(record) === identity(normalizedProposal),
        );
        if (existing) {
          if (existing.status === "ignored") {
            return {
              file,
              result: { kind: "ignored" as const, record: existing },
            };
          }
          if (existing.status === "resolved") {
            return {
              file,
              result: { kind: "resolved" as const, record: existing },
            };
          }
          const record = {
            ...existing,
            occurrences: existing.occurrences + 1,
            lastSeenAt: new Date().toISOString(),
            sources: mergeSources(existing.sources, source),
          };
          return {
            file: {
              ...file,
              records: file.records.map((candidate) =>
                candidate.key === record.key ? record : candidate,
              ),
            },
            result: { kind: "merged" as const, record },
          };
        }
        const now = new Date().toISOString();
        const record: PapercutRecord = {
          ...normalizedProposal,
          status: "pending",
          occurrences: 1,
          firstSeenAt: now,
          lastSeenAt: now,
          sources: [source],
        };
        return {
          file: { ...file, records: [...file.records, record] },
          result: { kind: "created" as const, record },
        };
      });
    },
    async transition(
      key: unknown,
      status: unknown,
      disposition?: unknown,
    ): Promise<PapercutRecord> {
      const normalizedKey = normalizeLookupKey(key);
      if (!isPapercutStatus(status)) {
        throw new Error(
          "Papercut status must be pending, resolved, or ignored.",
        );
      }
      if (!isDisposition(disposition)) {
        throw new Error(
          "Papercut disposition must contain only string note or target values.",
        );
      }
      return mutate((file) => {
        const found = file.records.find(
          (record) => record.key === normalizedKey,
        );
        if (!found) {
          throw new Error(`Unknown papercut: ${normalizedKey}`);
        }
        const record: PapercutRecord =
          status === "pending"
            ? { ...found, status, disposition: undefined }
            : {
                ...found,
                status,
                disposition: { at: new Date().toISOString(), ...disposition },
              };
        return {
          file: {
            ...file,
            records: file.records.map((candidate) =>
              candidate.key === normalizedKey ? record : candidate,
            ),
          },
          result: record,
        };
      });
    },
    async edit(key: unknown, proposal: unknown): Promise<PapercutRecord> {
      const normalizedKey = normalizeLookupKey(key);
      const reason = validateProposal(proposal);
      if (reason || !isProposal(proposal)) {
        throw new Error(
          reason ?? "All proposal fields must be concrete and valid.",
        );
      }
      const normalizedProposal = normalizeProposal(proposal);
      return mutate((file) => {
        const found = file.records.find(
          (record) => record.key === normalizedKey,
        );
        if (!found) {
          throw new Error(`Unknown papercut: ${normalizedKey}`);
        }
        if (normalizedProposal.key !== normalizedKey) {
          throw new Error("Editing a papercut cannot change its key.");
        }
        if (
          file.records.some(
            (record) =>
              record.key !== normalizedKey &&
              identity(record) === identity(normalizedProposal),
          )
        ) {
          throw new Error(
            "Papercut title and trigger already belong to another record.",
          );
        }
        const record = { ...found, ...normalizedProposal };
        return {
          file: {
            ...file,
            records: file.records.map((candidate) =>
              candidate.key === normalizedKey ? record : candidate,
            ),
          },
          result: record,
        };
      });
    },
    async delete(key: unknown, confirmed: unknown): Promise<void> {
      const normalizedKey = normalizeLookupKey(key);
      if (confirmed !== true) {
        throw new Error("Deleting a papercut requires confirmation.");
      }
      return mutate((file) => {
        if (!file.records.some((record) => record.key === normalizedKey)) {
          throw new Error(`Unknown papercut: ${normalizedKey}`);
        }
        return {
          file: {
            ...file,
            records: file.records.filter(
              (record) => record.key !== normalizedKey,
            ),
          },
          result: undefined,
        };
      });
    },
  };
}

export async function createPapercutStoreForCwd(
  cwd: string,
): Promise<PapercutStore> {
  return createPapercutStore(await gitRoot(cwd));
}
