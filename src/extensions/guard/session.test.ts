import { describe, it, expect } from "vitest";
import { extractPendingCreations, commitPendingCreations } from "./session";

describe("extractPendingCreations", () => {
  it("tracks write tool path", () => {
    const pending = new Map<string, Set<string>>();
    extractPendingCreations(
      "id1",
      "write",
      { path: "foo.ts" },
      "/home/user",
      pending,
    );
    expect(pending.get("id1")).toEqual(new Set(["/home/user/foo.ts"]));
  });

  it("does not track write tool path that already exists", () => {
    const pending = new Map<string, Set<string>>();
    extractPendingCreations(
      "id1",
      "write",
      { path: "/tmp" },
      "/home/user",
      pending,
    );
    expect(pending.has("id1")).toBe(false);
  });

  it("tracks touch command", () => {
    const pending = new Map<string, Set<string>>();
    extractPendingCreations(
      "id1",
      "bash",
      { command: "touch file.txt" },
      "/home/user",
      pending,
    );
    expect(pending.get("id1")).toEqual(new Set(["/home/user/file.txt"]));
  });

  it("tracks mkdir command", () => {
    const pending = new Map<string, Set<string>>();
    extractPendingCreations(
      "id1",
      "bash",
      { command: "mkdir dir" },
      "/home/user",
      pending,
    );
    expect(pending.get("id1")).toEqual(new Set(["/home/user/dir"]));
  });

  it("tracks mkdir -p command", () => {
    const pending = new Map<string, Set<string>>();
    extractPendingCreations(
      "id1",
      "bash",
      { command: "mkdir -p dir/sub" },
      "/home/user",
      pending,
    );
    expect(pending.get("id1")).toEqual(new Set(["/home/user/dir/sub"]));
  });

  it("tracks simple redirect", () => {
    const pending = new Map<string, Set<string>>();
    extractPendingCreations(
      "id1",
      "bash",
      { command: "echo hello > file.txt" },
      "/home/user",
      pending,
    );
    expect(pending.get("id1")).toEqual(new Set(["/home/user/file.txt"]));
  });

  it("does not track redirect to existing file", () => {
    const pending = new Map<string, Set<string>>();
    extractPendingCreations(
      "id1",
      "bash",
      { command: "echo hello > /tmp" },
      "/home/user",
      pending,
    );
    expect(pending.has("id1")).toBe(false);
  });

  it("does not track complex bash", () => {
    const pending = new Map<string, Set<string>>();
    extractPendingCreations(
      "id1",
      "bash",
      { command: "rm file.txt" },
      "/home/user",
      pending,
    );
    expect(pending.has("id1")).toBe(false);
  });
});

describe("commitPendingCreations", () => {
  it("moves pending paths to committed on success", () => {
    const pending = new Map<string, Set<string>>();
    const committed = new Set<string>();
    pending.set("id1", new Set(["/home/user/foo.ts"]));
    commitPendingCreations("id1", pending, committed, false);
    expect(committed.has("/home/user/foo.ts")).toBe(true);
    expect(pending.has("id1")).toBe(false);
  });

  it("discards pending paths on error", () => {
    const pending = new Map<string, Set<string>>();
    const committed = new Set<string>();
    pending.set("id1", new Set(["/home/user/foo.ts"]));
    commitPendingCreations("id1", pending, committed, true);
    expect(committed.has("/home/user/foo.ts")).toBe(false);
    expect(pending.has("id1")).toBe(false);
  });
});
