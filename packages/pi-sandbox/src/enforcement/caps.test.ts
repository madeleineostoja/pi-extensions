import { describe, it, expect, beforeEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { escapeSeatbeltString, createCaps, type CapsInstance } from "./caps.js";
import type { Policy } from "../policy/defaults.js";
import type { ManifestContext } from "./caps.js";
import { applySessionOverrides } from "../policy/effective.js";
import type { SessionState } from "../slash/commands.js";

// Use AJV (v6, CommonJS) for real schema validation against the vendored schema.
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Ajv = require("ajv") as any;
const manifestSchema = require("../../schemas/capability-manifest.schema.json");

const ajv = new Ajv({ allErrors: true, strict: false });
const validateSchema = ajv.compile(manifestSchema);

function validateAgainstSchema(manifest: unknown): {
  valid: boolean;
  errors: string[];
} {
  const valid = validateSchema(manifest) as boolean;
  const errors = valid
    ? []
    : (
        (validateSchema.errors ?? []) as Array<{
          instancePath: string;
          message?: string;
        }>
      ).map((e) => `${e.instancePath} ${e.message ?? ""}`.trim());
  return { valid, errors };
}

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pi-manifest-test-"));
}

function makeBasePolicy(overrides: Partial<Policy> = {}): Policy {
  return {
    enabled: true,
    fs: {
      allowRead: [],
      allowWrite: [],
      denyPatterns: [],
    },
    network: {
      mode: "non-interactive-only",
      allow: ["github.com", "*.github.com"],
    },
    audit: {
      log: true,
      logFile: "/tmp/audit.jsonl",
    },
    enforcement: {
      requireKernelSandbox: false,
    },
    ...overrides,
  };
}

function makeCtx(overrides: Partial<ManifestContext> = {}): ManifestContext {
  return {
    hasUI: false,
    cwd: process.cwd(),
    platform: "linux",
    ui: { notify: vi.fn() },
    ...overrides,
  };
}

