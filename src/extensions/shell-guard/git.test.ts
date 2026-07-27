import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { classifyGitRecoverability, isInsideWorkTree } from "./git";

describe("isInsideWorkTree", () => {
  it("returns false outside a repo", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-guard-"));
    try {
      expect(isInsideWorkTree(dir)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("returns true inside a repo", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-guard-"));
    execSync("git init", { cwd: dir });
    try {
      expect(isInsideWorkTree(dir)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});

describe("classifyGitRecoverability", () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "pi-guard-"));
    execSync("git init", { cwd: repo });
    execSync("git config user.email test@test.com", { cwd: repo });
    execSync("git config user.name Test", { cwd: repo });
  });

  afterEach(() => {
    try {
      rmSync(repo, { recursive: true });
    } catch {}
  });

  it("classifies clean tracked file as tracked-clean", () => {
    const file = join(repo, "tracked.md");
    writeFileSync(file, "hello");
    execSync("git add tracked.md", { cwd: repo });
    execSync('git commit -m "init"', { cwd: repo });
    expect(classifyGitRecoverability(repo, file)).toBe("tracked-clean");
  });

  it("classifies dirty tracked file as tracked-dirty", () => {
    const file = join(repo, "tracked.md");
    writeFileSync(file, "hello");
    execSync("git add tracked.md", { cwd: repo });
    execSync('git commit -m "init"', { cwd: repo });
    writeFileSync(file, "changed");
    expect(classifyGitRecoverability(repo, file)).toBe("tracked-dirty");
  });

  it("classifies untracked file as untracked", () => {
    const file = join(repo, "untracked.md");
    writeFileSync(file, "hello");
    expect(classifyGitRecoverability(repo, file)).toBe("untracked");
  });

  it("classifies path outside repo as not-git", () => {
    const outside = mkdtempSync(join(tmpdir(), "pi-guard-out-"));
    try {
      expect(classifyGitRecoverability(repo, outside)).toBe("not-git");
    } finally {
      rmSync(outside, { recursive: true });
    }
  });

  it("classifies tracked directory with clean contents as tracked-clean", () => {
    const dir = join(repo, "src");
    mkdirSync(dir);
    writeFileSync(join(dir, "a.ts"), "a");
    execSync("git add src", { cwd: repo });
    execSync('git commit -m "add src"', { cwd: repo });
    expect(classifyGitRecoverability(repo, dir)).toBe("tracked-clean");
  });
});
