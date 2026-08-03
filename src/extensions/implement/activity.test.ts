import { describe, expect, it, vi } from "vitest";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { ACTIVITY_CHANNEL, type ActivityPublisher } from "#ui/activity";
import { ActivityStore } from "../ui/activity-store.js";
import { createImplementActivity } from "./activity.js";
import type { RunState } from "./store.js";

function state(
  source: Record<string, { id: string; phase: string; taskIds: string[] }> = {},
  overall: Record<string, { repairId: string; phase: string }> = {},
  runId = "run",
): RunState {
  return {
    run: { id: runId },
    tasks: {},
    workstreams: { source, overall },
    phase: "executing",
  } as unknown as RunState;
}

function fakePublisher(
  remove: ActivityPublisher["remove"] = vi.fn(() => true),
): ActivityPublisher & {
  upsert: ReturnType<typeof vi.fn<ActivityPublisher["upsert"]>>;
  remove: ActivityPublisher["remove"];
  dispose: ReturnType<typeof vi.fn<ActivityPublisher["dispose"]>>;
} {
  return {
    upsert: vi.fn(() => true),
    remove,
    clear: vi.fn(() => true),
    dispose: vi.fn(),
  };
}

describe("Implement Activity projector", () => {
  it("uses distinct bounded IDs for maximum-length source and repair lanes", () => {
    const events = createEventBus();
    const store = new ActivityStore();
    events.on(ACTIVITY_CHANNEL, (event) => store.accept(event));
    const id = `a${"b".repeat(63)}`;
    const activity = createImplementActivity(events, {} as never);

    activity.update(
      state(
        { [id]: { id, phase: "implementing", taskIds: [] } },
        { [id]: { repairId: id, phase: "implementing" } },
      ),
    );

    const children = store.records.filter((record) => record.parent);
    expect(children).toHaveLength(2);
    expect(new Set(children.map((record) => record.id)).size).toBe(2);
    expect(children.every((record) => record.id.length <= 64)).toBe(true);
  });

  it("collapses dependency-skipped lanes while retaining failures", () => {
    const events = createEventBus();
    const store = new ActivityStore();
    events.on(ACTIVITY_CHANNEL, (event) => store.accept(event));
    const activity = createImplementActivity(events, {} as never);

    activity.update(
      state({
        skipped: { id: "skipped", phase: "dependency_skipped", taskIds: [] },
        failed: { id: "failed", phase: "failed", taskIds: [] },
      }),
    );

    const children = store.records.filter((record) => record.parent);
    expect(children).toHaveLength(1);
    expect(children[0]).toMatchObject({ state: "attention" });
  });

  it.each([
    ["rejected", () => false],
    [
      "throwing",
      () => {
        throw new Error("remove failed");
      },
    ],
  ])("retries %s removals until they succeed", (_kind, firstRemoval) => {
    const remove = vi
      .fn<ActivityPublisher["remove"]>()
      .mockImplementationOnce(firstRemoval)
      .mockReturnValue(true);
    const publisher = fakePublisher(remove);
    const activity = createImplementActivity(
      {} as never,
      {} as never,
      publisher,
    );
    activity.update(
      state({ lane: { id: "lane", phase: "implementing", taskIds: [] } }),
    );
    const childId = publisher.upsert.mock.calls
      .map(([published]) => published)
      .find((published) => published.parent)?.id;

    activity.update(state());
    activity.update(state());
    activity.update(state());

    expect(childId).toBeDefined();
    expect(remove).toHaveBeenCalledTimes(2);
    expect(remove).toHaveBeenNthCalledWith(1, childId);
    expect(remove).toHaveBeenNthCalledWith(2, childId);
  });

  it("removes stopped and replaced IDs once after accepted removal", () => {
    const publisher = fakePublisher();
    const activity = createImplementActivity(
      {} as never,
      {} as never,
      publisher,
    );
    activity.update(
      state({ lane: { id: "lane", phase: "implementing", taskIds: [] } }),
    );
    const firstIds = publisher.upsert.mock.calls.map(
      ([published]) => published.id,
    );

    activity.update(
      state(
        { lane: { id: "lane", phase: "stopped", taskIds: [] } },
        {},
        "replacement",
      ),
    );
    activity.update(
      state(
        { lane: { id: "lane", phase: "stopped", taskIds: [] } },
        {},
        "replacement",
      ),
    );

    expect(publisher.remove).toHaveBeenCalledTimes(2);
    expect(new Set(vi.mocked(publisher.remove).mock.calls.flat())).toEqual(
      new Set(firstIds),
    );
  });

  it("shuts down idempotently and ignores later updates", () => {
    const publisher = fakePublisher();
    const activity = createImplementActivity(
      {} as never,
      {} as never,
      publisher,
    );
    activity.update(state());
    const publishedBeforeShutdown = publisher.upsert.mock.calls.length;

    activity.clear();
    activity.clear();
    activity.update(state());

    expect(publisher.dispose).toHaveBeenCalledOnce();
    expect(publisher.upsert).toHaveBeenCalledTimes(publishedBeforeShutdown);
  });
});
