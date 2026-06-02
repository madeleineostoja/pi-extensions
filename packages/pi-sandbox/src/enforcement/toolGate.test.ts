import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import {
  createToolGate,
  BLOCK_REASON,
  type ToolCallEvent,
  type ToolGate,
  type ToolGateOptions,
} from "./toolGate.js";
import type { Policy } from "../policy/defaults.js";
import type { ManifestContext } from "./caps.js";

function makeEvent(
  toolName: string,
  input: Record<string, unknown>,
): ToolCallEvent {
  return {
    type: "tool_call",
    toolCallId: "test",
    toolName,
    input,
  } as ToolCallEvent;
}

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pi-tool-gate-test-"));
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

function makeCtx(cwd: string): ManifestContext {
  return {
    hasUI: false,
    cwd,
    platform: "linux",
    ui: { notify: vi.fn() },
  };
}

function makeGate(
  policy: Policy,
  cwd: string,
  extraOpts: Partial<ToolGateOptions> = {},
): ToolGate {
  return createToolGate({
    getPolicy: () => policy,
    ctx: makeCtx(cwd),
    ...extraOpts,
  });
}

// ---------------------------------------------------------------------------
// Path resolution helpers
// ---------------------------------------------------------------------------

describe("resolveAbsolute — path resolution", () => {
  let tmpDir: string;
  let gate: ToolGate;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    // Allow the whole tmpDir so resolution behaviour is testable
    const policy = makePolicy({ allowRead: [tmpDir], allowWrite: [tmpDir] });
    gate = makeGate(policy, tmpDir);
  });

  afterEach(() => {
    gate.dispose();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("allows an existing file that is inside allowRead", async () => {
    const file = path.join(tmpDir, "allowed.txt");
    fs.writeFileSync(file, "hi");
    const result = await gate.handleToolCall(makeEvent("read", { path: file }));
    expect(result).toBeUndefined();
  });

  it("blocks a read of an existing file outside allowRead", async () => {
    const file = path.join(tmpDir, "allowed.txt");
    fs.writeFileSync(file, "hi");
    const deniedPolicy = makePolicy({ allowRead: [], allowWrite: [] });
    const deniedGate = makeGate(deniedPolicy, tmpDir);
    try {
      const result = await deniedGate.handleToolCall(
        makeEvent("read", { path: file }),
      );
      expect(result).toEqual({ block: true, reason: BLOCK_REASON });
    } finally {
      deniedGate.dispose();
    }
  });

  it("handles a relative path by resolving against cwd", async () => {
    const file = path.join(tmpDir, "rel.txt");
    fs.writeFileSync(file, "hi");
    const result = await gate.handleToolCall(
      makeEvent("read", { path: "rel.txt" }),
    );
    expect(result).toBeUndefined();
  });

  it("handles path traversal (../../etc/passwd relative to cwd)", async () => {
    const result = await gate.handleToolCall(
      makeEvent("read", { path: "../../etc/passwd" }),
    );
    // /etc/passwd resolves outside tmpDir, which is not in allowRead
    expect(result).toEqual({ block: true, reason: BLOCK_REASON });
  });

  it("resolves a symlink pointing to a denied path and blocks it", async () => {
    const denied = path.join(tmpDir, "secret.key");
    fs.writeFileSync(denied, "private");
    const symlink = path.join(tmpDir, "x");
    fs.symlinkSync(denied, symlink);

    // Allow the symlink's own path but deny files matching *.key
    const policy = makePolicy({
      allowRead: [tmpDir],
      denyPatterns: ["**/*.key"],
    });
    const symlinkGate = makeGate(policy, tmpDir);
    try {
      const result = await symlinkGate.handleToolCall(
        makeEvent("read", { path: symlink }),
      );
      expect(result).toEqual({ block: true, reason: BLOCK_REASON });
    } finally {
      symlinkGate.dispose();
    }
  });

  it("allows a write to a non-existent file in an allowed parent dir (missing leaf)", async () => {
    const newFile = path.join(tmpDir, "newfile.txt");
    expect(fs.existsSync(newFile)).toBe(false);
    const result = await gate.handleToolCall(
      makeEvent("write", { path: newFile }),
    );
    expect(result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Each FS tool × allowed/denied
// ---------------------------------------------------------------------------

describe("FS tools — allowed paths", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it.each(["read", "ls", "find", "grep"] as const)(
    "%s: allowed path → no block",
    async (tool) => {
      const file = path.join(tmpDir, "f.txt");
      fs.writeFileSync(file, "");
      const policy = makePolicy({ allowRead: [tmpDir] });
      const gate = makeGate(policy, tmpDir);
      try {
        const result = await gate.handleToolCall(
          makeEvent(tool, { path: file }),
        );
        expect(result).toBeUndefined();
      } finally {
        gate.dispose();
      }
    },
  );

  it("write: allowed path → no block", async () => {
    const policy = makePolicy({ allowWrite: [tmpDir] });
    const gate = makeGate(policy, tmpDir);
    try {
      const result = await gate.handleToolCall(
        makeEvent("write", { path: path.join(tmpDir, "out.txt") }),
      );
      expect(result).toBeUndefined();
    } finally {
      gate.dispose();
    }
  });

  it("edit: path in both allowRead and allowWrite → no block", async () => {
    const file = path.join(tmpDir, "edit.txt");
    fs.writeFileSync(file, "x");
    const policy = makePolicy({ allowRead: [tmpDir], allowWrite: [tmpDir] });
    const gate = makeGate(policy, tmpDir);
    try {
      const result = await gate.handleToolCall(
        makeEvent("edit", { path: file }),
      );
      expect(result).toBeUndefined();
    } finally {
      gate.dispose();
    }
  });
});

describe("FS tools — denied paths", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it.each(["read", "ls", "find", "grep"] as const)(
    "%s: path outside allowRead → block",
    async (tool) => {
      const outsidePath = os.tmpdir();
      const policy = makePolicy({ allowRead: [tmpDir] });
      const gate = makeGate(policy, tmpDir);
      try {
        const result = await gate.handleToolCall(
          makeEvent(tool, { path: outsidePath }),
        );
        expect(result).toEqual({ block: true, reason: BLOCK_REASON });
      } finally {
        gate.dispose();
      }
    },
  );

  it("write: path outside allowWrite → block", async () => {
    const policy = makePolicy({ allowRead: [tmpDir], allowWrite: [tmpDir] });
    const gate = makeGate(policy, tmpDir);
    try {
      const result = await gate.handleToolCall(
        makeEvent("write", { path: "/etc/hosts" }),
      );
      expect(result).toEqual({ block: true, reason: BLOCK_REASON });
    } finally {
      gate.dispose();
    }
  });

  it("edit: path in allowRead but not allowWrite → block (needs write)", async () => {
    const file = path.join(tmpDir, "edit.txt");
    fs.writeFileSync(file, "x");
    const policy = makePolicy({ allowRead: [tmpDir], allowWrite: [] });
    const gate = makeGate(policy, tmpDir);
    try {
      const result = await gate.handleToolCall(
        makeEvent("edit", { path: file }),
      );
      expect(result).toEqual({ block: true, reason: BLOCK_REASON });
    } finally {
      gate.dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// denyPatterns
// ---------------------------------------------------------------------------

describe("denyPatterns glob semantics", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("**/.env matches .env in the cwd subtree", async () => {
    const envFile = path.join(tmpDir, ".env");
    fs.writeFileSync(envFile, "SECRET=x");
    const policy = makePolicy({
      allowRead: [tmpDir],
      denyPatterns: ["**/.env"],
    });
    const gate = makeGate(policy, tmpDir);
    try {
      const result = await gate.handleToolCall(
        makeEvent("read", { path: envFile }),
      );
      expect(result).toEqual({ block: true, reason: BLOCK_REASON });
    } finally {
      gate.dispose();
    }
  });

  it("**/.env blocks a write to .env even when write is in allowWrite", async () => {
    const envFile = path.join(tmpDir, ".env");
    const policy = makePolicy({
      allowRead: [tmpDir],
      allowWrite: [tmpDir],
      denyPatterns: ["**/.env"],
    });
    const gate = makeGate(policy, tmpDir);
    try {
      const result = await gate.handleToolCall(
        makeEvent("write", { path: envFile }),
      );
      expect(result).toEqual({ block: true, reason: BLOCK_REASON });
    } finally {
      gate.dispose();
    }
  });

  it("**/.env.* matches .env.local", async () => {
    const envLocal = path.join(tmpDir, ".env.local");
    fs.writeFileSync(envLocal, "SECRET=x");
    const policy = makePolicy({
      allowRead: [tmpDir],
      denyPatterns: ["**/.env.*"],
    });
    const gate = makeGate(policy, tmpDir);
    try {
      const result = await gate.handleToolCall(
        makeEvent("read", { path: envLocal }),
      );
      expect(result).toEqual({ block: true, reason: BLOCK_REASON });
    } finally {
      gate.dispose();
    }
  });

  it("denyPatterns are authoritative on Linux (glob deny independent of platform)", async () => {
    const pemFile = path.join(tmpDir, "server.pem");
    fs.writeFileSync(pemFile, "cert");
    const policy = makePolicy({
      allowRead: [tmpDir],
      denyPatterns: ["**/*.pem"],
    });
    const linuxCtx = makeCtx(tmpDir);
    linuxCtx.platform = "linux";
    const gate = createToolGate({
      getPolicy: () => policy,
      ctx: linuxCtx,
    });
    try {
      const result = await gate.handleToolCall(
        makeEvent("read", { path: pemFile }),
      );
      expect(result).toEqual({ block: true, reason: BLOCK_REASON });
    } finally {
      gate.dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// Block reason is always the generic string
// ---------------------------------------------------------------------------

describe("block reason uniformity", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("denyPattern block returns the generic reason", async () => {
    const file = path.join(tmpDir, ".env");
    fs.writeFileSync(file, "x");
    const policy = makePolicy({
      allowRead: [tmpDir],
      denyPatterns: ["**/.env"],
    });
    const gate = makeGate(policy, tmpDir);
    try {
      const result = await gate.handleToolCall(
        makeEvent("read", { path: file }),
      );
      expect(result?.reason).toBe(BLOCK_REASON);
      expect(result?.reason).not.toContain(".env");
      expect(result?.reason).not.toContain("denyPattern");
    } finally {
      gate.dispose();
    }
  });

  it("allowRead miss returns the generic reason", async () => {
    const policy = makePolicy({ allowRead: [] });
    const gate = makeGate(policy, tmpDir);
    try {
      const result = await gate.handleToolCall(
        makeEvent("read", { path: "/etc/hosts" }),
      );
      expect(result?.reason).toBe(BLOCK_REASON);
      expect(result?.reason).not.toContain("allowRead");
      expect(result?.reason).not.toContain("/etc");
    } finally {
      gate.dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// policy.enabled === false → no-op
// ---------------------------------------------------------------------------

describe("policy.enabled === false", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("allows any read when policy is disabled", async () => {
    const disabledPolicy: Policy = {
      ...makePolicy({ allowRead: [] }),
      enabled: false,
    };
    const gate = makeGate(disabledPolicy, tmpDir);
    try {
      const result = await gate.handleToolCall(
        makeEvent("read", { path: "/etc/passwd" }),
      );
      expect(result).toBeUndefined();
    } finally {
      gate.dispose();
    }
  });

  it("allows write matching denyPattern when policy is disabled", async () => {
    const disabledPolicy: Policy = {
      ...makePolicy({ allowWrite: [], denyPatterns: ["**/.env"] }),
      enabled: false,
    };
    const gate = makeGate(disabledPolicy, tmpDir);
    try {
      const result = await gate.handleToolCall(
        makeEvent("write", { path: path.join(tmpDir, ".env") }),
      );
      expect(result).toBeUndefined();
    } finally {
      gate.dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// bash tool_call is skipped
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Unknown tools are skipped
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Policy reload rebuilds matchers
// ---------------------------------------------------------------------------

describe("policy reload", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("a path allowed after reload is no longer blocked", async () => {
    const file = path.join(tmpDir, "data.txt");
    fs.writeFileSync(file, "x");

    let currentPolicy = makePolicy({ allowRead: [] });

    const gate = createToolGate({
      getPolicy: () => currentPolicy,
      ctx: makeCtx(tmpDir),
    });

    try {
      const before = await gate.handleToolCall(
        makeEvent("read", { path: file }),
      );
      expect(before).toEqual({ block: true, reason: BLOCK_REASON });

      currentPolicy = makePolicy({ allowRead: [tmpDir] });

      const after = await gate.handleToolCall(
        makeEvent("read", { path: file }),
      );
      expect(after).toBeUndefined();
    } finally {
      gate.dispose();
    }
  });

  it("a path denied after reload is now blocked", async () => {
    const file = path.join(tmpDir, "secret.key");
    fs.writeFileSync(file, "x");

    let currentPolicy = makePolicy({ allowRead: [tmpDir], denyPatterns: [] });

    const gate = createToolGate({
      getPolicy: () => currentPolicy,
      ctx: makeCtx(tmpDir),
    });

    try {
      const before = await gate.handleToolCall(
        makeEvent("read", { path: file }),
      );
      expect(before).toBeUndefined();

      currentPolicy = makePolicy({
        allowRead: [tmpDir],
        denyPatterns: ["**/*.key"],
      });

      const after = await gate.handleToolCall(
        makeEvent("read", { path: file }),
      );
      expect(after).toEqual({ block: true, reason: BLOCK_REASON });
    } finally {
      gate.dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// Guard test — @earendil-works/pi-coding-agent not yet installable
// ---------------------------------------------------------------------------

// Guard test: pi.on("tool_call", handler) wiring is intentionally deferred until
// @earendil-works/pi-coding-agent is installable. When that package becomes available,
// remove this test and wire it in createToolGate / a higher-level init function.