describe("buildManifest — schema conformance", () => {
  let caps: CapsInstance;
  beforeEach(() => {
    caps = createCaps();
  });

  it("empty policy produces a manifest that validates against the schema", () => {
    const manifest = caps.buildManifest(makeBasePolicy(), makeCtx());
    const { valid, errors } = validateAgainstSchema(manifest);
    expect(errors).toEqual([]);
    expect(valid).toBe(true);
  });

  it("manifest with all fields validates against the schema", () => {
    const tmpDir = makeTmpDir();
    try {
      const policy = makeBasePolicy({
        fs: {
          allowRead: [tmpDir],
          allowWrite: [tmpDir],
          denyPatterns: ["/etc/passwd"],
        },
        network: { mode: "always", allow: ["example.com", "*.example.com"] },
      });
      const manifest = caps.buildManifest(
        policy,
        makeCtx({ platform: "darwin" }),
      );
      const { valid, errors } = validateAgainstSchema(manifest);
      expect(errors).toEqual([]);
      expect(valid).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("buildManifest — network.mode × hasUI", () => {
  let caps: CapsInstance;
  beforeEach(() => {
    caps = createCaps();
  });

  it('mode "off" → omits network section (no filtering, allow all)', () => {
    const policy = makeBasePolicy({
      network: { mode: "off", allow: ["example.com"] },
    });
    const manifest = caps.buildManifest(policy, makeCtx({ hasUI: false }));
    expect(manifest.network).toBeUndefined();
  });

  it('mode "off" + hasUI → still omits network section', () => {
    const policy = makeBasePolicy({
      network: { mode: "off", allow: ["example.com"] },
    });
    const manifest = caps.buildManifest(policy, makeCtx({ hasUI: true }));
    expect(manifest.network).toBeUndefined();
  });

  it('mode "always" + hasUI=false → strict allowlist', () => {
    const policy = makeBasePolicy({
      network: { mode: "always", allow: ["example.com"] },
    });
    const manifest = caps.buildManifest(policy, makeCtx({ hasUI: false }));
    expect(manifest.network?.allow_domain).toEqual(["example.com"]);
  });

  it('mode "always" + hasUI=true → strict allowlist regardless of hasUI', () => {
    const policy = makeBasePolicy({
      network: { mode: "always", allow: ["example.com"] },
    });
    const manifest = caps.buildManifest(policy, makeCtx({ hasUI: true }));
    expect(manifest.network?.allow_domain).toEqual(["example.com"]);
  });

  it('mode "non-interactive-only" + hasUI=false → strict allowlist', () => {
    const policy = makeBasePolicy({
      network: { mode: "non-interactive-only", allow: ["api.example.com"] },
    });
    const manifest = caps.buildManifest(policy, makeCtx({ hasUI: false }));
    expect(manifest.network?.allow_domain).toEqual(["api.example.com"]);
  });

  it('mode "non-interactive-only" + hasUI=true → no network restriction', () => {
    const policy = makeBasePolicy({
      network: { mode: "non-interactive-only", allow: ["api.example.com"] },
    });
    const manifest = caps.buildManifest(policy, makeCtx({ hasUI: true }));
    expect(manifest.network).toBeUndefined();
  });

  it('empty allowlist + mode "always" → deny-all network shape', () => {
    const policy = makeBasePolicy({ network: { mode: "always", allow: [] } });
    const manifest = caps.buildManifest(policy, makeCtx({ hasUI: false }));
    expect(manifest.network).toBeDefined();
    expect(manifest.network?.allow_domain).toEqual([]);
  });

  it('empty allowlist + mode "non-interactive-only" + hasUI=false → deny-all network shape', () => {
    const policy = makeBasePolicy({
      network: { mode: "non-interactive-only", allow: [] },
    });
    const manifest = caps.buildManifest(policy, makeCtx({ hasUI: false }));
    expect(manifest.network).toBeDefined();
    expect(manifest.network?.allow_domain).toEqual([]);
  });

  it('empty allowlist + mode "non-interactive-only" + hasUI=true → no network field (interactive bypass)', () => {
    const policy = makeBasePolicy({
      network: { mode: "non-interactive-only", allow: [] },
    });
    const manifest = caps.buildManifest(policy, makeCtx({ hasUI: true }));
    expect(manifest.network).toBeUndefined();
  });
});

describe("buildManifest — networkOff session override allows all network", () => {
  let caps: CapsInstance;
  beforeEach(() => {
    caps = createCaps();
  });

  it("applySessionOverrides with networkOff=true + buildManifest omits the network section", () => {
    const basePolicy = makeBasePolicy({
      network: { mode: "non-interactive-only", allow: ["github.com"] },
    });
    const session: SessionState = {
      networkOff: true,
      sandboxOff: false,
      sessionAllowedHosts: new Set(),
    };
    const effective = applySessionOverrides(basePolicy, session);
    const manifest = caps.buildManifest(effective, makeCtx({ hasUI: false }));
    expect(manifest.network).toBeUndefined();
  });
});

describe("buildManifest — missing path filtering", () => {
  let caps: CapsInstance;
  beforeEach(() => {
    caps = createCaps();
  });

  it("existing paths are included in allow_read", () => {
    const tmpDir = makeTmpDir();
    try {
      const policy = makeBasePolicy({
        fs: { allowRead: [tmpDir], allowWrite: [], denyPatterns: [] },
      });
      const ctx = makeCtx();
      const manifest = caps.buildManifest(policy, ctx);
      // realpathSync canonicalizes symlinks (e.g. /tmp → /private/tmp on macOS)
      expect(manifest.filesystem?.allow_read).toContain(
        fs.realpathSync(tmpDir),
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("missing paths are filtered out of allow_read and a warning is emitted", () => {
    const missingPath = "/nonexistent/path/that/does/not/exist-9999";
    const policy = makeBasePolicy({
      fs: { allowRead: [missingPath], allowWrite: [], denyPatterns: [] },
    });
    const ctx = makeCtx();
    const manifest = caps.buildManifest(policy, ctx);
    expect(manifest.filesystem?.allow_read ?? []).not.toContain(missingPath);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining(missingPath),
      "warning",
    );
  });

  it("missing path warning is emitted only once (one-time warning)", () => {
    const missingPath = "/nonexistent/path/dedupe-test-8888";
    const policy = makeBasePolicy({
      fs: { allowRead: [missingPath], allowWrite: [], denyPatterns: [] },
    });
    const ctx = makeCtx();
    caps.buildManifest(policy, ctx);
    caps.buildManifest(policy, ctx);
    const notifyCalls = (
      ctx.ui.notify as ReturnType<typeof vi.fn>
    ).mock.calls.filter(([msg]) => (msg as string).includes(missingPath));
    expect(notifyCalls).toHaveLength(1);
  });

  it("missing paths filtered from allow_write", () => {
    const missingPath = "/nonexistent/write/path-7777";
    const policy = makeBasePolicy({
      fs: { allowRead: [], allowWrite: [missingPath], denyPatterns: [] },
    });
    const ctx = makeCtx();
    const manifest = caps.buildManifest(policy, ctx);
    expect(manifest.filesystem?.allow_write ?? []).not.toContain(missingPath);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining(missingPath),
      "warning",
    );
  });

  it("expands <cwd> token before resolving paths", () => {
    const tmpDir = makeTmpDir();
    try {
      const policy = makeBasePolicy({
        fs: { allowRead: ["<cwd>"], allowWrite: [], denyPatterns: [] },
      });
      const ctx = makeCtx({ cwd: tmpDir });
      const manifest = caps.buildManifest(policy, ctx);
      expect(manifest.filesystem?.allow_read).toContain(
        fs.realpathSync(tmpDir),
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("expands ~ token before resolving paths", () => {
    const policy = makeBasePolicy({
      fs: { allowRead: ["~"], allowWrite: [], denyPatterns: [] },
    });
    const ctx = makeCtx();
    const manifest = caps.buildManifest(policy, ctx);
    // os.homedir() should exist; the path should appear (possibly canonicalized)
    const homeDir = os.homedir();
    const expandedRead = manifest.filesystem?.allow_read ?? [];
    expect(expandedRead.some((p) => p.startsWith(homeDir))).toBe(true);
  });
});

describe("buildManifest — macOS deny translation", () => {
  let caps: CapsInstance;
  beforeEach(() => {
    caps = createCaps();
  });

  it('macOS: simple path "/etc/passwd" appears in filesystem.deny.access', () => {
    const policy = makeBasePolicy({
      fs: { allowRead: [], allowWrite: [], denyPatterns: ["/etc/passwd"] },
    });
    const manifest = caps.buildManifest(
      policy,
      makeCtx({ platform: "darwin" }),
    );
    expect(manifest.filesystem?.deny?.access).toContain("/etc/passwd");
  });

  it('macOS: glob pattern "**/*.pem" does NOT appear in filesystem.deny (in-process gate handles it)', () => {
    const policy = makeBasePolicy({
      fs: { allowRead: [], allowWrite: [], denyPatterns: ["**/*.pem"] },
    });
    const manifest = caps.buildManifest(
      policy,
      makeCtx({ platform: "darwin" }),
    );
    expect(manifest.filesystem?.deny?.access ?? []).not.toContain("**/*.pem");
  });

  it("macOS: glob patterns with ** are excluded from deny", () => {
    const policy = makeBasePolicy({
      fs: {
        allowRead: [],
        allowWrite: [],
        denyPatterns: ["/etc/passwd", "**/.ssh/**", "**/*.key", "/etc/shadow"],
      },
    });
    const manifest = caps.buildManifest(
      policy,
      makeCtx({ platform: "darwin" }),
    );
    expect(manifest.filesystem?.deny?.access).toContain("/etc/passwd");
    expect(manifest.filesystem?.deny?.access).toContain("/etc/shadow");
    expect(manifest.filesystem?.deny?.access).not.toContain("**/.ssh/**");
    expect(manifest.filesystem?.deny?.access).not.toContain("**/*.key");
  });

  it("Linux: no filesystem.deny entries regardless of denyPatterns", () => {
    const policy = makeBasePolicy({
      fs: {
        allowRead: [],
        allowWrite: [],
        denyPatterns: ["/etc/passwd", "**/*.pem"],
      },
    });
    const manifest = caps.buildManifest(policy, makeCtx({ platform: "linux" }));
    expect(manifest.filesystem?.deny).toBeUndefined();
  });
});

describe("buildManifest — output validates schema for representative network modes", () => {
  let caps: CapsInstance;
  beforeEach(() => {
    caps = createCaps();
  });

  it("validates schema when network filtering is off", () => {
    const manifest = caps.buildManifest(
      makeBasePolicy({ network: { mode: "off", allow: ["example.com"] } }),
      makeCtx({ hasUI: true }),
    );
    const { valid, errors } = validateAgainstSchema(manifest);
    expect(errors).toEqual([]);
    expect(valid).toBe(true);
  });

  it("validates schema for non-interactive network filtering", () => {
    const manifest = caps.buildManifest(
      makeBasePolicy({
        network: { mode: "non-interactive-only", allow: ["example.com"] },
      }),
      makeCtx({ hasUI: false }),
    );
    const { valid, errors } = validateAgainstSchema(manifest);
    expect(errors).toEqual([]);
    expect(valid).toBe(true);
  });
});

describe("buildCapabilitySet", () => {
  let caps: CapsInstance;
  beforeEach(() => {
    caps = createCaps();
  });

  it("Linux: allows-only, queryPath returns true for allowed read paths", () => {
    const tmpDir = makeTmpDir();
    try {
      const policy = makeBasePolicy({
        fs: {
          allowRead: [tmpDir],
          allowWrite: [],
          denyPatterns: ["/etc/passwd"],
        },
      });
      const capSet = caps.buildCapabilitySet(
        policy,
        makeCtx({ platform: "linux", cwd: tmpDir }),
      );
      expect(capSet.queryPath(tmpDir, "read")).toBe(true);
      expect(capSet.platformRules).toEqual([]);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("Linux: no platformRules even when denyPatterns contains simple paths", () => {
    const policy = makeBasePolicy({
      fs: { allowRead: [], allowWrite: [], denyPatterns: ["/etc/passwd"] },
    });
    const capSet = caps.buildCapabilitySet(
      policy,
      makeCtx({ platform: "linux" }),
    );
    expect(capSet.platformRules).toEqual([]);
  });

  it("macOS: optional platformRule entries for simple deny paths", () => {
    const policy = makeBasePolicy({
      fs: {
        allowRead: [],
        allowWrite: [],
        denyPatterns: ["/etc/passwd", "**/*.pem"],
      },
    });
    const capSet = caps.buildCapabilitySet(
      policy,
      makeCtx({ platform: "darwin" }),
    );
    expect(capSet.platformRules.some((r) => r.includes("/etc/passwd"))).toBe(
      true,
    );
    expect(capSet.platformRules.every((r) => !r.includes("**/*.pem"))).toBe(
      true,
    );
  });

  it("queryPath returns false for paths outside the allow set", () => {
    const tmpDir = makeTmpDir();
    try {
      const policy = makeBasePolicy({
        fs: { allowRead: [tmpDir], allowWrite: [], denyPatterns: [] },
      });
      const capSet = caps.buildCapabilitySet(
        policy,
        makeCtx({ platform: "linux", cwd: tmpDir }),
      );
      expect(capSet.queryPath("/some/other/path", "read")).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("queryPath checks write set independently from read set", () => {
    const tmpDir = makeTmpDir();
    try {
      const policy = makeBasePolicy({
        fs: { allowRead: [tmpDir], allowWrite: [], denyPatterns: [] },
      });
      const capSet = caps.buildCapabilitySet(
        policy,
        makeCtx({ platform: "linux", cwd: tmpDir }),
      );
      expect(capSet.queryPath(tmpDir, "read")).toBe(true);
      expect(capSet.queryPath(tmpDir, "write")).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("queryPath agrees with manifest allow set for existing paths", () => {
    const tmpDir = makeTmpDir();
    try {
      const policy = makeBasePolicy({
        fs: { allowRead: [tmpDir], allowWrite: [tmpDir], denyPatterns: [] },
        network: { mode: "off", allow: [] },
      });
      const ctx = makeCtx({ platform: "linux", cwd: tmpDir });
      const manifest = caps.buildManifest(policy, ctx);
      const freshCaps = createCaps();
      const capSet = freshCaps.buildCapabilitySet(policy, ctx);
      const manifestReadPaths = manifest.filesystem?.allow_read ?? [];
      for (const p of manifestReadPaths) {
        expect(capSet.queryPath(p, "read")).toBe(true);
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("escapeSeatbeltString", () => {
  it("returns plain strings unchanged", () => {
    expect(escapeSeatbeltString("/etc/passwd")).toBe("/etc/passwd");
    expect(escapeSeatbeltString("/home/user/some path/file.txt")).toBe(
      "/home/user/some path/file.txt",
    );
  });

  it('escapes double-quote: a"b → a\\"b', () => {
    expect(escapeSeatbeltString('a"b')).toBe('a\\"b');
  });

  it("escapes backslash: a\\b → a\\\\b", () => {
    expect(escapeSeatbeltString("a\\b")).toBe("a\\\\b");
  });

  it("escapes both backslash and double-quote in combination", () => {
    expect(escapeSeatbeltString('a\\"b')).toBe('a\\\\\\"b');
  });

  it("does not escape closing paren — it is safe in a string literal", () => {
    expect(escapeSeatbeltString("a)b")).toBe("a)b");
  });

  it("throws on newline (\\n)", () => {
    expect(() => escapeSeatbeltString("a\nb")).toThrow("control characters");
  });

  it("throws on null byte (\\x00)", () => {
    expect(() => escapeSeatbeltString("a\x00b")).toThrow("control characters");
  });

  it("throws on \\x1f", () => {
    expect(() => escapeSeatbeltString("a\x1fb")).toThrow("control characters");
  });

  it("throws on \\x07 (bell)", () => {
    expect(() => escapeSeatbeltString("a\x07b")).toThrow("control characters");
  });

  it("\\x20 (space) does not throw — printable", () => {
    expect(() => escapeSeatbeltString("a b")).not.toThrow();
  });
});

describe("buildCapabilitySet — Seatbelt escaping", () => {
  let caps: CapsInstance;
  beforeEach(() => {
    caps = createCaps();
  });

  it("macOS: deny path with double-quote is escaped in platformRule", () => {
    const policy = makeBasePolicy({
      fs: { allowRead: [], allowWrite: [], denyPatterns: ['/etc/pa"sswd'] },
    });
    const capSet = caps.buildCapabilitySet(
      policy,
      makeCtx({ platform: "darwin" }),
    );
    expect(capSet.platformRules.some((r) => r.includes('/etc/pa\\"sswd'))).toBe(
      true,
    );
  });

  it("macOS: deny path with backslash is escaped in platformRule", () => {
    const policy = makeBasePolicy({
      fs: { allowRead: [], allowWrite: [], denyPatterns: ["/etc/pa\\sswd"] },
    });
    const capSet = caps.buildCapabilitySet(
      policy,
      makeCtx({ platform: "darwin" }),
    );
    expect(
      capSet.platformRules.some((r) => r.includes("/etc/pa\\\\sswd")),
    ).toBe(true);
  });

  it("macOS: deny path with control character throws at manifest-build time", () => {
    const policy = makeBasePolicy({
      fs: { allowRead: [], allowWrite: [], denyPatterns: ["/etc/pa\x07sswd"] },
    });
    expect(() =>
      caps.buildCapabilitySet(policy, makeCtx({ platform: "darwin" })),
    ).toThrow("control characters");
  });

  it("Linux: deny path with control character does NOT throw (no Seatbelt on Linux)", () => {
    const policy = makeBasePolicy({
      fs: { allowRead: [], allowWrite: [], denyPatterns: ["/etc/pa\x07sswd"] },
    });
    expect(() =>
      caps.buildCapabilitySet(policy, makeCtx({ platform: "linux" })),
    ).not.toThrow();
  });
});

describe("buildManifest — prefix push-down", () => {
  let caps: CapsInstance;
  beforeEach(() => {
    caps = createCaps();
  });

  it("darwin: mixed patterns — only extractable prefixes appear in deny.access", () => {
    const policy = makeBasePolicy({
      fs: {
        allowRead: [],
        allowWrite: [],
        denyPatterns: [
          "/wd/**/.env",
          "**/.env",
          "/home/user/.ssh/**",
          "**/*.key",
        ],
      },
    });
    const manifest = caps.buildManifest(
      policy,
      makeCtx({ platform: "darwin" }),
    );
    const denyAccess = manifest.filesystem?.deny?.access ?? [];
    expect(denyAccess).toContain("/wd/");
    expect(denyAccess).toContain("/home/user/.ssh/");
    expect(denyAccess).not.toContain("**/.env");
    expect(denyAccess).not.toContain("**/*.key");
  });

  it("linux: no deny block regardless of patterns", () => {
    const policy = makeBasePolicy({
      fs: {
        allowRead: [],
        allowWrite: [],
        denyPatterns: ["/wd/**/.env", "**/.env", "/home/user/.ssh/**"],
      },
    });
    const manifest = caps.buildManifest(policy, makeCtx({ platform: "linux" }));
    expect(manifest.filesystem?.deny).toBeUndefined();
  });

  it("darwin: anchored default-style patterns after expansion produce non-empty deny set", () => {
    const cwd = "/project";
    const home = "/home/user";
    const policy = makeBasePolicy({
      fs: {
        allowRead: [],
        allowWrite: [],
        denyPatterns: [
          `${cwd}/**/.env`,
          `${home}/.ssh/**`,
          `${home}/.aws/credentials`,
        ],
      },
    });
    const manifest = caps.buildManifest(
      policy,
      makeCtx({ platform: "darwin", cwd }),
    );
    const denyAccess = manifest.filesystem?.deny?.access ?? [];
    expect(denyAccess.length).toBeGreaterThan(0);
    expect(denyAccess).toContain(`${cwd}/`);
    expect(denyAccess).toContain(`${home}/.ssh/`);
    expect(denyAccess).toContain(`${home}/.aws/credentials`);
  });
});

describe("buildCapabilitySet — prefix push-down", () => {
  let caps: CapsInstance;
  beforeEach(() => {
    caps = createCaps();
  });

  it("darwin: platformRules contain path-prefix rules for anchored patterns", () => {
    const policy = makeBasePolicy({
      fs: {
        allowRead: [],
        allowWrite: [],
        denyPatterns: ["/home/user/.ssh/**", "**/.env"],
      },
    });
    const capSet = caps.buildCapabilitySet(
      policy,
      makeCtx({ platform: "darwin" }),
    );
    expect(
      capSet.platformRules.some((r) => r.includes("/home/user/.ssh/")),
    ).toBe(true);
    expect(capSet.platformRules.every((r) => !r.includes("**/.env"))).toBe(
      true,
    );
  });

  it("linux: no platformRules even for anchored patterns", () => {
    const policy = makeBasePolicy({
      fs: {
        allowRead: [],
        allowWrite: [],
        denyPatterns: ["/home/user/.ssh/**", "/project/**/.env"],
      },
    });
    const capSet = caps.buildCapabilitySet(
      policy,
      makeCtx({ platform: "linux" }),
    );
    expect(capSet.platformRules).toEqual([]);
  });
});
