import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import { decideFsAccess } from "./decide.js";
import type { Policy } from "../policy/defaults.js";

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pi-decide-test-"));
}

function makePolicy(overrides: Partial<Policy["fs"]> = {}): Policy {
  return {
    enabled: true,
    fs: {
      allowRead: [],
      allowWrite: [],
      denyPatterns: [],
      ...overrides,
    },
    network: { mode: "non-interactive-only", allow: [] },
    audit: { log: false, logFile: "/tmp/audit.jsonl" },
    enforcement: { requireKernelSandbox: false },
  };
}

describe("decideFsAccess — symlink resolution", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("symlink to denied target is blocked", async () => {
    const realFile = path.join(tmpDir, "secret.key");
    fs.writeFileSync(realFile, "private");
    const symlink = path.join(tmpDir, "link");
    fs.symlinkSync(realFile, symlink);

    const policy = makePolicy({
      allowRead: [tmpDir],
      denyPatterns: ["**/*.key"],
    });

    const decision = await decideFsAccess(symlink, "read", policy, {
      cwd: tmpDir,
    });
    expect(decision.allow).toBe(false);
    if (!decision.allow) {
      expect(decision.rule).toBe("denyPattern");
    }
  });

  it("symlink pointing to an allowed path (no deny) is allowed", async () => {
    const realFile = path.join(tmpDir, "data.txt");
    fs.writeFileSync(realFile, "safe");
    const symlink = path.join(tmpDir, "link");
    fs.symlinkSync(realFile, symlink);

    const policy = makePolicy({ allowRead: [tmpDir] });

    const decision = await decideFsAccess(symlink, "read", policy, {
      cwd: tmpDir,
    });
    expect(decision.allow).toBe(true);
  });
});

describe("decideFsAccess — non-existent path fallback", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("non-existent path with allowed parent is allowed", async () => {
    const newFile = path.join(tmpDir, "new-file.txt");
    expect(fs.existsSync(newFile)).toBe(false);

    const policy = makePolicy({ allowRead: [tmpDir], allowWrite: [tmpDir] });

    const decision = await decideFsAccess(newFile, "write", policy, {
      cwd: tmpDir,
    });
    expect(decision.allow).toBe(true);
  });

  it("non-existent path with denied parent is blocked", async () => {
    const newFile = path.join(tmpDir, "secrets.key");
    expect(fs.existsSync(newFile)).toBe(false);

    const policy = makePolicy({
      allowRead: [tmpDir],
      allowWrite: [tmpDir],
      denyPatterns: ["**/*.key"],
    });

    const decision = await decideFsAccess(newFile, "write", policy, {
      cwd: tmpDir,
    });
    expect(decision.allow).toBe(false);
    if (!decision.allow) {
      expect(decision.rule).toBe("denyPattern");
    }
  });
});

describe("decideFsAccess — denyPattern precedence", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("denyPattern takes precedence over allowList", async () => {
    const envFile = path.join(tmpDir, ".env");
    fs.writeFileSync(envFile, "SECRET=x");

    const policy = makePolicy({
      allowRead: [tmpDir],
      denyPatterns: ["**/.env"],
    });

    const decision = await decideFsAccess(envFile, "read", policy, {
      cwd: tmpDir,
    });
    expect(decision.allow).toBe(false);
    if (!decision.allow) {
      expect(decision.rule).toBe("denyPattern");
      expect(decision.matchedPattern).toBe("**/.env");
    }
  });
});

describe("decideFsAccess — allowList miss", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("path outside allowRead returns allowList:read rule", async () => {
    const policy = makePolicy({ allowRead: [tmpDir] });

    const decision = await decideFsAccess("/etc/passwd", "read", policy, {
      cwd: tmpDir,
    });
    expect(decision.allow).toBe(false);
    if (!decision.allow) {
      expect(decision.rule).toBe("allowList:read");
    }
  });

  it("path outside allowWrite returns allowList:write rule", async () => {
    const policy = makePolicy({ allowWrite: [tmpDir] });

    const decision = await decideFsAccess("/etc/hosts", "write", policy, {
      cwd: tmpDir,
    });
    expect(decision.allow).toBe(false);
    if (!decision.allow) {
      expect(decision.rule).toBe("allowList:write");
    }
  });
});

describe("decideFsAccess — stable rule strings", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("deny due to denyPattern emits rule='denyPattern'", async () => {
    const file = path.join(tmpDir, ".env");
    fs.writeFileSync(file, "x");
    const policy = makePolicy({
      allowRead: [tmpDir],
      denyPatterns: ["**/.env"],
    });

    const decision = await decideFsAccess(file, "read", policy, {
      cwd: tmpDir,
    });
    expect(decision.allow).toBe(false);
    if (!decision.allow) {
      expect(decision.rule).toBe("denyPattern");
    }
  });

  it("deny due to read allowList miss emits rule='allowList:read'", async () => {
    const policy = makePolicy({ allowRead: [] });

    const decision = await decideFsAccess("/etc/passwd", "read", policy, {
      cwd: tmpDir,
    });
    expect(decision.allow).toBe(false);
    if (!decision.allow) {
      expect(decision.rule).toBe("allowList:read");
    }
  });

  it("deny due to write allowList miss emits rule='allowList:write'", async () => {
    const policy = makePolicy({ allowWrite: [] });

    const decision = await decideFsAccess("/etc/passwd", "write", policy, {
      cwd: tmpDir,
    });
    expect(decision.allow).toBe(false);
    if (!decision.allow) {
      expect(decision.rule).toBe("allowList:write");
    }
  });
});
