import { describe, expect, it, vi } from "vitest";
import { createInhibitor, selectInhibitorCommand } from "./inhibitor.js";

describe("selectInhibitorCommand", () => {
  it("selects the host-specific inhibition command", () => {
    expect(selectInhibitorCommand("darwin", 123)).toEqual({
      command: "caffeinate",
      args: ["-i", "-w", "123"],
    });
    expect(selectInhibitorCommand("linux", 123)).toEqual({
      command: "systemd-inhibit",
      args: [
        "--what=idle:sleep",
        "--why=Pipkin session is open",
        "--",
        "tail",
        "--pid",
        "123",
        "-f",
        "/dev/null",
      ],
    });
  });

  it("does not create an inhibitor on unsupported platforms", () => {
    const spawn = vi.fn();
    const inhibitor = createInhibitor({
      platform: "win32",
      spawn: spawn as never,
      log: () => {},
    });

    inhibitor.start();

    expect(spawn).not.toHaveBeenCalled();
  });
});

describe("createInhibitor", () => {
  it("stops the owned child once", () => {
    const child = {
      pid: 456,
      stderr: { on: vi.fn() },
      once: vi.fn(),
      kill: vi.fn(),
    };
    const spawn = vi.fn(() => child);
    const inhibitor = createInhibitor({
      platform: "darwin",
      pid: 123,
      spawn: spawn as never,
      log: () => {},
    });

    inhibitor.start();
    inhibitor.start();
    inhibitor.stop();
    inhibitor.stop();

    expect(spawn).toHaveBeenCalledOnce();
    expect(spawn).toHaveBeenCalledWith("caffeinate", ["-i", "-w", "123"]);
    expect(child.kill).toHaveBeenCalledOnce();
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });
});
