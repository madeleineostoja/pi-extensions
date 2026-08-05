import {
  ACTIVITY_HOST_CAPACITY,
  ACTIVITY_SOURCE_CAPACITY,
  type ActivityEvent,
  type ActivityIdentity,
  type ActivityRecord,
  type ActivityState,
  validateActivityEvent,
} from "./activity.js";

export type StoredActivityRecord = ActivityRecord & {
  source: string;
  key: string;
};

const MAX_TIMER_DELAY_MS = 2_147_483_647;

type Clock = {
  now(): number;
  setTimeout(
    handler: () => void,
    milliseconds: number,
  ): ReturnType<typeof setTimeout>;
  clearTimeout(timer: ReturnType<typeof setTimeout>): void;
};

const priority = (state: ActivityState): number =>
  state === "running" ? 0 : state === "waiting" ? 1 : 2;

function qualified(identity: ActivityIdentity): string {
  return `${identity.source}:${identity.id}`;
}

/** Stores only producer-owned live work. Producers remove settled records. */
export class ActivityStore {
  #records = new Map<string, StoredActivityRecord>();
  #generations = new Map<string, string>();
  #order = new Map<string, number>();
  #nextOrder = 0;
  #listeners = new Set<() => void>();
  #clock: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly clock: Clock = {
      now: () => Date.now(),
      setTimeout,
      clearTimeout,
    },
  ) {}

  get records(): StoredActivityRecord[] {
    return this.#ordered();
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  accept(value: unknown): boolean {
    if (!validateActivityEvent(value)) {
      return false;
    }
    const event = value as ActivityEvent;
    if (event.operation === "replace") {
      this.#generations.set(event.source, event.generation);
      this.#clearSource(event.source);
      this.#notify();
      this.#syncClock();
      return true;
    }
    if (this.#generations.get(event.source) !== event.generation) {
      return false;
    }
    if (event.operation === "clear") {
      this.#clearSource(event.source);
      this.#notify();
      this.#syncClock();
      return true;
    }
    if (event.operation === "remove") {
      const key = `${event.source}:${event.id}`;
      const changed = this.#records.delete(key);
      this.#order.delete(key);
      if (changed) {
        this.#notify();
        this.#syncClock();
      }
      return changed;
    }
    return this.#upsert(event.source, event.record);
  }

  clear(): void {
    this.#records.clear();
    this.#generations.clear();
    this.#order.clear();
    this.#notify();
    this.#syncClock();
  }

  dispose(): void {
    this.clear();
    this.#listeners.clear();
  }

  #upsert(source: string, record: ActivityRecord): boolean {
    const key = `${source}:${record.id}`;
    const existing = this.#records.get(key);
    const candidate: StoredActivityRecord = { ...record, source, key };
    if (
      candidate.parent &&
      (qualified(candidate.parent) === key ||
        this.#wouldCycle(key, candidate.parent))
    ) {
      return false;
    }
    if (!existing) {
      const sourceRecords = [...this.#records.values()].filter(
        (item) => item.source === source,
      );
      if (
        sourceRecords.length >= ACTIVITY_SOURCE_CAPACITY ||
        this.#records.size >= ACTIVITY_HOST_CAPACITY
      ) {
        return false;
      }
    }
    if (!existing) {
      this.#order.set(key, this.#nextOrder++);
    }
    this.#records.set(key, candidate);
    this.#notify();
    this.#syncClock();
    return true;
  }

  #wouldCycle(key: string, parent: ActivityIdentity): boolean {
    const visited = new Set<string>([key]);
    let current: ActivityIdentity | undefined = parent;
    while (current) {
      const currentKey = qualified(current);
      if (visited.has(currentKey)) {
        return true;
      }
      visited.add(currentKey);
      current = this.#records.get(currentKey)?.parent;
    }
    return false;
  }

  #clearSource(source: string): void {
    for (const [key, record] of this.#records) {
      if (record.source === source) {
        this.#records.delete(key);
        this.#order.delete(key);
      }
    }
  }

  #ordered(): StoredActivityRecord[] {
    const records = [...this.#records.values()];
    const byKey = new Map(records.map((record) => [record.key, record]));
    const children = new Map<string, StoredActivityRecord[]>();
    const roots: StoredActivityRecord[] = [];
    for (const record of records) {
      const parentKey = record.parent ? qualified(record.parent) : undefined;
      if (parentKey && byKey.has(parentKey)) {
        const group = children.get(parentKey) ?? [];
        group.push(record);
        children.set(parentKey, group);
      } else {
        roots.push(record);
      }
    }
    const compare = (left: StoredActivityRecord, right: StoredActivityRecord) =>
      priority(left.state) - priority(right.state) ||
      (this.#order.get(left.key) ?? 0) - (this.#order.get(right.key) ?? 0);
    const subtreePriority = (record: StoredActivityRecord): number =>
      (children.get(record.key) ?? []).reduce(
        (best, child) => Math.min(best, subtreePriority(child)),
        priority(record.state),
      );
    roots.sort(
      (left, right) =>
        subtreePriority(left) - subtreePriority(right) || compare(left, right),
    );
    const result: StoredActivityRecord[] = [];
    const add = (record: StoredActivityRecord) => {
      result.push(record);
      for (const child of (children.get(record.key) ?? []).sort(compare)) {
        add(child);
      }
    };
    roots.forEach(add);
    return result;
  }

  #syncClock(): void {
    if (this.#clock !== undefined) {
      this.clock.clearTimeout(this.#clock);
      this.#clock = undefined;
    }
    const now = this.clock.now();
    const delays = [...this.#records.values()].flatMap((record) =>
      record.startedAt === undefined
        ? []
        : [nextDurationBoundary(record.startedAt, now)],
    );
    if (delays.length === 0) {
      return;
    }
    this.#clock = this.clock.setTimeout(
      () => {
        this.#clock = undefined;
        if (
          [...this.#records.values()].some(
            (record) => record.startedAt !== undefined,
          )
        ) {
          this.#notify();
          this.#syncClock();
        }
      },
      Math.min(MAX_TIMER_DELAY_MS, ...delays),
    );
    this.#clock.unref?.();
  }

  #notify(): void {
    for (const listener of Array.from(this.#listeners)) {
      try {
        listener();
      } catch {
        // UI observers cannot alter producer state.
      }
    }
  }
}

function nextDurationBoundary(startedAt: number, now: number): number {
  const firstBoundary = startedAt + 500;
  if (now < firstBoundary) {
    return firstBoundary - now;
  }
  return 1_000 - ((now - firstBoundary) % 1_000);
}
