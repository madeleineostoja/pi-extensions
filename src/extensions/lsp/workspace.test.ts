import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveServer, resolveTypeScriptSdk } from "./server.js";
import {
  assertWorkspaceFile,
  nearestWorkspaceRoot,
  serverForFile,
} from "./workspace.js";
const dirs: string[] = [];
const temp = () => {
  const value = mkdtempSync(join(tmpdir(), "pipkin-lsp-"));
  dirs.push(value);
  return value;
};
afterEach(() => {
  while (dirs.length) {
    rmSync(dirs.pop()!, { recursive: true, force: true });
  }
});
describe("workspace and server resolution", () => {
  it("routes supported files to nearest language root and rejects outside files", () => {
    const root = temp();
    const child = join(root, "app", "src");
    mkdirSync(child, { recursive: true });
    writeFileSync(join(root, "app", "tsconfig.json"), "{}");
    const file = join(child, "a.ts");
    writeFileSync(file, "");
    expect(serverForFile(file)).toBe("typescript");
    expect(nearestWorkspaceRoot("typescript", file, root)).toBeTruthy();
    expect(() =>
      assertWorkspaceFile(root, join(tmpdir(), "outside.ts")),
    ).toThrow("outside workspace");
  });
  it("uses only workspace/bin or PATH for Ruby", () => {
    const root = temp();
    const bin = join(root, "bin");
    mkdirSync(bin);
    const ruby = join(bin, "ruby-lsp");
    writeFileSync(ruby, "#!/bin/sh");
    chmodSync(ruby, 0o755);
    expect(resolveServer("ruby", root, { PATH: "" })).toMatchObject({
      command: expect.stringMatching(/bin\/ruby-lsp$/),
    });
    expect(resolveServer("ruby", temp(), { PATH: "" })).toMatchObject({
      available: false,
    });
  });
  it("finds a TypeScript SDK hoisted above the selected workspace", () => {
    const repository = temp();
    const workspace = join(repository, "packages", "app");
    const sdk = join(
      repository,
      "node_modules",
      "typescript",
      "lib",
      "tsserverlibrary.js",
    );
    mkdirSync(workspace, { recursive: true });
    mkdirSync(join(sdk, ".."), { recursive: true });
    writeFileSync(sdk, "");
    writeFileSync(
      join(repository, "node_modules", "typescript", "package.json"),
      '{"version":"1.2.3"}',
    );
    expect(resolveTypeScriptSdk(workspace)).toMatchObject({
      path: expect.stringMatching(
        /node_modules\/typescript\/lib\/tsserverlibrary\.js$/,
      ),
      source: "workspace",
      version: "1.2.3",
    });
  });
  it("records packaged TypeScript fallback metadata", () => {
    const sdk = resolveTypeScriptSdk(temp());
    expect(sdk).toMatchObject({ source: "packaged" });
    expect(sdk.version).toBeTruthy();
  });
});
