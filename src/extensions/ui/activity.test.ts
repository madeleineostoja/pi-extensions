import { describe, expect, it, vi } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import {
  ACTIVITY_CHANNEL,
  ACTIVITY_PROGRESS_MAX,
  ACTIVITY_TEXT_BYTE_LIMIT,
  ACTIVITY_TIMESTAMP_MAX,
  createActivityPublisher,
  validateActivityRecord,
} from "./activity.js";
import { ActivityStore } from "./activity-store.js";
import { renderActivity } from "./activity-widget.js";

const record = (id: string, overrides = {}) => ({
  id,
  label: "Agent",
  title: "A bounded task",
  state: "running" as const,
  updatedAt: 1,
  ...overrides,
});

describe("Activity", () => {
  it("isolates replaced and disposed publisher generations", () => {
    const events = createEventBus();
    const store = new ActivityStore();
    events.on(ACTIVITY_CHANNEL, (event) => store.accept(event));
    const first = createActivityPublisher(events, "subagents");
    expect(first.upsert(record("first"))).toBe(true);
    const second = createActivityPublisher(events, "subagents");
    expect(store.records).toEqual([]);
    expect(first.upsert(record("stale"))).toBe(true);
    expect(store.records).toEqual([]);
    second.upsert(record("current"));
    second.dispose();
    expect(second.upsert(record("after-dispose"))).toBe(false);
    expect(store.records).toEqual([]);
  });

  it("rejects malformed events, cycles, and unreplaceable capacity", () => {
    const store = new ActivityStore();
    expect(
      store.accept({
        version: 1,
        source: "x",
        generation: "g",
        operation: "upsert",
        record: record("x"),
      }),
    ).toBe(false);
    expect(
      store.accept({
        version: 1,
        source: "x",
        generation: "g",
        operation: "replace",
      }),
    ).toBe(true);
    expect(
      store.accept({
        version: 1,
        source: "x",
        generation: "g",
        operation: "upsert",
        record: record("a", { parent: { source: "x", id: "b" } }),
      }),
    ).toBe(true);
    expect(
      store.accept({
        version: 1,
        source: "x",
        generation: "g",
        operation: "upsert",
        record: record("b", { parent: { source: "x", id: "a" } }),
      }),
    ).toBe(false);
    for (let index = 0; index < 63; index += 1) {
      store.accept({
        version: 1,
        source: "x",
        generation: "g",
        operation: "upsert",
        record: record(`n${index}`),
      });
    }
    expect(
      store.accept({
        version: 1,
        source: "x",
        generation: "g",
        operation: "upsert",
        record: record("overflow"),
      }),
    ).toBe(false);
  });

  it("settles terminal rows and repaints at the nearest duration boundary", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(100);
      const store = new ActivityStore();
      const notify = vi.fn();
      store.subscribe(notify);
      store.accept({
        version: 1,
        source: "x",
        generation: "g",
        operation: "replace",
      });
      store.accept({
        version: 1,
        source: "x",
        generation: "g",
        operation: "upsert",
        record: record("running", { startedAt: 100, updatedAt: 100 }),
      });
      notify.mockClear();
      vi.advanceTimersByTime(900);
      expect(notify).toHaveBeenCalledTimes(1);
      store.accept({
        version: 1,
        source: "x",
        generation: "g",
        operation: "upsert",
        record: record("done", { state: "completed", updatedAt: Date.now() }),
      });
      vi.advanceTimersByTime(5_000);
      expect(store.records.map((item) => item.id)).toEqual(["running"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("safely checkpoints accepted far-future timer boundaries", () => {
    let now = 100;
    const scheduled: Array<{ handler: () => void; milliseconds: number }> = [];
    const clock = {
      now: () => now,
      setTimeout: vi.fn((handler: () => void, milliseconds: number) => {
        scheduled.push({ handler, milliseconds });
        return scheduled.length;
      }),
      clearTimeout: vi.fn(),
    };
    const store = new ActivityStore(clock as never);
    store.accept({
      version: 1,
      source: "x",
      generation: "g",
      operation: "replace",
    });
    expect(
      store.accept({
        version: 1,
        source: "x",
        generation: "g",
        operation: "upsert",
        record: record("future", {
          state: "completed",
          updatedAt: ACTIVITY_TIMESTAMP_MAX,
        }),
      }),
    ).toBe(true);
    expect(scheduled.at(-1)?.milliseconds).toBe(2_147_483_647);

    const first = scheduled.at(-1)!;
    now += first.milliseconds;
    first.handler();
    expect(scheduled.at(-1)?.milliseconds).toBe(2_147_483_647);
  });

  it("rejects oversized byte text and unsafe timestamps or progress", () => {
    expect(
      validateActivityRecord(
        record("x", { updatedAt: ACTIVITY_TIMESTAMP_MAX + 1 }),
      ),
    ).toBe(false);
    expect(validateActivityRecord(record("x", { updatedAt: -1 }))).toBe(false);
    expect(
      validateActivityRecord(
        record("x", { progress: { completed: 0.5, total: 1 } }),
      ),
    ).toBe(false);
    expect(
      validateActivityRecord(
        record("x", {
          progress: { completed: 1, total: ACTIVITY_PROGRESS_MAX + 1 },
        }),
      ),
    ).toBe(false);
    expect(
      validateActivityRecord(
        record("x", { title: "😀".repeat(ACTIVITY_TEXT_BYTE_LIMIT) }),
      ),
    ).toBe(false);
    expect(
      validateActivityRecord(
        record("x", { progress: { completed: 1, total: 2 } }),
      ),
    ).toBe(true);
  });

  it("keeps an urgent descendant with its settled ancestor inside the body budget", () => {
    const store = new ActivityStore();
    const now = Date.now();
    store.accept({
      version: 1,
      source: "x",
      generation: "g",
      operation: "replace",
    });
    for (let index = 0; index < 8; index += 1) {
      store.accept({
        version: 1,
        source: "x",
        generation: "g",
        operation: "upsert",
        record: record(`root${index}`, {
          state: "failed",
          updatedAt: now,
        }),
      });
    }
    store.accept({
      version: 1,
      source: "x",
      generation: "g",
      operation: "upsert",
      record: record("settled", {
        state: "completed",
        title: "settled ancestor",
        detail: "ancestor detail",
        updatedAt: now,
      }),
    });
    store.accept({
      version: 1,
      source: "x",
      generation: "g",
      operation: "upsert",
      record: record("urgent", {
        parent: { source: "x", id: "settled" },
        state: "failed",
        title: "urgent child",
        detail: "urgent detail",
        updatedAt: now,
      }),
    });
    const theme = {
      fg: (_tone: string, text: string) => text,
      bold: (text: string) => text,
    } as never;
    const lines = renderActivity(store.records, 24, theme, now);
    expect(lines.join("\n")).toContain("settled");
    expect(lines.join("\n")).toContain("urgent");
    expect(lines.join("\n")).not.toContain("ancestor detail");
    expect(lines.join("\n")).not.toContain("urgent detail");
    expect(lines).toContain("… 2 more");
    expect(lines).toHaveLength(10);
    expect(lines.every((line) => visibleWidth(line) <= 24)).toBe(true);
  });
});
