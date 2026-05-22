import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { getBinaryStatusFrom } from "../binary.js";

let tmpDir: string;

function writeMarker(root: string, data: object): void {
  const binDir = path.join(root, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(binDir, ".install-status.json"), JSON.stringify(data), "utf8");
}

function writeBinary(root: string): void {
  const binDir = path.join(root, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  const binPath = path.join(binDir, "nono");
  fs.writeFileSync(binPath, "#!/bin/sh\necho nono 0.57.0\n", "utf8");
  fs.chmodSync(binPath, 0o755);
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-binary-status-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("getBinaryStatus", () => {
  it("marker ok + binary present → kind ok", () => {
    writeMarker(tmpDir, { ok: true, version: "0.57.0", ts: Date.now() });
    writeBinary(tmpDir);

    const status = getBinaryStatusFrom(tmpDir);
    expect(status.kind).toBe("ok");
    if (status.kind === "ok") {
      expect(status.version).toBe("0.57.0");
      expect(status.path).toContain("nono");
    }
  });

  it("marker missing + binary present → install-failed (state drift)", () => {
    writeBinary(tmpDir);

    const status = getBinaryStatusFrom(tmpDir);
    expect(status.kind).toBe("install-failed");
    if (status.kind === "install-failed") {
      expect(status.reason).toBe("marker-missing");
    }
  });

  it("marker ok: false → install-failed with reason propagated", () => {
    writeMarker(tmpDir, {
      ok: false,
      reason: "sha256-mismatch",
      detail: "hash did not match",
      ts: Date.now(),
    });

    const status = getBinaryStatusFrom(tmpDir);
    expect(status.kind).toBe("install-failed");
    if (status.kind === "install-failed") {
      expect(status.reason).toBe("sha256-mismatch");
      expect(status.detail).toBe("hash did not match");
    }
  });

  it("marker ok: true + binary missing → install-failed (state drift)", () => {
    writeMarker(tmpDir, { ok: true, version: "0.57.0", ts: Date.now() });

    const status = getBinaryStatusFrom(tmpDir);
    expect(status.kind).toBe("install-failed");
    if (status.kind === "install-failed") {
      expect(status.reason).toBe("binary-missing-after-ok");
    }
  });

  it("platform-unsupported marker → returned shape matches", () => {
    writeMarker(tmpDir, {
      ok: false,
      reason: "platform-unsupported",
      detail: "win32/x64 is not supported",
      ts: Date.now(),
    });

    const status = getBinaryStatusFrom(tmpDir);
    expect(status.kind).toBe("platform-unsupported");
    if (status.kind === "platform-unsupported") {
      expect(typeof status.platform).toBe("string");
    }
  });
});
