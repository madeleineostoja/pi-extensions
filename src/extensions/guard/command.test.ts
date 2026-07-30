import { describe, expect, it } from "vitest";
import { createGuardRuntimeState } from "./state.js";
import { guardMenuDetail } from "./command.js";

function state() {
  return createGuardRuntimeState();
}

describe("Guard menu detail", () => {
  it("reports healthy and locally disabled managed boundary state", () => {
    const runtime = state();
    runtime.setBackendHealth({ kind: "healthy", path: "/managed/nono" });

    expect(guardMenuDetail(runtime, true)).toContain("Managed Nono");
    expect(guardMenuDetail(runtime, true)).toContain("/managed/nono: healthy");
    expect(guardMenuDetail(runtime, true)).toContain(
      "Protected-read approvals: none",
    );
    expect(guardMenuDetail(runtime, true)).toContain(
      "Semantic confirmation: enabled",
    );

    runtime.setBoundaryEnabled(false);
    expect(guardMenuDetail(runtime, true)).toContain(
      "Filesystem boundary is off",
    );
    expect(guardMenuDetail(runtime, true)).toContain("/managed/nono: healthy");
  });

  it("reports unhealthy recovery guidance and current approval state", () => {
    const runtime = state();
    runtime.setBackendHealth({ kind: "tools-only", reason: "missing" });
    runtime.addGrant({
      path: "/secret",
      access: "read",
      kind: "file",
      effects: ["protected-read"],
    });
    runtime.setSemanticConfirmationEnabled(false);

    const detail = guardMenuDetail(runtime, true);
    expect(detail).toContain("unhealthy");
    expect(detail).toContain("npm install");
    expect(detail).toContain("Protected-read approvals: 1");
    expect(detail).toContain("Semantic confirmation: disabled");
  });

  it("keeps unsupported platforms local while retaining approval state", () => {
    const runtime = state();
    runtime.addGrant({
      path: "/secret",
      access: "read",
      kind: "file",
      effects: ["protected-read"],
    });

    const detail = guardMenuDetail(runtime, false);
    expect(detail).toContain("local Bash");
    expect(detail).toContain("Protected-read approvals: 1");
    expect(detail).toContain("Semantic confirmation: enabled");
    expect(detail).not.toContain("Managed Nono");
  });
});
