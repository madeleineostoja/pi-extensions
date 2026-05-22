import { describe, it, expect } from "vitest";
import { literalPrefix } from "../glob-prefix.js";

describe("literalPrefix", () => {
  describe("literal-only patterns (no glob meta-chars)", () => {
    it("returns the whole pattern for a plain absolute path", () => {
      expect(literalPrefix("/etc/passwd")).toBe("/etc/passwd");
    });

    it("returns the whole pattern for a relative path", () => {
      expect(literalPrefix("some/path/to/file")).toBe("some/path/to/file");
    });

    it("returns the whole pattern for a bare filename", () => {
      expect(literalPrefix("file.txt")).toBe("file.txt");
    });

    it("returns the whole expanded home path", () => {
      expect(literalPrefix("/Users/me/.aws/credentials")).toBe("/Users/me/.aws/credentials");
    });
  });

  describe("unrooted globs — no '/' before first meta-char", () => {
    it('returns null for "**/.env"', () => {
      expect(literalPrefix("**/.env")).toBeNull();
    });

    it('returns null for "**/.ssh/**"', () => {
      expect(literalPrefix("**/.ssh/**")).toBeNull();
    });

    it('returns null for "**/*.pem"', () => {
      expect(literalPrefix("**/*.pem")).toBeNull();
    });

    it('returns null for a pattern starting with "?"', () => {
      expect(literalPrefix("?.txt")).toBeNull();
    });

    it('returns null for a pattern starting with "["', () => {
      expect(literalPrefix("[abc]/file")).toBeNull();
    });

    it('returns null for "a*" (meta-char before any slash)', () => {
      expect(literalPrefix("a*")).toBeNull();
    });
  });

  describe("anchored globs — returns prefix up to and including the last '/'", () => {
    it('extracts "/Users/me/.ssh/" from "/Users/me/.ssh/**"', () => {
      expect(literalPrefix("/Users/me/.ssh/**")).toBe("/Users/me/.ssh/");
    });

    it('extracts "/wd/" from "/wd/**/.env"', () => {
      expect(literalPrefix("/wd/**/.env")).toBe("/wd/");
    });

    it('extracts "/wd/" from "/wd/**/.env.*"', () => {
      expect(literalPrefix("/wd/**/.env.*")).toBe("/wd/");
    });

    it('extracts "/home/me/.aws/" from "/home/me/.aws/cred*"', () => {
      expect(literalPrefix("/home/me/.aws/cred*")).toBe("/home/me/.aws/");
    });

    it('extracts "a/" from "a/*"', () => {
      expect(literalPrefix("a/*")).toBe("a/");
    });

    it('extracts "a/b/" from "a/b/*"', () => {
      expect(literalPrefix("a/b/*")).toBe("a/b/");
    });

    it('extracts "/" from "/*"', () => {
      expect(literalPrefix("/*")).toBe("/");
    });
  });

  describe("edge cases", () => {
    it('returns null for "a/b*" — meta-char cuts off at "a/b" but last slash gives "a/"', () => {
      expect(literalPrefix("a/b*")).toBe("a/");
    });

    it('returns "/" for "/a*" — meta-char at index 2, before-meta is "/a", last slash is at 0', () => {
      expect(literalPrefix("/a*")).toBe("/");
    });

    it('returns null for "*" (single meta-char, no slash)', () => {
      expect(literalPrefix("*")).toBeNull();
    });

    it('returns null for "?" (single meta-char, no slash)', () => {
      expect(literalPrefix("?")).toBeNull();
    });

    it('returns "/" for "/{a,b}" — meta-char "{" at index 1, before-meta is "/", last slash is 0', () => {
      expect(literalPrefix("/{a,b}")).toBe("/");
    });

    it('returns null for "{a,b}/file" — meta-char before any slash', () => {
      expect(literalPrefix("{a,b}/file")).toBeNull();
    });

    it('treats "!" as a meta-char and returns null for "!file"', () => {
      expect(literalPrefix("!file")).toBeNull();
    });

    it('treats "!" as a meta-char and returns prefix for "/path/!file"', () => {
      expect(literalPrefix("/path/!file")).toBe("/path/");
    });
  });
});
