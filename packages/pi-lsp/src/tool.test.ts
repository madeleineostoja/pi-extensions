import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  normalizeDiagnosticsResult,
  normalizeHoverResult,
} from "./normalize.js";
import { LspPool } from "./pool.js";
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
});
