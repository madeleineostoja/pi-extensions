import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import type { SandboxPolicy } from "./policy.js";
import { SANDBOX_EXECUTABLE, sandboxArguments } from "./seatbelt.js";

const directories: string[] = [];

afterEach(() => {
  while (directories.length) {
    rmSync(directories.pop()!, { force: true, recursive: true });
  }
});

describe("Sandbox Seatbelt integration", () => {
  it.skipIf(
    process.platform !== "darwin" || process.env.PI_CODING_AGENT === "true",
  )(
    "uses the production profile to allow workspace writes and deny siblings",
    () => {
      const parent = mkdtempSync(join(tmpdir(), "pipkin-seatbelt-"));
      directories.push(parent);
      const workspace = join(parent, "workspace");
      const outside = join(parent, "outside.txt");
      mkdirSync(workspace);
      writeFileSync(outside, "before");
      const policy: SandboxPolicy = {
        sessionCwd: workspace,
        workspaceRoot: workspace,
        temporaryRoots: [],
        cacheRoots: [],
        writableRoots: [workspace],
      };
      const result = spawnSync(
        SANDBOX_EXECUTABLE,
        sandboxArguments({ policy, shell: { shell: "/bin/sh", args: ["-s"] } }),
        {
          cwd: workspace,
          input:
            "printf inside > inside.txt\nprintf changed > ../outside.txt\n",
          encoding: "utf8",
        },
      );
      expect(result.status).not.toBe(0);
      expect(readFileSync(join(workspace, "inside.txt"), "utf8")).toBe(
        "inside",
      );
      expect(readFileSync(outside, "utf8")).toBe("before");
    },
  );
});
