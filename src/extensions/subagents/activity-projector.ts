import {
  ACTIVITY_DETAIL_BYTE_LIMIT,
  ACTIVITY_TEXT_BYTE_LIMIT,
  createActivityPublisher,
  type ActivityPublisher,
  type ActivityState,
} from "#ui/activity";
import { formatCompactTokens } from "#lib/ui/metrics";
import type { EventBus } from "@earendil-works/pi-coding-agent";
import type {
  RuntimeOwner,
  RuntimeSnapshot,
  SubagentRuntime,
} from "./runtime.js";

type Notify = (message: string, level: "warning") => void;

export class SubagentActivityProjector {
  #publisher: ActivityPublisher | undefined;
  #unsubscribe: (() => void) | undefined;
  #published = new Set<string>();
  #notifiedFailures = new Set<string>();

  constructor(
    private readonly runtime: SubagentRuntime,
    private readonly events: EventBus,
  ) {}

  start(notify?: Notify): void {
    this.dispose();
    this.#publisher = createActivityPublisher(this.events, "subagents");
    this.#unsubscribe = this.runtime.subscribeSnapshots(() =>
      this.publish(notify),
    );
    this.publish(notify);
  }

  dispose(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    this.#publisher?.dispose();
    this.#publisher = undefined;
    this.#published.clear();
    this.#notifiedFailures.clear();
  }

  private publish(notify: Notify | undefined): void {
    const publisher = this.#publisher;
    if (!publisher) {
      return;
    }
    const snapshots = this.runtime
      .snapshots({ includeNested: true })
      .filter((snapshot) => snapshot.rosterVisibility === "show");
    for (const snapshot of snapshots) {
      this.notifyDetachedFailure(snapshot, notify);
    }
    const visible = snapshots.filter((snapshot) => active(snapshot.status));
    const ids = new Set(visible.map((snapshot) => snapshot.id));
    const next = new Set(visible.map((snapshot) => snapshot.id));
    for (const id of this.#published) {
      if (!next.has(id)) {
        publisher.remove(id);
      }
    }
    for (const snapshot of visible) {
      const detail = safeDetail(snapshot);
      const context = snapshot.health?.contextUsage?.tokens;
      publisher.upsert({
        id: snapshot.id,
        ...parentIdentity(snapshot.owner, ids),
        label: agentLabel(snapshot),
        title: activityTitle(snapshot),
        ...(detail ? { detail } : {}),
        ...(typeof context === "number"
          ? { metric: `${formatCompactTokens(context)} context` }
          : {}),
        state: activityState(snapshot),
        ...(timestamp(snapshot.timestamps.startedAt) === undefined
          ? {}
          : { startedAt: timestamp(snapshot.timestamps.startedAt) }),
        updatedAt: timestamp(snapshot.timestamps.updatedAt) ?? Date.now(),
      });
    }
    this.#published = next;
  }

  private notifyDetachedFailure(
    snapshot: RuntimeSnapshot,
    notify: Notify | undefined,
  ): void {
    if (
      !notify ||
      snapshot.status !== "failed" ||
      snapshot.owner !== "public-tool" ||
      this.#notifiedFailures.has(snapshot.id)
    ) {
      return;
    }
    this.#notifiedFailures.add(snapshot.id);
    notify(
      `Managed subagent ${snapshot.id} failed: ${bounded(snapshot.error ?? "failed.", 180)}`,
      "warning",
    );
  }
}

function active(status: RuntimeSnapshot["status"]): boolean {
  return status === "queued" || status === "running";
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
  if (snapshot.status === "queued") {
    return "queued";
  }
  return snapshot.health?.pendingSteering ? "waiting" : "running";
}

function agentLabel(snapshot: RuntimeSnapshot): string {
  if (typeof snapshot.owner === "object" && snapshot.owner.kind === "nested") {
    return `Agent · ${bounded(snapshot.owner.tool, 80)}`;
  }
  return `Agent · ${bounded(snapshot.type, 80)}`;
}

function activityTitle(snapshot: RuntimeSnapshot): string {
  const description = bounded(snapshot.description, 240);
  if (description) {
    return description;
  }
  if (typeof snapshot.owner === "object" && snapshot.owner.kind === "nested") {
    return "Nested agent";
  }
  return `${bounded(snapshot.type, 80)} agent`;
}

function safeDetail(snapshot: RuntimeSnapshot): string | undefined {
  const pending = snapshot.health?.pendingSteering;
  if (pending) {
    return `${pending} guidance pending`;
  }
  return snapshot.health?.lastAssistantText
    ? bounded(
        snapshot.health.lastAssistantText,
        480,
        ACTIVITY_DETAIL_BYTE_LIMIT,
      )
    : undefined;
}

function timestamp(value: string | undefined): number | undefined {
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

function bounded(
  value: string,
  length: number,
  byteLimit = ACTIVITY_TEXT_BYTE_LIMIT,
): string {
  const compact = value.replace(/\p{C}/gu, " ").replace(/\s+/g, " ").trim();
  const characters = Array.from(compact);
  if (characters.length <= length && Buffer.byteLength(compact) <= byteLimit) {
    return compact;
  }
  const retained = characters.slice(0, Math.max(0, length - 1));
  while (
    retained.length > 0 &&
    Buffer.byteLength(`${retained.join("")}…`) > byteLimit
  ) {
    retained.pop();
  }
  return `${retained.join("")}…`;
}
