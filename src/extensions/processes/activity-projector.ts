import {
  ACTIVITY_TEXT_BYTE_LIMIT,
  createActivityPublisher,
  type ActivityPublisher,
  type ActivityState,
} from "#ui/activity";
import type { EventBus } from "@earendil-works/pi-coding-agent";
import type { ProcessSnapshot, ProcessRuntime } from "./runtime.js";

export class ProcessActivityProjector {
  #publisher: ActivityPublisher | undefined;
  #unsubscribe: (() => void) | undefined;
  #activityIds = new Map<string, string>();
  #published = new Set<string>();
  #nextActivityId = 1;

  constructor(
    private readonly runtime: ProcessRuntime,
    private readonly events: EventBus,
  ) {}

  start(): void {
    this.dispose();
    this.#publisher = createActivityPublisher(this.events, "processes");
    this.#unsubscribe = this.runtime.subscribe((snapshots) =>
      this.publish(snapshots),
    );
    this.publish(this.runtime.snapshots());
  }

  dispose(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    this.#publisher?.dispose();
    this.#publisher = undefined;
    this.#activityIds.clear();
    this.#published.clear();
    this.#nextActivityId = 1;
  }

  private publish(snapshots: readonly ProcessSnapshot[]): void {
    const publisher = this.#publisher;
    if (!publisher) {
      return;
    }
    const processIds = new Set(snapshots.map((snapshot) => snapshot.id));
    const next = new Set<string>();
    for (const processId of this.#published) {
      const activityId = this.#activityIds.get(processId);
      if (!processIds.has(processId) && activityId) {
        publisher.remove(activityId);
        this.#activityIds.delete(processId);
      }
    }
    for (const snapshot of snapshots) {
      const activityId = this.#activityId(snapshot.id);
      next.add(snapshot.id);
      publisher.upsert({
        id: activityId,
        label: "Process",
        title: bounded(snapshot.description),
        detail: activityDetail(snapshot.status),
        state: activityState(snapshot.status),
        ...(timestamp(snapshot.startedAt) === undefined
          ? {}
          : { startedAt: timestamp(snapshot.startedAt) }),
        updatedAt:
          timestamp(snapshot.endedAt) ??
          timestamp(snapshot.startedAt) ??
          Date.now(),
      });
    }
    this.#published = next;
  }

  #activityId(processId: string): string {
    const existing = this.#activityIds.get(processId);
    if (existing) {
      return existing;
    }
    const activityId = `entry-${this.#nextActivityId++}`;
    this.#activityIds.set(processId, activityId);
    return activityId;
  }
}

function activityState(status: ProcessSnapshot["status"]): ActivityState {
  return (
    {
      running: "running",
      completed: "completed",
      failed: "failed",
      stopped: "stopped",
    } as const
  )[status];
}

function activityDetail(status: ProcessSnapshot["status"]): string {
  return {
    running: "Running",
    completed: "Completed",
    failed: "Failed",
    stopped: "Stopped",
  }[status];
}

function timestamp(value: string | undefined): number | undefined {
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

function bounded(value: string): string {
  const compact = value.replace(/\p{C}/gu, " ").replace(/\s+/g, " ").trim();
  const characters = Array.from(compact);
  if (
    characters.length <= 240 &&
    Buffer.byteLength(compact) <= ACTIVITY_TEXT_BYTE_LIMIT
  ) {
    return compact || "Managed process";
  }
  const retained = characters.slice(0, 239);
  while (
    retained.length > 0 &&
    Buffer.byteLength(`${retained.join("")}…`) > ACTIVITY_TEXT_BYTE_LIMIT
  ) {
    retained.pop();
  }
  return `${retained.join("")}…`;
}
