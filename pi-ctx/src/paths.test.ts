import { describe, it, expect } from "vitest";
import { homedir } from "node:os";
import { normalizePath, extractFilePath } from "./paths.ts";

describe("normalizePath", () => {
	it("resolves a relative path against cwd", () => {
		expect(normalizePath("src/foo.ts", "/repo")).toBe("/repo/src/foo.ts");
	});

	it("resolves an explicit ./ path against cwd", () => {
		expect(normalizePath("./src/foo.ts", "/repo")).toBe("/repo/src/foo.ts");
	});

	it("keeps an absolute input, ignoring cwd", () => {
		expect(normalizePath("/etc/hosts", "/repo")).toBe("/etc/hosts");
	});

	it("resolves a ../ path against cwd", () => {
		expect(normalizePath("../sibling/foo.ts", "/repo/sub")).toBe("/repo/sibling/foo.ts");
	});

	it("returns null for an empty string", () => {
		expect(normalizePath("", "/repo")).toBeNull();
	});

	it("returns null for a whitespace-only string", () => {
		expect(normalizePath("   ", "/repo")).toBeNull();
	});

	it("returns null for undefined", () => {
		expect(normalizePath(undefined, "/repo")).toBeNull();
	});

	it("returns null for a number", () => {
		expect(normalizePath(123, "/repo")).toBeNull();
	});

	it("strips a leading @ before resolving", () => {
		expect(normalizePath("@src/foo.ts", "/repo")).toBe("/repo/src/foo.ts");
	});

	it("returns null for a bare @ with nothing after it", () => {
		expect(normalizePath("@", "/repo")).toBeNull();
	});

	it("returns null for @ followed only by whitespace", () => {
		expect(normalizePath("@   ", "/repo")).toBeNull();
	});

	it("expands ~/ to the home directory", () => {
		expect(normalizePath("~/projects/foo.ts", "/repo")).toBe(`${homedir()}/projects/foo.ts`);
	});

	it("does not expand ~ without a trailing slash", () => {
		expect(normalizePath("~foo.ts", "/repo")).toBe("/repo/~foo.ts");
	});
});

describe("extractFilePath", () => {
	it("returns path from a read tool input", () => {
		expect(extractFilePath("read", { path: "src/foo.ts" })).toBe("src/foo.ts");
	});

	it("returns path from an edit tool input", () => {
		expect(extractFilePath("edit", { path: "src/foo.ts" })).toBe("src/foo.ts");
	});

	it("returns path from a write tool input", () => {
		expect(extractFilePath("write", { path: "src/foo.ts" })).toBe("src/foo.ts");
	});

	it("returns file_path when path is absent (Pi accepts both)", () => {
		expect(extractFilePath("read", { file_path: "src/foo.ts" })).toBe("src/foo.ts");
	});

	it("prefers path over file_path when both are present", () => {
		expect(extractFilePath("read", { path: "a.ts", file_path: "b.ts" })).toBe("a.ts");
	});

	it("returns file_path for edit tool", () => {
		expect(extractFilePath("edit", { file_path: "src/foo.ts" })).toBe("src/foo.ts");
	});

	it("returns file_path for write tool", () => {
		expect(extractFilePath("write", { file_path: "src/foo.ts" })).toBe("src/foo.ts");
	});

	it("returns null for an unknown tool", () => {
		expect(extractFilePath("bash", { command: "ls" })).toBeNull();
	});

	it("returns null when neither path nor file_path is present", () => {
		expect(extractFilePath("read", {})).toBeNull();
	});

	it("returns null when path field is not a string", () => {
		expect(extractFilePath("read", { path: 42 })).toBeNull();
	});

	it("returns null when only file_path is non-string", () => {
		expect(extractFilePath("read", { file_path: 42 })).toBeNull();
	});
});

describe("normalizePath + extractFilePath combined", () => {
	it("end-to-end: extracts and normalizes a file path from a read input", () => {
		const input = { path: "src/foo.ts" };
		const cwd = "/repo";
		expect(normalizePath(extractFilePath("read", input), cwd)).toBe("/repo/src/foo.ts");
	});

	it("end-to-end: file_path field is extracted and normalized", () => {
		const input = { file_path: "src/foo.ts" };
		const cwd = "/repo";
		expect(normalizePath(extractFilePath("read", input), cwd)).toBe("/repo/src/foo.ts");
	});

	it("end-to-end: @ prefix is stripped during normalization", () => {
		const input = { path: "@src/foo.ts" };
		const cwd = "/repo";
		expect(normalizePath(extractFilePath("read", input), cwd)).toBe("/repo/src/foo.ts");
	});

	it("end-to-end: returns null for an unknown tool", () => {
		const input = { command: "ls" };
		const cwd = "/repo";
		expect(normalizePath(extractFilePath("bash", input), cwd)).toBeNull();
	});

	it("end-to-end: returns null when path field is missing", () => {
		const input = {};
		const cwd = "/repo";
		expect(normalizePath(extractFilePath("read", input), cwd)).toBeNull();
	});
});
