import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// Mock node:child_process before importing the module under test
vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
}));

import * as cp from "node:child_process";
import {
  detectMusl,
  isSupportedPlatform,
  resolveNonoPath,
  checkNonoVersion,
  pinnedVersion,
} from "../binary.js";

// ---------------------------------------------------------------------------
// detectMusl
// ---------------------------------------------------------------------------

describe("detectMusl", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns false on non-Linux platforms", () => {
    vi.stubGlobal("process", { ...process, platform: "darwin", arch: "arm64" });
    expect(detectMusl()).toBe(false);
  });

  it("returns false on Linux with glibcVersionRuntime defined", () => {
    const fakeReport = { header: { glibcVersionRuntime: "2.35" } };
    vi.stubGlobal("process", {
      ...process,
      platform: "linux",
      arch: "x64",
      report: { getReport: () => fakeReport },
    });
    expect(detectMusl()).toBe(false);
  });

  it("returns true on Linux with glibcVersionRuntime undefined (musl)", () => {
    const fakeReport = { header: {} };
    vi.stubGlobal("process", {
      ...process,
      platform: "linux",
      arch: "x64",
      report: { getReport: () => fakeReport },
    });
    expect(detectMusl()).toBe(true);
  });

  it("returns true on Linux when report.header is an empty object", () => {
    vi.stubGlobal("process", {
      ...process,
      platform: "linux",
      arch: "x64",
      report: { getReport: () => ({ header: Object.create(null) }) },
    });
    expect(detectMusl()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// isSupportedPlatform
// ---------------------------------------------------------------------------

describe("isSupportedPlatform", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns true for darwin arm64", () => {
    vi.stubGlobal("process", { ...process, platform: "darwin", arch: "arm64" });
    expect(isSupportedPlatform()).toBe(true);
  });

  it("returns true for darwin x64", () => {
    vi.stubGlobal("process", { ...process, platform: "darwin", arch: "x64" });
    expect(isSupportedPlatform()).toBe(true);
  });

  it("returns false for win32", () => {
    vi.stubGlobal("process", { ...process, platform: "win32", arch: "x64" });
    expect(isSupportedPlatform()).toBe(false);
  });

  it("returns false for freebsd", () => {
    vi.stubGlobal("process", { ...process, platform: "freebsd", arch: "x64" });
    expect(isSupportedPlatform()).toBe(false);
  });

  it("returns true for linux glibc x64", () => {
    const fakeReport = { header: { glibcVersionRuntime: "2.35" } };
    vi.stubGlobal("process", {
      ...process,
      platform: "linux",
      arch: "x64",
      report: { getReport: () => fakeReport },
    });
    expect(isSupportedPlatform()).toBe(true);
  });

  it("returns false for linux musl x64", () => {
    const fakeReport = { header: {} };
    vi.stubGlobal("process", {
      ...process,
      platform: "linux",
      arch: "x64",
      report: { getReport: () => fakeReport },
    });
    expect(isSupportedPlatform()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// resolveNonoPath — pure resolver, each branch controlled via tmp filesystem
// ---------------------------------------------------------------------------

describe("resolveNonoPath", () => {
  let tmpDir: string;
  let fakePkgRoot: string;
  let fakeBinDir: string;
  let pathDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-binary-test-"));
    fakePkgRoot = path.join(tmpDir, "pkg");
    fakeBinDir = path.join(fakePkgRoot, "bin");
    pathDir = path.join(tmpDir, "pathdir");
    fs.mkdirSync(fakeBinDir, { recursive: true });
    fs.mkdirSync(pathDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns the pkg-root binary when it is executable", () => {
    const pkgBin = path.join(fakeBinDir, "nono");
    fs.writeFileSync(pkgBin, "#!/bin/sh\necho nono 0.57.0");
    fs.chmodSync(pkgBin, 0o755);

    const result = resolveNonoPath(fakePkgRoot, pathDir);
    expect(result).toBe(pkgBin);
  });

  it("falls back to PATH when pkg-root binary is absent", () => {
    const pathBin = path.join(pathDir, "nono");
    fs.writeFileSync(pathBin, "#!/bin/sh\necho nono 0.57.0");
    fs.chmodSync(pathBin, 0o755);

    const result = resolveNonoPath(fakePkgRoot, pathDir);
    expect(result).toBe(pathBin);
  });

  it("returns null when neither pkg-root nor PATH has nono", () => {
    const result = resolveNonoPath(fakePkgRoot, pathDir);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// checkNonoVersion
// ---------------------------------------------------------------------------

describe("checkNonoVersion", () => {
  beforeEach(() => {
    vi.mocked(cp.execFileSync).mockReset();
  });

  it("calls notify with warning when version mismatches", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(cp.execFileSync).mockReturnValue("nono v99.0.0\n" as any);
    const notify = vi.fn();
    checkNonoVersion("/fake/nono", notify);
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining("version mismatch"),
      "warning"
    );
  });

  it("does not call notify when versions match the pinned version", () => {
    const pinned = pinnedVersion();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(cp.execFileSync).mockReturnValue(`nono v${pinned}\n` as any);
    const notify = vi.fn();
    checkNonoVersion("/fake/nono", notify);
    expect(notify).not.toHaveBeenCalled();
  });

  it("does not call notify when version check throws (binary not runnable)", () => {
    vi.mocked(cp.execFileSync).mockImplementation(() => {
      throw new Error("not found");
    });
    const notify = vi.fn();
    checkNonoVersion("/fake/nono", notify);
    expect(notify).not.toHaveBeenCalled();
  });
});
