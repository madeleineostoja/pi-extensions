import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { acquireFileLease } from "#lib/file-lease";
import { ensureGitInfoExclude, gitPrimaryWorktreeRoot } from "#lib/git";

const VERSION = 2 as const;
const MAX_BYTES = 1_048_576;
const MAX_RECORDS = 256;
const MAX_OCCURRENCES = 2_147_483_647;
const LOCK_WAIT_MS = 2_000;
const queues = new Map<string, Promise<unknown>>();
const statuses = ["open", "closed"] as const;
const destinations = [
  "agents",
  "skill",
  "test",
  "lint",
  "tooling",
  "docs",
  "code",
] as const;

export type PapercutStatus = (typeof statuses)[number];
export type PapercutDestination = (typeof destinations)[number];
export type PapercutObservation = {
  key: string;
  title: string;
  task: string;
  incident: string;
  evidence: string;
  workarounds: string[];
  taskOutcome: string;
  guardrailCandidate?: string;
  suggestedDestination?: PapercutDestination;
};
export type PapercutRecord = PapercutObservation & {
  status: PapercutStatus;
  occurrences: number;
  firstSeenAt: string;
  lastSeenAt: string;
};
export type PapercutFile = { version: 2; records: PapercutRecord[] };
export type RecordOutcome =
  | { kind: "created"; record: PapercutRecord }
  | { kind: "merged"; record: PapercutRecord }
  | { kind: "reopened"; record: PapercutRecord }
  | { kind: "rejected"; reason: string };
export type PapercutStore = ReturnType<typeof createPapercutStore>;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value).sort();
  return (
    actual.length === keys.length &&
    actual.every((key, index) => key === keys.sort()[index])
  );
}

function validString(value: unknown, maximum: number): value is string {
  return (
    typeof value === "string" &&
    value === value.trim() &&
    value.length >= 1 &&
    value.length <= maximum
  );
}

export function normalizeKey(value: string): string {
  return value.trim().toLowerCase();
}

function validKey(value: unknown): value is string {
  return (
    validString(value, 64) &&
    /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(value)
  );
}

export function isPapercutStatus(value: unknown): value is PapercutStatus {
  return (
    typeof value === "string" && statuses.includes(value as PapercutStatus)
  );
}

function validTimestamp(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  const timestamp = new Date(value);
  return (
    !Number.isNaN(timestamp.valueOf()) && timestamp.toISOString() === value
  );
}

function isObservation(value: unknown): value is PapercutObservation {
  if (
    !isObject(value) ||
    !hasExactKeys(
      value,
      [
        "key",
        "title",
        "task",
        "incident",
        "evidence",
        "workarounds",
        "taskOutcome",
        "guardrailCandidate",
        "suggestedDestination",
      ].filter((key) => key in value),
    )
  ) {
    return false;
  }
  return (
    validKey(value.key) &&
    validString(value.title, 120) &&
    validString(value.task, 1_000) &&
    validString(value.incident, 2_000) &&
    validString(value.evidence, 2_000) &&
    Array.isArray(value.workarounds) &&
    value.workarounds.length >= 1 &&
    value.workarounds.length <= 5 &&
    value.workarounds.every((workaround) => validString(workaround, 1_000)) &&
    validString(value.taskOutcome, 1_000) &&
    (value.guardrailCandidate === undefined ||
      validString(value.guardrailCandidate, 1_000)) &&
    (value.suggestedDestination === undefined ||
      destinations.includes(value.suggestedDestination as PapercutDestination))
  );
}

function isRecord(value: unknown): value is PapercutRecord {
  if (
    !isObject(value) ||
    !hasExactKeys(
      value,
      [
        "key",
        "title",
        "task",
        "incident",
        "evidence",
        "workarounds",
        "taskOutcome",
        "guardrailCandidate",
        "suggestedDestination",
        "status",
        "occurrences",
        "firstSeenAt",
        "lastSeenAt",
      ].filter((key) => key in value),
    ) ||
    !isObservation({
      key: value.key,
      title: value.title,
      task: value.task,
      incident: value.incident,
      evidence: value.evidence,
      workarounds: value.workarounds,
      taskOutcome: value.taskOutcome,
      ...(value.guardrailCandidate === undefined
        ? {}
        : { guardrailCandidate: value.guardrailCandidate }),
      ...(value.suggestedDestination === undefined
        ? {}
        : { suggestedDestination: value.suggestedDestination }),
    })
  ) {
    return false;
  }
  const record = value as PapercutRecord;
  return (
    isPapercutStatus(record.status) &&
    Number.isInteger(record.occurrences) &&
    record.occurrences >= 1 &&
    record.occurrences <= MAX_OCCURRENCES &&
    validTimestamp(record.firstSeenAt) &&
    validTimestamp(record.lastSeenAt)
  );
}

