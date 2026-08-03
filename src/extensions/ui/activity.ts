import type { EventBus } from "@earendil-works/pi-coding-agent";

export const ACTIVITY_CHANNEL = "pipkin:ui:activity:v1";
export const ACTIVITY_VERSION = 1;
export const ACTIVITY_SETTLEMENT_MS = 5_000;
export const ACTIVITY_SOURCE_CAPACITY = 64;
export const ACTIVITY_HOST_CAPACITY = 128;

const SOURCE_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
const ID_PATTERN = /^[a-zA-Z][a-zA-Z0-9._-]{0,63}$/;
export const ACTIVITY_TEXT_CODEPOINT_LIMIT = 240;
export const ACTIVITY_TEXT_BYTE_LIMIT = 960;
export const ACTIVITY_DETAIL_CODEPOINT_LIMIT = 480;
export const ACTIVITY_DETAIL_BYTE_LIMIT = 1_920;
export const ACTIVITY_TIMESTAMP_MAX = 8_640_000_000_000;
export const ACTIVITY_PROGRESS_MAX = 1_000_000_000;
const generationPrefix = `${Date.now().toString(36)}-`;
let nextGeneration = 1;

export type ActivityIdentity = { source: string; id: string };
export type ActivityState =
  | "queued"
  | "running"
  | "waiting"
  | "attention"
  | "completed"
  | "failed"
  | "stopped";
export type ActivityRecord = {
  id: string;
  parent?: ActivityIdentity;
  label: string;
  title: string;
  detail?: string;
  state: ActivityState;
  progress?: { completed: number; total: number };
  startedAt?: number;
  updatedAt: number;
};

type ActivityEventBase = {
  version: 1;
  source: string;
  generation: string;
};
export type ActivityEvent =
  | (ActivityEventBase & { operation: "replace" })
  | (ActivityEventBase & { operation: "upsert"; record: ActivityRecord })
  | (ActivityEventBase & { operation: "remove"; id: string })
  | (ActivityEventBase & { operation: "clear" });

export type ActivityPublisher = {
  upsert(record: ActivityRecord): boolean;
  remove(id: string): boolean;
  clear(): boolean;
  dispose(): void;
};

function hasOnlyKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validText(
  value: unknown,
  codepointMaximum = ACTIVITY_TEXT_CODEPOINT_LIMIT,
  byteMaximum = ACTIVITY_TEXT_BYTE_LIMIT,
): value is string {
  return (
    typeof value === "string" &&
    Array.from(value).length > 0 &&
    Array.from(value).length <= codepointMaximum &&
    Buffer.byteLength(value) <= byteMaximum &&
    !/\p{C}/u.test(value)
  );
}

function validTimestamp(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= ACTIVITY_TIMESTAMP_MAX
  );
}

function validProgressCount(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= ACTIVITY_PROGRESS_MAX
  );
}

export function validateActivityIdentity(
  value: unknown,
): value is ActivityIdentity {
  return (
    isObject(value) &&
    hasOnlyKeys(value, ["source", "id"]) &&
    typeof value.source === "string" &&
    SOURCE_PATTERN.test(value.source) &&
    typeof value.id === "string" &&
    ID_PATTERN.test(value.id)
  );
}

export function validateActivityRecord(
  value: unknown,
): value is ActivityRecord {
  if (
    !isObject(value) ||
    !hasOnlyKeys(value, [
      "id",
      "parent",
      "label",
      "title",
      "detail",
      "state",
      "progress",
      "startedAt",
      "updatedAt",
    ])
  ) {
    return false;
  }
  if (
    typeof value.id !== "string" ||
    !ID_PATTERN.test(value.id) ||
    !validText(value.label) ||
    !validText(value.title) ||
    ![
      "queued",
      "running",
      "waiting",
      "attention",
      "completed",
      "failed",
      "stopped",
    ].includes(value.state as string) ||
    !validTimestamp(value.updatedAt)
  ) {
    return false;
  }
  if (
    value.detail !== undefined &&
    !validText(
      value.detail,
      ACTIVITY_DETAIL_CODEPOINT_LIMIT,
      ACTIVITY_DETAIL_BYTE_LIMIT,
    )
  ) {
    return false;
  }
  if (value.parent !== undefined && !validateActivityIdentity(value.parent)) {
    return false;
  }
  if (value.startedAt !== undefined && !validTimestamp(value.startedAt)) {
    return false;
  }
  if (value.progress !== undefined) {
    const progress = isObject(value.progress) ? value.progress : undefined;
    if (
      !progress ||
      !hasOnlyKeys(progress, ["completed", "total"]) ||
      !validProgressCount(progress.completed) ||
      !validProgressCount(progress.total) ||
      progress.total < 1 ||
      progress.completed > progress.total
    ) {
      return false;
    }
  }
  return true;
}

export function validateActivityEvent(value: unknown): value is ActivityEvent {
  if (
    !isObject(value) ||
    value.version !== ACTIVITY_VERSION ||
    !validText(value.source, 32, 32) ||
    !SOURCE_PATTERN.test(value.source) ||
    !validText(value.generation, 128, 128)
  ) {
    return false;
  }
  if (value.operation === "replace" || value.operation === "clear") {
    return hasOnlyKeys(value, ["version", "source", "generation", "operation"]);
  }
  if (value.operation === "remove") {
    return (
      hasOnlyKeys(value, [
        "version",
        "source",
        "generation",
        "operation",
        "id",
      ]) &&
      typeof value.id === "string" &&
      ID_PATTERN.test(value.id)
    );
  }
  return (
    value.operation === "upsert" &&
    hasOnlyKeys(value, [
      "version",
      "source",
      "generation",
      "operation",
      "record",
    ]) &&
    validateActivityRecord(value.record)
  );
}

export function createActivityPublisher(
  events: EventBus,
  source: string,
): ActivityPublisher {
  if (!SOURCE_PATTERN.test(source)) {
    throw new TypeError("Activity source is invalid");
  }
  const generation = `${generationPrefix}${nextGeneration++}`;
  let enabled = true;
  const emit = (event: ActivityEvent): boolean => {
    if (!enabled) {
      return false;
    }
    try {
      events.emit(ACTIVITY_CHANNEL, event);
      return true;
    } catch {
      return false;
    }
  };
  emit({ version: 1, source, generation, operation: "replace" });
  return {
    upsert(record) {
      if (!enabled || !validateActivityRecord(record)) {
        return false;
      }
      return emit({
        version: 1,
        source,
        generation,
        operation: "upsert",
        record,
      });
    },
    remove(id) {
      if (!enabled || !ID_PATTERN.test(id)) {
        return false;
      }
      return emit({ version: 1, source, generation, operation: "remove", id });
    },
    clear() {
      return emit({ version: 1, source, generation, operation: "clear" });
    },
    dispose() {
      if (!enabled) {
        return;
      }
      emit({ version: 1, source, generation, operation: "clear" });
      enabled = false;
    },
  };
}
