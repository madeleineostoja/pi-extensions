import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  normalizeDiagnosticsResult,
  normalizeHoverResult,
} from "./normalize.js";
import { LspPool, LSP_POOL_MANAGER_KEY } from "./pool.js";
import { LspParameters, executeLsp, lspStatus, registerLsp } from "./tool.js";

const directories: string[] = [];
function workspace(): string {
  const directory = mkdtempSync(join(tmpdir(), "pipkin-lsp-tool-"));
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
function useClient(client: Record<string, unknown>): void {
  (globalThis as Record<symbol, unknown>)[LSP_POOL_MANAGER_KEY] = {
    pool: {
      closed: false,
      acquire: async () => client,
      shutdown() {},
      status: () => [],
    },
  };
}

describe("lsp tool inputs and bounded render data", () => {
  it("renders an operation, target, and result count before complete expanded output", () => {
    let tool: any;
    registerLsp({
      registerTool: (definition: unknown) => (tool = definition),
    } as never);
    const result = {
      content: [
        {
          type: "text" as const,
          text: "definition output\n- src/value.ts:1:1",
        },
      ],
      details: { action: "definition", success: true, locations: [{}, {}] },
    };
    const theme = { fg: (_color: string, text: string) => text };
    const collapsed = tool
      .renderResult(result, { expanded: false, isPartial: false }, theme, {
        args: { file: "src/value.ts" },
        isError: false,
      })
      .render(200)
      .map((line: string) => line.trimEnd())
      .join("\n");
    const expanded = tool
      .renderResult(result, { expanded: true, isPartial: false }, theme, {
        args: { file: "src/value.ts" },
        isError: false,
      })
      .render(200)
      .map((line: string) => line.trimEnd())
      .join("\n");

    expect(collapsed).toContain("LSP definition · src/value.ts.");
    expect(collapsed).toContain("2 results.");
    expect(expanded).toContain("definition output");
  });
  it("distinguishes collapsed validation, unsupported, unavailable, stale, and thrown LSP outcomes", () => {
    const tool = (() => {
      let definition: any;
      registerLsp({
        registerTool: (value: unknown) => (definition = value),
      } as never);
      return definition;
    })();
    const theme = { fg: (_color: string, text: string) => text };
    const render = (result: unknown, args: unknown, isError = false) =>
      tool
        .renderResult(result, { expanded: false, isPartial: false }, theme, {
          args,
          isError,
        })
        .render(500)
        .map((line: string) => line.trimEnd())
        .join("\n");

    const validation = render(
      {
        content: [{ type: "text", text: "definition requires file" }],
        details: { action: "definition", available: true, success: false },
      },
      { symbol: "value\n\u001b[31m", file: "src/value.ts\nextra" },
    );
    expect(validation).toContain(
      "LSP definition · symbol “value” in src/value.ts extra.",
    );
    expect(validation).toContain(
      "Request is invalid: definition requires file.",
    );
    expect(validation.split("\n")).toHaveLength(2);

    expect(
      render(
        {
          content: [{ type: "text", text: "capability failure" }],
          details: {
            action: "implementation",
            available: true,
            success: false,
            unsupported: true,
            server: "typescript",
          },
        },
        { file: "src/value.ts" },
      ),
    ).toContain("The requested capability is unsupported by typescript.");
    expect(
      render(
        {
          content: [{ type: "text", text: "full server failure" }],
          details: {
            action: "references",
            available: false,
            success: false,
            server: "typescript",
            reason: "startup failed",
          },
        },
        { symbol: "value", file: "src/value.ts" },
      ),
    ).toContain("typescript server is unavailable: startup failed.");
    expect(
      render(
        {
          content: [{ type: "text", text: "full stale diagnostics" }],
          details: {
            action: "diagnostics",
            available: true,
            success: false,
            stale: true,
            timedOut: true,
          },
        },
        { file: "src/value.ts" },
      ),
    ).toContain("Diagnostics are stale after the timeout.");
    expect(
      render(
        { content: [{ type: "text", text: "x".repeat(1_000) }] },
        { query: "widget" },
        true,
      ),
    ).toHaveLength(240);
  });

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

  it("reports stale symbol positions without marking the server unavailable", async () => {
    const cwd = workspace();
    writeFileSync(join(cwd, "tsconfig.json"), "{}");
    writeFileSync(join(cwd, "sample.ts"), "const value = 1;\n");
    const acquire = vi.fn();
    const notify = vi.fn();
    (globalThis as Record<symbol, unknown>)[LSP_POOL_MANAGER_KEY] = {
      pool: {
        closed: false,
        acquire,
        shutdown() {},
        status: () => [],
      },
    };

    const result = await executeLsp(
      {
        action: "references",
        file: "sample.ts",
        line: 1,
        symbol: "missing",
      },
      undefined,
      { cwd, ui: { notify } } as never,
    );

    expect(result.content[0]?.text).toContain(
      'symbol "missing" occurrence 1 was not found on line 1',
    );
    expect(result.details).toMatchObject({
      available: true,
      success: false,
      invalidPosition: true,
    });
    expect(acquire).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
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

  it("returns semantic locations relative to the caller workspace", async () => {
    const cwd = workspace();
    const project = join(cwd, "project");
    mkdirSync(project);
    writeFileSync(join(project, "tsconfig.json"), "{}");
    writeFileSync(join(project, "sample.ts"), "const value = 1;\n");
    writeFileSync(join(project, "target.ts"), "export const value = 1;\n");
    useClient({
      capabilities: {},
      supports: () => true,
      semantic: async () => [
        {
          uri: pathToFileURL(join(project, "target.ts")).href,
          range: {
            start: { line: 2, character: 4 },
            end: { line: 2, character: 9 },
          },
        },
      ],
    });

    const result = await executeLsp(
      {
        action: "definition",
        file: "project/sample.ts",
        line: 1,
        column: 7,
      },
      undefined,
      context(cwd) as never,
    );

    expect(result.content[0]?.text).toBe(
      "1 LSP definition location:\n- project/target.ts:3:5",
    );
    expect(result.details.locations).toEqual([
      expect.objectContaining({ file: expect.stringMatching(/target\.ts$/) }),
    ]);
  });

  it("preserves document symbol ranges in model-visible content", async () => {
    const cwd = workspace();
    writeFileSync(join(cwd, "tsconfig.json"), "{}");
    writeFileSync(join(cwd, "sample.ts"), "const value = 1;\n");
    useClient({
      capabilities: {},
      supports: () => true,
      semantic: async () => [
        {
          name: "value",
          kind: 13,
          selectionRange: {
            start: { line: 0, character: 6 },
            end: { line: 0, character: 11 },
          },
        },
      ],
    });

    const result = await executeLsp(
      { action: "document_symbols", file: "sample.ts" },
      undefined,
      context(cwd) as never,
    );

    expect(result.content[0]?.text).toBe(
      "1 LSP document symbol:\n- value — sample.ts:1:7",
    );
    expect(result.details.symbols).toEqual([
      expect.objectContaining({
        name: "value",
        location: expect.objectContaining({
          file: expect.stringMatching(/sample\.ts$/),
        }),
      }),
    ]);
  });

  it("returns diagnostic messages and positions in model-visible content", async () => {
    const cwd = workspace();
    writeFileSync(join(cwd, "tsconfig.json"), "{}");
    writeFileSync(join(cwd, "sample.ts"), "const value = 1;\n");
    useClient({
      capabilities: {},
      diagnostics: async () => ({
        diagnostics: [
          {
            severity: 1,
            source: "ts",
            code: 2322,
            message: "Type 'number' is not assignable to type 'string'.",
            range: {
              start: { line: 0, character: 6 },
              end: { line: 0, character: 11 },
            },
          },
        ],
        fresh: true,
        truncated: false,
      }),
    });

    const result = await executeLsp(
      { action: "diagnostics", file: "sample.ts" },
      undefined,
      context(cwd) as never,
    );

    expect(result.content[0]?.text).toContain(
      "error ts:2322 sample.ts:1:7 — Type 'number' is not assignable to type 'string'.",
    );
    expect(result.details.diagnostics).toEqual([
      expect.objectContaining({
        file: expect.stringMatching(/sample\.ts$/),
        message: "Type 'number' is not assignable to type 'string'.",
      }),
    ]);
  });

  it("documents that workspace_symbols requires query", async () => {
    expect(
      (
        LspParameters.properties.query as unknown as {
          description: string;
        }
      ).description,
    ).toContain("required when action is workspace_symbols");
    const result = await executeLsp(
      { action: "workspace_symbols" },
      undefined,
      context(workspace()) as never,
    );
    expect(result.content[0]?.text).toContain(
      "workspace_symbols requires query",
    );
  });

  it("bounds aggregate model-visible output", async () => {
    const cwd = workspace();
    writeFileSync(join(cwd, "tsconfig.json"), "{}");
    useClient({
      capabilities: {},
      supports: () => true,
      workspaceSymbols: async () =>
        Array.from({ length: 100 }, (_, index) => ({
          name: `${index}-${"x".repeat(2_000)}`,
          kind: 13,
        })),
    });

    const result = await executeLsp(
      { action: "workspace_symbols", query: "x" },
      undefined,
      context(cwd) as never,
    );
    const content = result.content[0]?.text ?? "";

    expect(Buffer.byteLength(content, "utf8")).toBeLessThanOrEqual(
      DEFAULT_MAX_BYTES,
    );
    expect(content.split("\n").length).toBeLessThanOrEqual(DEFAULT_MAX_LINES);
    expect(content).toContain("Additional results omitted");
    expect(result.details).toMatchObject({
      truncation: { symbols: false, content: true },
    });
  });

  it("bounds aggregate status output", async () => {
    const cwd = workspace();
    (globalThis as Record<symbol, unknown>)[LSP_POOL_MANAGER_KEY] = {
      pool: {
        closed: false,
        acquire() {},
        shutdown() {},
        status: () => [
          {
            kind: "typescript",
            state: "cooling-down",
            workspaceRoot: realpathSync(cwd),
            reason: `x\n`.repeat(DEFAULT_MAX_LINES + 100),
          },
        ],
      },
    };

    const result = await executeLsp(
      { action: "status" },
      undefined,
      context(cwd) as never,
    );
    const content = result.content[0]?.text ?? "";

    expect(Buffer.byteLength(content, "utf8")).toBeLessThanOrEqual(
      DEFAULT_MAX_BYTES,
    );
    expect(content.split("\n").length).toBeLessThanOrEqual(DEFAULT_MAX_LINES);
    expect(content).toContain("Additional results omitted");
    expect(result.details).toMatchObject({
      truncation: { content: true },
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
