import { describe, expect, it } from "vitest";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { ACTIVITY_CHANNEL } from "#ui/activity";
import { ActivityStore } from "../ui/activity-store.js";
import { createTemporaryActivity } from "./temporary-activity.js";
import type { RunState } from "./store.js";

function state(
  source: Record<string, { id: string; phase: string; taskIds: string[] }> = {},
  overall: Record<string, { repairId: string; phase: string }> = {},
): RunState {
  return {
    run: { id: "run" },
    tasks: {},
    workstreams: { source, overall },
    phase: "executing",
  } as unknown as RunState;
}

describe("Implement Activity projector", () => {
  it("uses distinct bounded IDs for maximum-length source and repair lanes", () => {
    const events = createEventBus();
    const store = new ActivityStore();
    events.on(ACTIVITY_CHANNEL, (event) => store.accept(event));
    const id = `a${"b".repeat(63)}`;
    const activity = createTemporaryActivity(events, {} as never);

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
    const activity = createTemporaryActivity(events, {} as never);

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
});
