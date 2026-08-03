import { describe, expect, it, vi } from "vitest";
import {
  showProcessesDashboard,
  staticProcessesProjection,
} from "./processes-dashboard.js";

const runtime = {
  snapshots: () => [
    {
      id: "process-1",
      status: "running" as const,
      description: "Build\nthe project",
    },
    {
      id: "process-2",
      status: "completed" as const,
      description: "Run tests",
    },
  ],
};

describe("Processes dashboard", () => {
  it("uses a bounded static notification outside TUI mode", async () => {
    const notify = vi.fn();
    const custom = vi.fn();
    await showProcessesDashboard(() => runtime as never, {
      mode: "json",
      hasUI: false,
      ui: { notify, custom },
    } as never);

    expect(custom).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining("Running processes"),
      "info",
    );
    expect(staticProcessesProjection(runtime as never)).toContain(
      "Build the project",
    );
  });

  it("reports an unavailable runtime without opening custom UI", async () => {
    const notify = vi.fn();
    const custom = vi.fn();
    await showProcessesDashboard(
      () => {
        throw new Error("inactive");
      },
      {
        mode: "tui",
        hasUI: true,
        ui: { notify, custom },
      } as never,
    );

    expect(custom).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(
      "Managed processes are unavailable for this session.",
      "warning",
    );
  });
});