function stableFile(file: PapercutFile): PapercutFile {
  return {
    ...file,
    records: [...file.records].sort((a, b) => a.key.localeCompare(b.key)),
  };
}

function serialize(file: PapercutFile): string {
  const text = `${JSON.stringify(stableFile(file), null, 2)}\n`;
  if (Buffer.byteLength(text, "utf8") > MAX_BYTES) {
    throw new Error("Papercut registry exceeds its size limit.");
  }
  return text;
}

function validateFile(value: unknown): PapercutFile {
  if (
    !isObject(value) ||
    !hasExactKeys(value, ["version", "records"]) ||
    value.version !== VERSION ||
    !Array.isArray(value.records)
  ) {
    throw new Error("Papercut registry has an unsupported version or shape.");
  }
  if (value.records.length > MAX_RECORDS || !value.records.every(isRecord)) {
    throw new Error("Papercut registry contains an invalid record.");
  }
  const keys = new Set<string>();
  for (const record of value.records) {
    const key = normalizeKey(record.key);
    if (keys.has(key)) {
      throw new Error("Papercut registry contains duplicate keys.");
    }
    keys.add(key);
  }
  return value as PapercutFile;
}

export function parsePapercutFile(text: string): PapercutFile {
  if (Buffer.byteLength(text, "utf8") > MAX_BYTES) {
    throw new Error("Papercut registry exceeds its size limit.");
  }
  try {
    return validateFile(JSON.parse(text));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error("Papercut registry contains invalid JSON.");
    }
    throw error;
  }
}

function readRegistry(path: string): PapercutFile {
  if (!existsSync(path)) {
    return { version: VERSION, records: [] };
  }
  const descriptor = openSync(path, "r");
  try {
    const buffer = Buffer.allocUnsafe(MAX_BYTES + 1);
    const bytes = readSync(descriptor, buffer, 0, buffer.length, 0);
    if (bytes > MAX_BYTES) {
      throw new Error("Papercut registry exceeds its size limit.");
    }
    return parsePapercutFile(buffer.toString("utf8", 0, bytes));
  } finally {
    closeSync(descriptor);
  }
}

