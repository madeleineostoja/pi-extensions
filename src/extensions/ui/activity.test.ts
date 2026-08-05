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

const theme = {
  fg: (_tone: string, text: string) => text,
  bold: (text: string) => text,
} as never;

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

  it("rejects malformed events, cycles, and excess active records", () => {
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

  it("removes final active work immediately", () => {
    const events = createEventBus();
    const store = new ActivityStore();
    events.on(ACTIVITY_CHANNEL, (event) => store.accept(event));
    const publisher = createActivityPublisher(events, "x");
    publisher.upsert(record("running", { startedAt: Date.now() }));
    expect(store.records).toHaveLength(1);
    publisher.remove("running");
    expect(store.records).toEqual([]);
  });

  it("repaints quiet timed work and stops after removal", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2024-01-01T00:00:00.000Z"));
      const store = new ActivityStore();
      const notify = vi.fn();
      store.subscribe(notify);
      store.accept({
        version: 1,
        source: "x",
        generation: "g",
        operation: "replace",
      });
      notify.mockClear();
      store.accept({
        version: 1,
        source: "x",
        generation: "g",
        operation: "upsert",
        record: record("quiet", { startedAt: Date.now() }),
      });
      notify.mockClear();

      vi.advanceTimersByTime(499);
      expect(notify).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(notify).toHaveBeenCalledOnce();

      notify.mockClear();
      store.accept({
        version: 1,
        source: "x",
        generation: "g",
        operation: "remove",
        id: "quiet",
      });
      notify.mockClear();
      vi.advanceTimersByTime(2_000);
      expect(notify).not.toHaveBeenCalled();
      store.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects terminal states and oversized or unsafe fields", () => {
    expect(validateActivityRecord(record("x", { state: "failed" }))).toBe(
      false,
    );
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
  });

  it("keeps hierarchy, details, overflow, and ANSI-safe width bounded", () => {
    const store = new ActivityStore();
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
        record: record(`root${index}`, { updatedAt: 1 }),
      });
    }
    store.accept({
      version: 1,
      source: "x",
      generation: "g",
      operation: "upsert",
      record: record("child", {
        parent: { source: "x", id: "root0" },
        detail: "reading registration paths",
        metric: "82k context",
        updatedAt: 1,
      }),
    });
    const lines = renderActivity(store.records, 24, theme, Date.now());
    expect(lines.join("\n")).toContain("reading");
    expect(lines.join("\n")).toContain("… 2 more");
    expect(lines.every((line) => visibleWidth(line) <= 24)).toBe(true);
  });
});
