import { describe, it, expect } from "vitest";
import { toAbsolutePath, extractShellWords } from "./paths";

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
