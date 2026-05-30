import { describe, it, expect } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  expandKnownTempEnvVars,
  extractShellWords,
  isDisposableTempTarget,
  toAbsolutePath,
} from "./paths";

describe("toAbsolutePath", () => {
  it("resolves relative paths against cwd", () => {
    expect(toAbsolutePath("foo/bar", "/home/user")).toBe("/home/user/foo/bar");
  });

  it("returns absolute paths unchanged", () => {
    expect(toAbsolutePath("/tmp/foo", "/home/user")).toBe("/tmp/foo");
  });
});

describe("extractShellWords", () => {
  it("extracts unquoted words", () => {
    expect(extractShellWords("rm file1 file2")).toEqual([
      "rm",
      "file1",
      "file2",
    ]);
  });

  it("extracts single-quoted words", () => {
    expect(extractShellWords("rm 'file 1' file2")).toEqual([
      "rm",
      "file 1",
      "file2",
    ]);
  });

  it("extracts double-quoted words", () => {
    expect(extractShellWords('rm "file 1" file2')).toEqual([
      "rm",
      "file 1",
      "file2",
    ]);
  });

  it("returns undefined for semicolon", () => {
    expect(extractShellWords("rm file1; rm file2")).toBeUndefined();
  });

  it("returns undefined for &&", () => {
    expect(extractShellWords("rm file1 && rm file2")).toBeUndefined();
  });

  it("returns undefined for pipe", () => {
    expect(extractShellWords("rm file1 | cat")).toBeUndefined();
  });

  it("returns undefined for command substitution", () => {
    expect(extractShellWords("rm $(echo file)")).toBeUndefined();
  });

  it("returns undefined for variable", () => {
    expect(extractShellWords('rm "$TARGET"')).toBeUndefined();
  });

  it("returns undefined for globs", () => {
    expect(extractShellWords("rm *.txt")).toBeUndefined();
  });

  it("returns undefined for brace expansion", () => {
    expect(extractShellWords("rm {a,b}.txt")).toBeUndefined();
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

  it("rejects paths inside protected roots", () => {
    const cwd = join(tmpdir(), "pi-guard-repo");
    expect(isDisposableTempTarget(join(cwd, "file.txt"), cwd)).toBe(false);
  });
});
