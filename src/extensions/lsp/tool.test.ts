import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  normalizeDiagnosticsResult,
  normalizeHoverResult,
} from "./normalize.js";
import { LspPool, LSP_POOL_MANAGER_KEY } from "./pool.js";
import { executeLsp, lspStatus } from "./tool.js";

const directories: string[] = [];
function workspace(): string {
  const directory = mkdtempSync(join(tmpdir(), "pi-lsp-tool-"));
  directories.push(directory);
  return directory;
}
afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
  delete (globalThis as Record<symbol, unknown>)[LSP_POOL_MANAGER_KEY];
});

const context = (cwd: string) => ({
  cwd,
  ui: { notify: vi.fn() },
});

describe("lsp tool inputs and bounded render data", () => {
  it("requires a deterministic 1-indexed position", async () => {
    const cwd = workspace();
    writeFileSync(join(cwd, "sample.ts"), "const value = 1;\n");
    const result = await executeLsp(
      { action: "definition", file: "sample.ts", line: 1 },
      undefined,
      context(cwd) as never,
    );
    expect(result.details).toMatchObject({ available: true, success: false });
    expect(result.content[0]?.text).toContain("requires column or symbol");
  });

  it("rejects targets outside the caller workspace without starting a server", async () => {
    const cwd = workspace();
    const outside = workspace();
    writeFileSync(join(outside, "sample.ts"), "const value = 1;\n");
    const result = await executeLsp(
      { action: "document_symbols", file: join(outside, "sample.ts") },
      undefined,
      context(cwd) as never,
    );
    expect(result.details).toMatchObject({ available: false, success: false });
    expect(result.content[0]?.text).toContain("outside workspace");
  });

  it("preserves truncation before bounded normalization", () => {
    const diagnostics = normalizeDiagnosticsResult(
      Array.from({ length: 101 }, (_, index) => ({
        message: `issue-${index}`,
        range: {},
      })),
    );
    const hover = normalizeHoverResult({ contents: "x".repeat(2_001) });
    expect(diagnostics).toMatchObject({ truncated: true });
    expect(diagnostics.items).toHaveLength(100);
    expect(hover).toMatchObject({ truncated: true });
    expect(hover.text).toHaveLength(2_000);
  });

  it("reports not-started discovery without launching configured servers", () => {
    const cwd = workspace();
    writeFileSync(join(cwd, "tsconfig.json"), "{}");
    const pool = new LspPool();
    const status = lspStatus(cwd, pool);
    expect(status).toMatchObject({ action: "status", available: true });
    expect(status.servers).toContainEqual(
      expect.objectContaining({ kind: "typescript" }),
    );
    expect(pool.status()).toEqual([]);
    void pool.shutdown();
  });

  it("reports the resolved route when acquisition fails", async () => {
    const cwd = workspace();
    const project = join(cwd, "ruby-project");
    mkdirSync(join(project, "bin"), { recursive: true });
    writeFileSync(join(project, "Gemfile"), "source 'https://rubygems.org'\n");
    writeFileSync(join(project, "bin", "ruby-lsp"), "");
    writeFileSync(join(project, "sample.rb"), "puts :hello\n");
    (globalThis as Record<symbol, unknown>)[LSP_POOL_MANAGER_KEY] = {
      pool: {
        closed: false,
        acquire: async () => {
          throw new Error("server startup failed");
        },
        shutdown() {},
      },
    };

    const result = await executeLsp(
      { action: "diagnostics", file: "ruby-project/sample.rb" },
      undefined,
      context(cwd) as never,
    );

    expect(result.details).toMatchObject({
      available: false,
      server: "ruby",
      workspace: realpathSync(project),
    });
  });

  it("uses one timeout budget for acquisition and the LSP request", async () => {
    const cwd = workspace();
    writeFileSync(join(cwd, "tsconfig.json"), "{}");
    writeFileSync(join(cwd, "sample.ts"), "const value = 1;\n");
    let acquireTimeout: number | undefined;
    let requestTimeout: number | undefined;
    const client = {
      capabilities: {},
      supports: () => true,
      semantic: async (
        _capability: unknown,
        _file: string,
        _language: string,
        _position: unknown,
        options: { timeoutMs?: number },
      ) => {
        requestTimeout = options.timeoutMs;
        return [];
      },
    };
    (globalThis as Record<symbol, unknown>)[LSP_POOL_MANAGER_KEY] = {
      pool: {
        closed: false,
        acquire: async (
          _server: unknown,
          _root: string,
          options: { timeoutMs?: number },
        ) => {
          acquireTimeout = options.timeoutMs;
          await new Promise((resolve) => setTimeout(resolve, 25));
          return client;
        },
        shutdown() {},
      },
    };

    await executeLsp(
      { action: "document_symbols", file: "sample.ts", timeout: 0.1 },
      undefined,
      context(cwd) as never,
    );

    expect(acquireTimeout).toBeGreaterThan(0);
    expect(requestTimeout).toBeGreaterThan(0);
    expect(requestTimeout).toBeLessThan(acquireTimeout! - 10);
  });
});
