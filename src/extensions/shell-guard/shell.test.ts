import { describe, it, expect } from "vitest";
import { extractShellWords } from "./shell.js";

describe("extractShellWords", () => {
  it("tokenizes on whitespace", () => {
    expect(extractShellWords("rm file1 file2")).toEqual([
      "rm",
      "file1",
      "file2",
    ]);
    expect(extractShellWords("  rm   file1  file2  ")).toEqual([
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

  it("handles backslash escapes", () => {
    expect(extractShellWords("echo hello\\ world")).toEqual([
      "echo",
      "hello world",
    ]);
    expect(extractShellWords('echo "hello\\"world"')).toEqual([
      "echo",
      'hello"world',
    ]);
  });

  it("cuts off at shell comments", () => {
    expect(extractShellWords("rm file # delete it")).toEqual(["rm", "file"]);
  });

  it("returns undefined for unsafe metacharacters, expansions, and globs", () => {
    for (const command of [
      "rm file1; rm file2",
      "rm file1 && rm file2",
      "rm file1 || rm file2",
      "rm file1 | cat",
      "rm $(echo file)",
      "rm `echo file`",
      "rm ${VAR}",
      'rm "$TARGET"',
      "rm $TARGET",
      "rm *.txt",
      "rm ?.txt",
      "rm {a,b}.txt",
      "rm <(file)",
    ]) {
      expect(extractShellWords(command)).toBeUndefined();
    }
  });
});