function atomicWrite(path: string, file: PapercutFile): void {
  const text = serialize(validateFile(file));
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = join(
    dirname(path),
    `.pipkin-papercuts-${process.pid}-${randomUUID()}.tmp`,
  );
  try {
    writeFileSync(temporaryPath, text, "utf8");
    renameSync(temporaryPath, path);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

function queue<T>(path: string, operation: () => Promise<T>): Promise<T> {
  const previous = queues.get(path) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(operation);
  queues.set(path, next);
  void next
    .finally(() => {
      if (queues.get(path) === next) {
        queues.delete(path);
      }
    })
    .catch(() => {});
  return next;
}

function trimObservation(value: PapercutObservation): PapercutObservation {
  return {
    key: value.key.trim(),
    title: value.title.trim(),
    task: value.task.trim(),
    incident: value.incident.trim(),
    evidence: value.evidence.trim(),
    workarounds: value.workarounds.map((workaround) => workaround.trim()),
    taskOutcome: value.taskOutcome.trim(),
    ...(value.guardrailCandidate === undefined
      ? {}
      : { guardrailCandidate: value.guardrailCandidate.trim() }),
    ...(value.suggestedDestination === undefined
      ? {}
      : { suggestedDestination: value.suggestedDestination }),
  };
}

function validateObservation(value: unknown): PapercutObservation | undefined {
  if (
    !isObject(value) ||
    !hasExactKeys(
      value,
      [
        "key",
        "title",
        "task",
        "incident",
        "evidence",
        "workarounds",
        "taskOutcome",
        "guardrailCandidate",
        "suggestedDestination",
      ].filter((key) => key in value),
    ) ||
    !["key", "title", "task", "incident", "evidence", "taskOutcome"].every(
      (key) => typeof value[key] === "string",
    ) ||
    !Array.isArray(value.workarounds) ||
    !value.workarounds.every((workaround) => typeof workaround === "string") ||
    (value.guardrailCandidate !== undefined &&
      typeof value.guardrailCandidate !== "string")
  ) {
    return undefined;
  }
  const trimmed = trimObservation(value as PapercutObservation);
  return isObservation(trimmed) ? trimmed : undefined;
}

export function createPapercutStore(root: string) {
  const canonicalRoot = realpathSync(root);
  const registryPath = join(canonicalRoot, ".pi", "pipkin", "papercuts.json");
  const lockPath = join(canonicalRoot, ".pi", "pipkin", "papercuts.lock");

  async function initialize(): Promise<void> {
    return queue(registryPath, async () => {
      mkdirSync(dirname(registryPath), { recursive: true });
      const lease = await acquireFileLease(lockPath, {
        timeoutMs: LOCK_WAIT_MS,
      });
      try {
        await ensureGitInfoExclude(canonicalRoot, [
          "/.pi/pipkin/papercuts.json",
          "/.pi/pipkin/papercuts.lock",
        ]);
        if (!existsSync(registryPath)) {
          atomicWrite(registryPath, { version: VERSION, records: [] });
        } else {
          readRegistry(registryPath);
        }
      } finally {
        await lease.release();
      }
    });
  }

  async function mutate<T>(
    operation: (file: PapercutFile) => { file: PapercutFile; result: T },
  ): Promise<T> {
    return queue(registryPath, async () => {
      mkdirSync(dirname(registryPath), { recursive: true });
      const lease = await acquireFileLease(lockPath, {
        timeoutMs: LOCK_WAIT_MS,
      });
      try {
        const { file, result } = operation(readRegistry(registryPath));
        atomicWrite(registryPath, file);
        return result;
      } finally {
        await lease.release();
      }
    });
  }

  return {
    root: canonicalRoot,
    registryPath,
    initialize,
    async load(): Promise<PapercutFile> {
      return readRegistry(registryPath);
    },
    async record(input: unknown): Promise<RecordOutcome> {
      const observation = validateObservation(input);
      if (!observation) {
        return {
          kind: "rejected",
          reason: "Papercut observation fields are invalid.",
        };
      }
      await initialize();
      return mutate<RecordOutcome>((file) => {
        const existing = file.records.find(
          (record) =>
            normalizeKey(record.key) === normalizeKey(observation.key),
        );
        const now = new Date().toISOString();
        if (!existing) {
          if (file.records.length >= MAX_RECORDS) {
            throw new Error("Papercut registry has reached its record limit.");
          }
          const record: PapercutRecord = {
            ...observation,
            status: "open",
            occurrences: 1,
            firstSeenAt: now,
            lastSeenAt: now,
          };
          return {
            file: { version: VERSION, records: [...file.records, record] },
            result: { kind: "created" as const, record },
          };
        }
        if (existing.occurrences >= MAX_OCCURRENCES) {
          throw new Error("Papercut occurrence limit has been reached.");
        }
        const record: PapercutRecord = {
          ...observation,
          key: existing.key,
          title: existing.title,
          status: "open",
          occurrences: existing.occurrences + 1,
          firstSeenAt: existing.firstSeenAt,
          lastSeenAt: now,
        };
        return {
          file: {
            version: VERSION,
            records: file.records.map((candidate) =>
              candidate.key === existing.key ? record : candidate,
            ),
          },
          result: {
            kind:
              existing.status === "closed"
                ? ("reopened" as const)
                : ("merged" as const),
            record,
          },
        };
      });
    },
    async close(key: unknown): Promise<PapercutRecord> {
      const normalized = typeof key === "string" ? normalizeKey(key) : "";
      if (!validKey(normalized)) {
        throw new Error("Papercut key is invalid.");
      }
      return mutate((file) => {
        const found = file.records.find(
          (record) => normalizeKey(record.key) === normalized,
        );
        if (!found) {
          throw new Error("Papercut finding was not found.");
        }
        const record = { ...found, status: "closed" as const };
        return {
          file: {
            version: VERSION,
            records: file.records.map((candidate) =>
              candidate.key === found.key ? record : candidate,
            ),
          },
          result: record,
        };
      });
    },
  };
}

export async function createPapercutStoreForCwd(
  cwd: string,
): Promise<PapercutStore> {
  return createPapercutStore(await gitPrimaryWorktreeRoot(cwd));
}
