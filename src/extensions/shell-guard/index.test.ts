import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assessBashCommand } from "./assessors";
import { resolveChoice } from "./handler";
import { formatRisks } from "./index";

describe("shell guard", () => {
  it("collects every direct risk in deterministic segment and category order", async () => {
    const risks = await assessBashCommand(
      "docker system prune > out && git push --force origin main",
      "/",
    );
    expect(risks.map((risk) => [risk.category, risk.effect])).toEqual([
      ["filesystem", "truncating redirection"],
      ["container", "container data deletion"],
      ["git", "destructive Git operation"],
    ]);
  });

  it("recognizes bounded uncertain families without gating prose", async () => {
    const find = await assessBashCommand("find . -exec rm {} \\;", "/");
    const xargs = await assessBashCommand("xargs rm", "/");
    const ssh = await assessBashCommand("ssh host rm file", "/");
    expect(find[0]?.uncertainty).toBeTruthy();
    expect(xargs[0]?.uncertainty).toContain("not interpreted");
    expect(ssh[0]?.uncertainty).toContain("not interpreted");
    expect(await assessBashCommand("echo xargs rm is prose", "/")).toEqual([]);
  });

  it("normalizes wrappers, redirections, and one literal shell payload without gating local installs", async () => {
    expect(
      (
        await assessBashCommand(
          "sudo -u root env -u NAME command -p rm file 2>&1",
          "/",
        )
      ).map((risk) => risk.effect),
    ).toEqual(["file removal"]);
    expect(
      (await assessBashCommand("bash -c 'rm file'", "/")).map(
        (risk) => risk.effect,
      ),
    ).toEqual(["file removal"]);
    expect(
      (
        await assessBashCommand("curl https://example.test/install | sh", "/")
      ).map((risk) => risk.effect),
    ).toContain("remote script execution");
    expect(await assessBashCommand("npm install local-package", "/")).toEqual(
      [],
    );
  });

  it("does not exempt dirty or untracked repository data", async () => {
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
      expect(await assessBashCommand("rm clean.txt", cwd)).toEqual([]);
      writeFileSync(join(cwd, "clean.txt"), "dirty");
      writeFileSync(join(cwd, "untracked file.txt"), "untracked");
      expect(
        (
          await assessBashCommand(
            "rm clean.txt && rm 'untracked file.txt'",
            cwd,
          )
        ).map((risk) => risk.targets),
      ).toHaveLength(2);
    } finally {
      rmSync(cwd, { force: true, recursive: true });
    }
  });

  it("retains summaries for later risks when early details are oversized", () => {
    const detail = formatRisks([
      {
        category: "filesystem",
        severity: "high",
        effect: "file removal",
        segment: "x".repeat(30_000),
        targets: ["y".repeat(30_000)],
        segmentIndex: 0,
      },
      {
        category: "publish",
        severity: "medium",
        effect: "package publish",
        segment: "npm publish",
        targets: [],
        segmentIndex: 1,
      },
    ]);
    expect(detail.length).toBeLessThanOrEqual(16_384);
    expect(detail).toContain("package publish");
    expect(detail).toContain("detail truncated");
  });

  it("only disables after Allow all this session", () => {
    expect(resolveChoice("Allow once", "")).toEqual({ block: false });
    expect(resolveChoice("Allow all this session", "")).toEqual({
      block: false,
      disable: true,
    });
  });
});
