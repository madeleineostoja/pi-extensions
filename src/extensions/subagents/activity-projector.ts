import {
  createActivityPublisher,
  type ActivityPublisher,
  type ActivityState,
} from "#ui/activity";
import type { EventBus } from "@earendil-works/pi-coding-agent";
import type {
  RuntimeOwner,
  RuntimeSnapshot,
  SubagentRuntime,
} from "./runtime.js";

export class SubagentActivityProjector {
  #publisher: ActivityPublisher | undefined;
  #unsubscribe: (() => void) | undefined;
  #published = new Set<string>();

  constructor(
    private readonly runtime: SubagentRuntime,
    private readonly events: EventBus,
  ) {}

  start(): void {
    this.dispose();
    this.#publisher = createActivityPublisher(this.events, "subagents");
    this.#unsubscribe = this.runtime.subscribeSnapshots(() => this.publish());
    this.publish();
  }

  dispose(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    this.#publisher?.dispose();
    this.#publisher = undefined;
    this.#published.clear();
  }

  private publish(): void {
    const publisher = this.#publisher;
    if (!publisher) {
      return;
    }
    const visible = this.runtime
      .snapshots({ includeNested: true })
      .filter((snapshot) => snapshot.rosterVisibility === "show");
    const ids = new Set(visible.map((snapshot) => snapshot.id));
    const next = new Set(visible.map((snapshot) => snapshot.id));
    for (const id of this.#published) {
      if (!next.has(id)) {
        publisher.remove(id);
      }
    }
    for (const snapshot of visible) {
      publisher.upsert({
        id: snapshot.id,
        ...parentIdentity(snapshot.owner, ids),
        label: agentLabel(snapshot),
        title: bounded(snapshot.description, 240),
        ...(safeDetail(snapshot) ? { detail: safeDetail(snapshot) } : {}),
        state: activityState(snapshot),
        ...(timestamp(snapshot.timestamps.startedAt) === undefined
          ? {}
          : { startedAt: timestamp(snapshot.timestamps.startedAt) }),
        updatedAt: timestamp(snapshot.timestamps.updatedAt) ?? Date.now(),
      });
    }
    this.#published = next;
  }
}

function parentIdentity(owner: RuntimeOwner, visible: Set<string>) {
  if (
    typeof owner !== "object" ||
    owner.kind !== "nested" ||
    !visible.has(owner.parentId)
  ) {
    return {};
  }
  return { parent: { source: "subagents", id: owner.parentId } };
}

function activityState(snapshot: RuntimeSnapshot): ActivityState {
  if (snapshot.status === "running") {
    return snapshot.health?.pendingSteering ? "attention" : "running";
  }
  if (snapshot.status === "queued") {
    return "queued";
  }
  if (snapshot.status === "completed") {
    return "completed";
  }
  if (snapshot.status === "failed") {
    return "failed";
  }
  return "stopped";
}

function agentLabel(snapshot: RuntimeSnapshot): string {
  if (typeof snapshot.owner === "object" && snapshot.owner.kind === "nested") {
    return `Agent · ${snapshot.owner.tool}`;
  }
  return `Agent · ${bounded(snapshot.type, 80)}`;
}

function safeDetail(snapshot: RuntimeSnapshot): string | undefined {
  const pending = snapshot.health?.pendingSteering;
  return pending ? `${pending} guidance pending` : undefined;
}

function timestamp(value: string | undefined): number | undefined {
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

function bounded(value: string, length: number): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length <= length
    ? compact
    : `${compact.slice(0, length - 1)}…`;
}
