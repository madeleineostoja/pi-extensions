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
  validateOpencodeAccounts,
  getOpencodeAccount,
  resolveActiveOpencodeAccount,
  resolveAllOpencodeAccounts,
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
          accounts: {
            "opencode-go": {
              workspaceId: "wrk_abc123",
              authCookie: "Fe26.2**test",
              label: "main",
            },
          },
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

  it("migrates old top-level config to account config while preserving other fields", () => {
    const tmpDir = makeTempDir();
    try {
      const oldConfig = {
        codex: { token: "abc" },
        opencode: {
          workspaceId: "wrk_old",
          authCookie: "Fe26.2**old",
        },
      };
      writeFileSync(getConfigPath(tmpDir), JSON.stringify(oldConfig));
      const result = readConfig(tmpDir);
      expect(result).toEqual({
        codex: { token: "abc" },
        opencode: {
          accounts: {
            "opencode-go": {
              workspaceId: "wrk_old",
              authCookie: "Fe26.2**old",
            },
          },
        },
      });
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("validateOpencodeAccounts", () => {
  it("returns null when opencode section is missing", () => {
    expect(validateOpencodeAccounts({})).toBeNull();
    expect(validateOpencodeAccounts(null)).toBeNull();
  });

  it("returns valid accounts when present", () => {
    const result = validateOpencodeAccounts({
      opencode: {
        accounts: {
          "opencode-go": {
            workspaceId: "wrk_abc",
            authCookie: "Fe26.2**test",
          },
          "opencode-go-1": {
            workspaceId: "wrk_def",
            label: "side",
          },
        },
      },
    });
    expect(result).toEqual({
      "opencode-go": {
        workspaceId: "wrk_abc",
        authCookie: "Fe26.2**test",
      },
      "opencode-go-1": {
        workspaceId: "wrk_def",
        label: "side",
      },
    });
  });

  it("skips invalid accounts", () => {
    const result = validateOpencodeAccounts({
      opencode: {
        accounts: {
          "opencode-go": {
            workspaceId: "wrk_abc",
          },
          bad: { authCookie: "cookie" } as never,
        },
      },
    });
    expect(result).toEqual({
      "opencode-go": {
        workspaceId: "wrk_abc",
      },
    });
  });
});

describe("getOpencodeAccount", () => {
  it("returns account by id", () => {
    const result = getOpencodeAccount(
      {
        opencode: {
          accounts: {
            "opencode-go": { workspaceId: "wrk_abc", authCookie: "cookie" },
          },
        },
      },
      "opencode-go",
    );
    expect(result).toEqual({ workspaceId: "wrk_abc", authCookie: "cookie" });
  });

  it("returns null for missing account", () => {
    expect(getOpencodeAccount(null, "opencode-go")).toBeNull();
  });
});

describe("resolveActiveOpencodeAccount", () => {
  it("resolves first account when no multi-auth", () => {
    const tmpDir = makeTempDir();
    try {
      const result = resolveActiveOpencodeAccount(
        {
          opencode: {
            accounts: {
              "opencode-go": { workspaceId: "wrk_abc", authCookie: "cookie" },
            },
          },
        },
        tmpDir,
      );
      expect(result).toMatchObject({
        accountId: "opencode-go",
        account: { workspaceId: "wrk_abc", authCookie: "cookie" },
        secret: "cookie",
      });
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("returns null when account has no cookie and no multi-auth", () => {
    const tmpDir = makeTempDir();
    try {
      const result = resolveActiveOpencodeAccount(
        {
          opencode: {
            accounts: {
              "opencode-go": { workspaceId: "wrk_abc" },
            },
          },
        },
        tmpDir,
      );
      expect(result).toBeNull();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("returns null when no accounts configured", () => {
    const tmpDir = makeTempDir();
    try {
      expect(resolveActiveOpencodeAccount(null, tmpDir)).toBeNull();
      expect(resolveActiveOpencodeAccount({}, tmpDir)).toBeNull();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("resolveAllOpencodeAccounts", () => {
  it("returns all accounts with secrets", () => {
    const tmpDir = makeTempDir();
    try {
      const result = resolveAllOpencodeAccounts(
        {
          opencode: {
            accounts: {
              "opencode-go": { workspaceId: "wrk_abc", authCookie: "cookie1" },
              "opencode-go-1": {
                workspaceId: "wrk_def",
                authCookie: "cookie2",
              },
            },
          },
        },
        tmpDir,
      );
      expect(result).toHaveLength(2);
      expect(result[0]).toMatchObject({
        accountId: "opencode-go",
        workspaceId: "wrk_abc",
        secret: "cookie1",
      });
      expect(result[1]).toMatchObject({
        accountId: "opencode-go-1",
        workspaceId: "wrk_def",
        secret: "cookie2",
      });
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("returns empty array when no accounts", () => {
    const tmpDir = makeTempDir();
    try {
      expect(resolveAllOpencodeAccounts(null, tmpDir)).toEqual([]);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("validateOpencodeConfig", () => {
  it("returns valid config from active account", () => {
    const tmpDir = makeTempDir();
    try {
      const result = validateOpencodeConfig(
        {
          opencode: {
            accounts: {
              "opencode-go": {
                workspaceId: "wrk_abc",
                authCookie: "Fe26.2**test",
              },
            },
          },
        },
        tmpDir,
      );
      expect(result).toMatchObject({
        workspaceId: "wrk_abc",
        authCookie: "Fe26.2**test",
      });
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("returns null when no active account has cookie", () => {
    const tmpDir = makeTempDir();
    try {
      expect(validateOpencodeConfig(null)).toBeNull();
      expect(validateOpencodeConfig({})).toBeNull();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("writeConfig", () => {
  it("creates parent directory if missing and writes config", () => {
    const tmpDir = makeTempDir();
    const nestedDir = join(tmpDir, "nested", "agent");
    try {
      writeConfig(nestedDir, {
        opencode: {
          accounts: {
            "opencode-go": { workspaceId: "wrk_x", authCookie: "cookie" },
          },
        },
      });
      const path = getConfigPath(nestedDir);
      const content = readFileSync(path, "utf8");
      expect(content).toContain('"workspaceId": "wrk_x"');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("preserves unrelated top-level fields and merges accounts", () => {
    const tmpDir = makeTempDir();
    try {
      const path = getConfigPath(tmpDir);
      writeFileSync(
        path,
        JSON.stringify({
          codex: { token: "abc" },
          opencode: {
            accounts: {
              "opencode-go": { workspaceId: "wrk_old", authCookie: "old" },
            },
          },
        }),
      );
      writeConfig(tmpDir, {
        opencode: {
          accounts: {
            "opencode-go-1": { workspaceId: "wrk_new", authCookie: "new" },
          },
        },
      });
      const result = readConfig(tmpDir);
      expect(result).toEqual({
        codex: { token: "abc" },
        opencode: {
          accounts: {
            "opencode-go": { workspaceId: "wrk_old", authCookie: "old" },
            "opencode-go-1": { workspaceId: "wrk_new", authCookie: "new" },
          },
        },
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

  it("cancels when workspace prompt returns undefined", async () => {
    const tmpDir = makeTempDir();
    const ctx = {
      mode: "tui",
      ui: {
        input: vi
          .fn()
          .mockResolvedValueOnce("opencode-go")
          .mockResolvedValueOnce(undefined)
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

  it("cancels when workspace prompt returns whitespace", async () => {
    const tmpDir = makeTempDir();
    const ctx = {
      mode: "tui",
      ui: {
        input: vi
          .fn()
          .mockResolvedValueOnce("opencode-go")
          .mockResolvedValueOnce("   ")
          .mockResolvedValueOnce("   ")
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

  it("writes account-scoped config and notifies when prompts succeed", async () => {
    const tmpDir = makeTempDir();
    const ctx = {
      mode: "tui",
      ui: {
        input: vi
          .fn()
          .mockResolvedValueOnce("opencode-go")
          .mockResolvedValueOnce("main")
          .mockResolvedValueOnce("wrk_abc")
          .mockResolvedValueOnce("Fe26.2**cookie"),
        notify: vi.fn(),
      },
    };
    await runOpencodeAuthSetup(ctx as never, tmpDir);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Opencode auth saved"),
      "info",
    );
    const config = readConfig(tmpDir);
    expect(config?.opencode?.accounts?.["opencode-go"]).toEqual({
      label: "main",
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
          .mockResolvedValueOnce("opencode-go")
          .mockResolvedValueOnce("test")
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
    expect(config?.opencode?.accounts?.["opencode-go"]).toEqual({
      label: "test",
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
        opencode: {
          accounts: {
            "opencode-go": { workspaceId: "old", authCookie: "old" },
          },
        },
      }),
    );
    const ctx = {
      mode: "tui",
      ui: {
        input: vi
          .fn()
          .mockResolvedValueOnce("opencode-go-1")
          .mockResolvedValueOnce("new")
          .mockResolvedValueOnce("wrk_new")
          .mockResolvedValueOnce("Fe26.2**new"),
        notify: vi.fn(),
      },
    };
    await runOpencodeAuthSetup(ctx as never, tmpDir);
    const config = readConfig(tmpDir);
    expect(config).toEqual({
      codex: { token: "abc" },
      opencode: {
        accounts: {
          "opencode-go": { workspaceId: "old", authCookie: "old" },
          "opencode-go-1": {
            workspaceId: "wrk_new",
            authCookie: "Fe26.2**new",
            label: "new",
          },
        },
      },
    });
    rmSync(tmpDir, { recursive: true, force: true });
  });
});
