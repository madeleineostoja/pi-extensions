import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { createGuardRuntimeState } from "./state.js";
import { syncGuardStatus } from "./status.js";

function fixture() {
  const setStatus = vi.fn();
  const ctx = {
    mode: "tui",
    ui: {
      setStatus,
      theme: {
        fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
      },
    },
  } as unknown as ExtensionContext;
  return { ctx, setStatus };
}

describe("Guard status", () => {
  it("colors the sandbox icon while keeping a healthy label muted", () => {
    const state = createGuardRuntimeState();
    state.setBackendHealth({ kind: "healthy", path: "/managed/nono" });
    const { ctx, setStatus } = fixture();

    syncGuardStatus(ctx, state, true);

    expect(setStatus).toHaveBeenCalledWith(
      "pipkin.guard",
      "<success>󰒃</success> <muted>guard</muted>",
    );
  });

  it("warns for a degraded boundary without dropping the icon", () => {
    const state = createGuardRuntimeState();
    state.setBackendHealth({ kind: "tools-only", reason: "missing" });
    const { ctx, setStatus } = fixture();

    syncGuardStatus(ctx, state, true);

    expect(setStatus).toHaveBeenCalledWith(
      "pipkin.guard",
      "<warning>󰒃</warning> <warning>guard: tools-only</warning>",
    );
  });
});
