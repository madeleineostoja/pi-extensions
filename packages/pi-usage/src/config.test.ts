import { describe, it, expect, vi } from "vitest";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readConfig,
  writeConfig,
  validateOpencodeConfig,
  getConfigPath,
  runOpencodeAuthSetup,
} from "./config.js";

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "pi-usage-config-test-"));
}

describe("readConfig", () => {
  it("returns null when config file is missing", () => {
    const tmpDir = makeTempDir();
    try {
      expect(readConfig(tmpDir)).toBeNull();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("returns parsed config when file exists and is valid", () => {
    const tmpDir = makeTempDir();
    try {
      const config = {
        opencode: {
          workspaceId: "wrk_abc123",
          authCookie: "Fe26.2**test",
        },
      };
      writeFileSync(getConfigPath(tmpDir), JSON.stringify(config));
      expect(readConfig(tmpDir)).toEqual(config);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("returns null when file contains malformed JSON", () => {
    const tmpDir = makeTempDir();
    try {
      writeFileSync(getConfigPath(tmpDir), "not json");
      expect(readConfig(tmpDir)).toBeNull();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("returns null when file contains non-object JSON", () => {
    const tmpDir = makeTempDir();
    try {
      writeFileSync(getConfigPath(tmpDir), "123");
      expect(readConfig(tmpDir)).toBeNull();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("ignores OPENCODE_GO_WORKSPACE_ID env var", () => {
    const tmpDir = makeTempDir();
    try {
      process.env.OPENCODE_GO_WORKSPACE_ID = "wrk_env";
      expect(readConfig(tmpDir)).toBeNull();
    } finally {
      delete process.env.OPENCODE_GO_WORKSPACE_ID;
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("ignores OPENCODE_GO_AUTH_COOKIE env var", () => {
    const tmpDir = makeTempDir();
    try {
      process.env.OPENCODE_GO_AUTH_COOKIE = "Fe26.2**env";
      expect(readConfig(tmpDir)).toBeNull();
    } finally {
      delete process.env.OPENCODE_GO_AUTH_COOKIE;
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("validateOpencodeConfig", () => {
  it("returns valid config when both fields are present", () => {
    const result = validateOpencodeConfig({
      opencode: {
        workspaceId: "wrk_abc",
        authCookie: "Fe26.2**test",
      },
    });
    expect(result).toEqual({
      workspaceId: "wrk_abc",
      authCookie: "Fe26.2**test",
    });
  });

  it("returns null when opencode section is missing", () => {
    expect(validateOpencodeConfig({})).toBeNull();
    expect(validateOpencodeConfig(null)).toBeNull();
  });

  it("returns null when workspaceId is missing", () => {
    expect(
      validateOpencodeConfig({
        opencode: { authCookie: "Fe26.2**test" } as never,
      }),
    ).toBeNull();
  });

  it("returns null when authCookie is missing", () => {
    expect(
      validateOpencodeConfig({
        opencode: { workspaceId: "wrk_abc" } as never,
      }),
    ).toBeNull();
  });

  it("returns null when workspaceId is empty string", () => {
    expect(
      validateOpencodeConfig({
        opencode: { workspaceId: "", authCookie: "Fe26.2**test" },
      }),
    ).toBeNull();
  });

  it("returns null when authCookie is empty string", () => {
    expect(
      validateOpencodeConfig({
        opencode: { workspaceId: "wrk_abc", authCookie: "" },
      }),
    ).toBeNull();
  });

  it("returns null when workspaceId is wrong type", () => {
    expect(
      validateOpencodeConfig({
        opencode: { workspaceId: 123, authCookie: "Fe26.2**test" } as never,
      }),
    ).toBeNull();
  });

  it("returns null when authCookie is wrong type", () => {
    expect(
      validateOpencodeConfig({
        opencode: { workspaceId: "wrk_abc", authCookie: 123 } as never,
      }),
    ).toBeNull();
  });

  it("trims whitespace from values", () => {
    const result = validateOpencodeConfig({
      opencode: {
        workspaceId: "  wrk_abc  ",
        authCookie: "  Fe26.2**test  ",
      },
    });
    expect(result).toEqual({
      workspaceId: "wrk_abc",
      authCookie: "Fe26.2**test",
    });
  });
});

describe("writeConfig", () => {
  it("creates parent directory if missing and writes config", () => {
    const tmpDir = makeTempDir();
    const nestedDir = join(tmpDir, "nested", "agent");
    try {
      writeConfig(nestedDir, {
        opencode: { workspaceId: "wrk_x", authCookie: "cookie" },
      });
      const path = getConfigPath(nestedDir);
      const content = readFileSync(path, "utf8");
      expect(content).toContain('"workspaceId": "wrk_x"');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("preserves unrelated top-level fields", () => {
    const tmpDir = makeTempDir();
    try {
      const path = getConfigPath(tmpDir);
      writeFileSync(
        path,
        JSON.stringify({
          codex: { something: "else" },
          opencode: { workspaceId: "wrk_old", authCookie: "old" },
        }),
      );
      writeConfig(tmpDir, {
        opencode: { workspaceId: "wrk_new", authCookie: "new" },
      });
      const result = readConfig(tmpDir);
      expect(result).toEqual({
        codex: { something: "else" },
        opencode: { workspaceId: "wrk_new", authCookie: "new" },
      });
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("runOpencodeAuthSetup", () => {
  it("does nothing when mode is not tui", async () => {
    const ctx = { mode: "rpc", ui: { input: vi.fn(), notify: vi.fn() } };
    await runOpencodeAuthSetup(ctx as never, makeTempDir());
    expect(ctx.ui.input).not.toHaveBeenCalled();
    expect(ctx.ui.notify).not.toHaveBeenCalled();
  });

  it("cancels when first prompt returns undefined", async () => {
    const tmpDir = makeTempDir();
    const ctx = {
      mode: "tui",
      ui: { input: vi.fn().mockResolvedValue(undefined), notify: vi.fn() },
    };
    await runOpencodeAuthSetup(ctx as never, tmpDir);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "Opencode auth cancelled. No changes made.",
      "info",
    );
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("cancels when first prompt returns whitespace", async () => {
    const tmpDir = makeTempDir();
    const ctx = {
      mode: "tui",
      ui: { input: vi.fn().mockResolvedValue("   "), notify: vi.fn() },
    };
    await runOpencodeAuthSetup(ctx as never, tmpDir);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "Opencode auth cancelled. No changes made.",
      "info",
    );
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("cancels on AbortError from first prompt", async () => {
    const tmpDir = makeTempDir();
    const abortError = Object.assign(new Error("Aborted"), {
      name: "AbortError",
    });
    const ctx = {
      mode: "tui",
      ui: { input: vi.fn().mockRejectedValue(abortError), notify: vi.fn() },
    };
    await runOpencodeAuthSetup(ctx as never, tmpDir);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "Opencode auth cancelled. No changes made.",
      "info",
    );
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("cancels when second prompt returns undefined", async () => {
    const tmpDir = makeTempDir();
    const ctx = {
      mode: "tui",
      ui: {
        input: vi
          .fn()
          .mockResolvedValueOnce("wrk_abc")
          .mockResolvedValueOnce(undefined),
        notify: vi.fn(),
      },
    };
    await runOpencodeAuthSetup(ctx as never, tmpDir);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "Opencode auth cancelled. No changes made.",
      "info",
    );
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("cancels when second prompt returns whitespace", async () => {
    const tmpDir = makeTempDir();
    const ctx = {
      mode: "tui",
      ui: {
        input: vi
          .fn()
          .mockResolvedValueOnce("wrk_abc")
          .mockResolvedValueOnce("   "),
        notify: vi.fn(),
      },
    };
    await runOpencodeAuthSetup(ctx as never, tmpDir);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "Opencode auth cancelled. No changes made.",
      "info",
    );
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes config and notifies when both prompts succeed", async () => {
    const tmpDir = makeTempDir();
    const ctx = {
      mode: "tui",
      ui: {
        input: vi
          .fn()
          .mockResolvedValueOnce("wrk_abc")
          .mockResolvedValueOnce("Fe26.2**cookie"),
        notify: vi.fn(),
      },
    };
    await runOpencodeAuthSetup(ctx as never, tmpDir);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "Opencode auth saved to ~/.pi/agent/pi-usage.json",
      "info",
    );
    const config = readConfig(tmpDir);
    expect(config?.opencode).toEqual({
      workspaceId: "wrk_abc",
      authCookie: "Fe26.2**cookie",
    });
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("shows hints when values do not match expected shapes", async () => {
    const tmpDir = makeTempDir();
    const ctx = {
      mode: "tui",
      ui: {
        input: vi
          .fn()
          .mockResolvedValueOnce("bad-id")
          .mockResolvedValueOnce("bad-cookie"),
        notify: vi.fn(),
      },
    };
    await runOpencodeAuthSetup(ctx as never, tmpDir);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Workspace ID does not look like"),
      "info",
    );
    const config = readConfig(tmpDir);
    expect(config?.opencode).toEqual({
      workspaceId: "bad-id",
      authCookie: "bad-cookie",
    });
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("preserves existing unrelated config fields", async () => {
    const tmpDir = makeTempDir();
    const path = getConfigPath(tmpDir);
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        codex: { token: "abc" },
        opencode: { workspaceId: "old", authCookie: "old" },
      }),
    );
    const ctx = {
      mode: "tui",
      ui: {
        input: vi
          .fn()
          .mockResolvedValueOnce("wrk_new")
          .mockResolvedValueOnce("Fe26.2**new"),
        notify: vi.fn(),
      },
    };
    await runOpencodeAuthSetup(ctx as never, tmpDir);
    const config = readConfig(tmpDir);
    expect(config).toEqual({
      codex: { token: "abc" },
      opencode: { workspaceId: "wrk_new", authCookie: "Fe26.2**new" },
    });
    rmSync(tmpDir, { recursive: true, force: true });
  });
});
