import {
  ACTIVITY_HOST_CAPACITY,
  ACTIVITY_SETTLEMENT_MS,
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

type Clock = {
  now(): number;
  setTimeout(
    handler: () => void,
    milliseconds: number,
  ): ReturnType<typeof setTimeout>;
  clearTimeout(timer: ReturnType<typeof setTimeout>): void;
};

const terminal = new Set<ActivityState>(["completed", "stopped"]);
const settled = (record: StoredActivityRecord) => terminal.has(record.state);
const priority = (state: ActivityState): number => {
  if (state === "attention" || state === "failed") {
    return 0;
  }
  if (state === "running" || state === "waiting") {
    return 1;
  }
  if (state === "queued") {
    return 2;
  }
  return 3;
};

function qualified(identity: ActivityIdentity): string {
  return `${identity.source}:${identity.id}`;
}

export class ActivityStore {
  #records = new Map<string, StoredActivityRecord>();
  #generations = new Map<string, string>();
  #listeners = new Set<() => void>();
  #timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly clock: Clock = {
      now: () => Date.now(),
      setTimeout,
      clearTimeout,
    },
  ) {}

  get records(): StoredActivityRecord[] {
    if (this.#expire()) {
      this.#notify();
    }
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
      this.#changed();
      return true;
    }
    if (this.#generations.get(event.source) !== event.generation) {
      return false;
    }
    if (event.operation === "clear") {
      this.#clearSource(event.source);
      this.#changed();
      return true;
    }
    if (event.operation === "remove") {
      const changed = this.#records.delete(`${event.source}:${event.id}`);
      if (changed) {
        this.#changed();
      }
      return changed;
    }
    return this.#upsert(event.source, event.record);
  }

  clear(): void {
    this.#records.clear();
    this.#generations.clear();
    if (this.#timer !== undefined) {
      this.clock.clearTimeout(this.#timer);
    }
    this.#timer = undefined;
    this.#notify();
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
        sourceRecords.length >= ACTIVITY_SOURCE_CAPACITY &&
        !this.#evict(sourceRecords)
      ) {
        return false;
      }
      if (
        this.#records.size >= ACTIVITY_HOST_CAPACITY &&
        !this.#evict([...this.#records.values()])
      ) {
        return false;
      }
    }
    this.#records.set(key, candidate);
    this.#changed();
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

  #evict(records: StoredActivityRecord[]): boolean {
    const eligible = records
      .filter(settled)
      .sort(
        (left, right) =>
          left.updatedAt - right.updatedAt || left.key.localeCompare(right.key),
      )[0];
    if (!eligible) {
      return false;
    }
    this.#records.delete(eligible.key);
    return true;
  }

  #clearSource(source: string): void {
    for (const [key, record] of this.#records) {
      if (record.source === source) {
        this.#records.delete(key);
      }
    }
  }

  #expire(): boolean {
    const now = this.clock.now();
    let changed = false;
    for (const [key, record] of this.#records) {
      if (settled(record) && now >= record.updatedAt + ACTIVITY_SETTLEMENT_MS) {
        this.#records.delete(key);
        changed = true;
      }
    }
    this.#schedule();
    return changed;
  }

  #changed(): void {
    this.#schedule();
    this.#notify();
  }

  #schedule(): void {
    if (this.#timer !== undefined) {
      this.clock.clearTimeout(this.#timer);
    }
    this.#timer = undefined;
    const now = this.clock.now();
    const boundaries = [...this.#records.values()].flatMap((record) => {
      const values: number[] = [];
      if (settled(record)) {
        values.push(record.updatedAt + ACTIVITY_SETTLEMENT_MS);
      }
      if (!settled(record) && record.startedAt !== undefined) {
        values.push(now + 1000 - (now % 1000));
      }
      return values;
    });
    const next = boundaries
      .filter((boundary) => boundary > now)
      .sort((a, b) => a - b)[0];
    if (next !== undefined) {
      this.#timer = this.clock.setTimeout(
        () => {
          this.#expire();
          this.#notify();
        },
        Math.max(1, next - now),
      );
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
      right.updatedAt - left.updatedAt ||
      left.key.localeCompare(right.key);
    const subtreePriority = (record: StoredActivityRecord): number => {
      const own = priority(record.state);
      return (children.get(record.key) ?? []).reduce(
        (best, child) => Math.min(best, subtreePriority(child)),
        own,
      );
    };
    const compareRoots = (
      left: StoredActivityRecord,
      right: StoredActivityRecord,
    ) => subtreePriority(left) - subtreePriority(right) || compare(left, right);
    roots.sort(compareRoots);
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
