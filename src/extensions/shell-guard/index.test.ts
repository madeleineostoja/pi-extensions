import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { assessBashCommand } from "./assessors";
import { resolveChoice } from "./handler";

describe("shell guard", () => {
  it("collects every direct risk in deterministic segment order", async () => {
    const risks = await assessBashCommand(
      "docker system prune && git push --force origin main",
      "/",
    );
    expect(risks.map((risk) => risk.category)).toEqual(["container", "git"]);
  });

  it("keeps unsupported exact destructive markers uncertain and ignores prose", async () => {
    expect(
      (await assessBashCommand("rm $TARGET", "/")).at(0)?.uncertainty,
    ).toContain("Unsupported shell syntax");
    expect(await assessBashCommand("echo rm is a word $HOME", "/")).toEqual([]);
  });

  it("filters a clean tracked target but retains an unrelated destructive risk", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pipkin-guard-"));
    try {
      execFileSync("git", ["init"], { cwd });
      execFileSync("git", ["config", "user.email", "test@example.com"], {
        cwd,
      });
      execFileSync("git", ["config", "user.name", "Test"], { cwd });
      writeFileSync(join(cwd, "clean.txt"), "clean");
      execFileSync("git", ["add", "clean.txt"], { cwd });
      execFileSync("git", ["commit", "-m", "initial"], { cwd });
      const risks = await assessBashCommand(
        "rm clean.txt && docker volume rm data",
        cwd,
      );
      expect(risks.map((risk) => risk.category)).toEqual(["container"]);
    } finally {
      rmSync(cwd, { force: true, recursive: true });
    }
  });

  it("only disables after Allow all this session", () => {
    expect(resolveChoice("Allow once", "")).toEqual({ block: false });
    expect(resolveChoice("Allow all this session", "")).toEqual({
      block: false,
      disable: true,
    });
  });
});
