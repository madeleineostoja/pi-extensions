import { afterEach, describe, expect, it } from "vitest";
import {
  createLifecycleFixture,
  type LifecycleFixture,
} from "./lifecycle-test-support.js";
import { runMarkdown } from "./run-surface.js";

const fixtures: LifecycleFixture[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    fixture.dispose();
  }
});

describe("Implement run surface", () => {
  it("separates a concise overview from complete retained details", async () => {
    const fixture = await createLifecycleFixture();
    fixtures.push(fixture);
    const state = fixture.store.read();

    const overview = runMarkdown(fixture.root, state, "overview");
    const details = runMarkdown(fixture.root, state, "details");

    expect(overview).toContain("## Overview");
    expect(overview).not.toContain("## Paths");
    expect(overview).not.toContain("## Workstreams");
    expect(details).toContain("## Workstreams");
    expect(details).toContain("## Attention");
    expect(details).toContain("## Publication");
    expect(details).toContain("## Paths");
    expect(details).toContain("Planner attempt:");
    expect(details).toContain("Execution plan:");
    expect(details).toContain("Source corpus:");
  });
});
