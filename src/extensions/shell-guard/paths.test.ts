import { describe, it, expect } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  expandKnownTempEnvVars,
  extractShellWords,
  isDisposableTempTarget,
  toAbsolutePath,
} from "./paths";

describe("path parsing helpers", () => {
  it("resolves relative paths against cwd and leaves absolute paths unchanged", () => {
    expect(toAbsolutePath("foo/bar", "/home/user")).toBe("/home/user/foo/bar");
    expect(toAbsolutePath("/tmp/foo", "/home/user")).toBe("/tmp/foo");
  });

  it("extracts quoted and unquoted shell words", () => {
    expect(extractShellWords("rm file1 file2")).toEqual([
      "rm",
      "file1",
      "file2",
    ]);
    expect(extractShellWords("rm 'file 1' file2")).toEqual([
      "rm",
      "file 1",
      "file2",
    ]);
    expect(extractShellWords('rm "file 1" file2')).toEqual([
      "rm",
      "file 1",
      "file2",
    ]);
  });

  it("refuses shell words requiring expansion or compound command parsing", () => {
    for (const command of [
      "rm file1; rm file2",
      "rm file1 && rm file2",
      "rm file1 | cat",
      "rm $(echo file)",
      'rm "$TARGET"',
      "rm *.txt",
      "rm {a,b}.txt",
    ]) {
      expect(extractShellWords(command)).toBeUndefined();
    }
  });
});

describe("expandKnownTempEnvVars", () => {
  it("expands known temp env vars", () => {
    const previous = process.env.TMPDIR;
    const base = tmpdir();
    process.env.TMPDIR = join(base, "pi-guard-env");
    try {
      expect(expandKnownTempEnvVars("$TMPDIR/file")).toBe(
        join(base, "pi-guard-env", "file"),
      );
    } finally {
      if (previous === undefined) {
        delete process.env.TMPDIR;
      } else {
        process.env.TMPDIR = previous;
      }
    }
  });

  it("rejects unknown env vars", () => {
    expect(expandKnownTempEnvVars("$HOME/file")).toBeUndefined();
  });
});

describe("isDisposableTempTarget", () => {
  it("allows children of known temp roots", () => {
    expect(
      isDisposableTempTarget(join(tmpdir(), "pi-guard-target"), "/home/user"),
    ).toBe(true);
  });

  it("rejects temp roots themselves", () => {
    expect(isDisposableTempTarget(tmpdir(), "/home/user")).toBe(false);
  });

  it("rejects globbed temp targets", () => {
    expect(isDisposableTempTarget(join(tmpdir(), "*"), "/home/user")).toBe(
      false,
    );
  });

  it("allows cwd-local tmp root and children", () => {
    const cwd = join(tmpdir(), "pi-guard-repo");
    expect(isDisposableTempTarget("tmp", cwd)).toBe(true);
    expect(isDisposableTempTarget("tmp/file.txt", cwd)).toBe(true);
    expect(isDisposableTempTarget("./tmp/nested", cwd)).toBe(true);
  });

  it("rejects paths inside protected roots", () => {
    const cwd = join(tmpdir(), "pi-guard-repo");
    expect(isDisposableTempTarget(join(cwd, "file.txt"), cwd)).toBe(false);
  });
});
