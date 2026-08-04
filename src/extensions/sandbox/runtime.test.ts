import { describe, expect, it, vi } from "vitest";
import { bindSandboxHost, prepareSandboxChild } from "./runtime.js";

function host() {
  return {} as never;
}

describe("Sandbox runtime handoff", () => {
  it("snapshots a disabled parent mode for a child", () => {
    const parent = host();
    const child = host();
    const parentBinding = bindSandboxHost(parent, () => false);
    const pending = prepareSandboxChild(parent, child);
    const childBinding = bindSandboxHost(child, () => true);

    expect(childBinding.inheritedEnabled).toBe(false);
    pending?.dispose();
    childBinding.dispose();
    parentBinding.dispose();
  });

  it("snapshots the requested write mode once with the parent state", () => {
    const parent = host();
    const child = host();
    const parentBinding = bindSandboxHost(parent, () => true);
    prepareSandboxChild(parent, child, "repository-read-only");
    const snapshot = bindSandboxHost(child, () => false).inherited;

    expect(snapshot).toEqual({
      enabled: true,
      writeMode: "repository-read-only",
    });
    expect(bindSandboxHost(child, () => false).inherited).toBeUndefined();
    parentBinding.dispose();
  });

  it("snapshots an enabled parent mode for a child", () => {
    const parent = host();
    const child = host();
    const parentBinding = bindSandboxHost(parent, () => true);
    prepareSandboxChild(parent, child);

    expect(bindSandboxHost(child, () => false).inheritedEnabled).toBe(true);
    parentBinding.dispose();
  });

  it("does not prepare inheritance without a parent binding", () => {
    expect(prepareSandboxChild(host(), host())).toBeUndefined();
  });

  it("captures the parent mode at preparation time", () => {
    const parent = host();
    const child = host();
    let enabled = false;
    const parentBinding = bindSandboxHost(parent, () => enabled);
    prepareSandboxChild(parent, child);
    enabled = true;

    expect(bindSandboxHost(child, () => enabled).inheritedEnabled).toBe(false);
    parentBinding.dispose();
  });

  it("keeps parallel child handoffs isolated", () => {
    const parent = host();
    const firstChild = host();
    const secondChild = host();
    let enabled = false;
    const parentBinding = bindSandboxHost(parent, () => enabled);
    prepareSandboxChild(parent, firstChild);
    enabled = true;
    prepareSandboxChild(parent, secondChild);

    expect(bindSandboxHost(firstChild, () => true).inheritedEnabled).toBe(
      false,
    );
    expect(bindSandboxHost(secondChild, () => false).inheritedEnabled).toBe(
      true,
    );
    parentBinding.dispose();
  });

  it("disposes idempotently and cannot remove a replacement binding", () => {
    const parent = host();
    const first = bindSandboxHost(parent, () => false);
    const second = bindSandboxHost(parent, () => true);
    first.dispose();
    first.dispose();
    const child = host();

    prepareSandboxChild(parent, child);
    expect(bindSandboxHost(child, () => false).inheritedEnabled).toBe(true);
    second.dispose();
    second.dispose();
    expect(prepareSandboxChild(parent, host())).toBeUndefined();
  });

  it("shares the protocol through separate module loads", async () => {
    const parent = host();
    const child = host();
    const parentBinding = bindSandboxHost(parent, () => false);
    vi.resetModules();
    const reloaded = await import("./runtime.js");

    reloaded.prepareSandboxChild(parent, child);
    expect(reloaded.bindSandboxHost(child, () => true).inheritedEnabled).toBe(
      false,
    );
    parentBinding.dispose();
  });
});
