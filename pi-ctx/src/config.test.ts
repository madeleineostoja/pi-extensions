import { describe, it, expect, vi } from "vitest";
import { DEFAULTS, defaultConfig, loadConfig } from "./config.ts";

function enoent(): NodeJS.ErrnoException {
	const err = new Error("ENOENT: no such file") as NodeJS.ErrnoException;
	err.code = "ENOENT";
	return err;
}

function makeReader(content: string | Error) {
	return (_path: string, _enc: "utf8"): string => {
		if (content instanceof Error) throw content;
		return content;
	};
}

describe("loadConfig", () => {
	it("returns defaults when file is missing (ENOENT)", () => {
		const notify = vi.fn();
		const config = loadConfig(notify, makeReader(enoent()));
		expect(config).toEqual(DEFAULTS);
		expect(notify).not.toHaveBeenCalled();
	});

	it("returns all four keys from a valid JSON file", () => {
		const notify = vi.fn();
		const config = loadConfig(
			notify,
			makeReader(JSON.stringify({
				staleTurns: 8,
				minTokens: 512,
				supersededReadsEnabled: false,
				duplicateReadsEnabled: false,
			})),
		);
		expect(config.staleTurns).toBe(8);
		expect(config.minTokens).toBe(512);
		expect(config.supersededReadsEnabled).toBe(false);
		expect(config.duplicateReadsEnabled).toBe(false);
		expect(notify).not.toHaveBeenCalled();
	});

	it("applies partial config selectively, uses defaults for missing keys", () => {
		const notify = vi.fn();
		const config = loadConfig(notify, makeReader(JSON.stringify({ staleTurns: 10 })));
		expect(config.staleTurns).toBe(10);
		expect(config.minTokens).toBe(DEFAULTS.minTokens);
		expect(config.supersededReadsEnabled).toBe(DEFAULTS.supersededReadsEnabled);
		expect(config.duplicateReadsEnabled).toBe(DEFAULTS.duplicateReadsEnabled);
		expect(notify).not.toHaveBeenCalled();
	});

	it("returns defaults and calls notify once for malformed JSON", () => {
		const notify = vi.fn();
		const config = loadConfig(notify, makeReader("{ not valid json }"));
		expect(config).toEqual(DEFAULTS);
		expect(notify).toHaveBeenCalledTimes(1);
		expect(notify.mock.calls[0][1]).toBe("warning");
	});

	it("returns default for wrong-type value and calls notify once per bad key", () => {
		const notify = vi.fn();
		const config = loadConfig(notify, makeReader(JSON.stringify({ staleTurns: "four" })));
		expect(config.staleTurns).toBe(DEFAULTS.staleTurns);
		expect(notify).toHaveBeenCalledTimes(1);
		const [msg, level] = notify.mock.calls[0];
		expect(level).toBe("warning");
		expect(msg).toContain("staleTurns");
	});

	it("treats negative staleTurns as invalid", () => {
		const notify = vi.fn();
		const config = loadConfig(notify, makeReader(JSON.stringify({ staleTurns: -1 })));
		expect(config.staleTurns).toBe(DEFAULTS.staleTurns);
		expect(notify).toHaveBeenCalledTimes(1);
	});

	it("treats negative minTokens as invalid", () => {
		const notify = vi.fn();
		const config = loadConfig(notify, makeReader(JSON.stringify({ minTokens: -100 })));
		expect(config.minTokens).toBe(DEFAULTS.minTokens);
		expect(notify).toHaveBeenCalledTimes(1);
	});

	it("emits one warning per bad key when multiple keys are wrong", () => {
		const notify = vi.fn();
		loadConfig(
			notify,
			makeReader(JSON.stringify({ staleTurns: "bad", minTokens: "bad" })),
		);
		expect(notify).toHaveBeenCalledTimes(2);
	});

	it("silently ignores unknown keys", () => {
		const notify = vi.fn();
		const config = loadConfig(
			notify,
			makeReader(JSON.stringify({ fooBar: 1, staleTurns: 6 })),
		);
		expect(config.staleTurns).toBe(6);
		expect(notify).not.toHaveBeenCalled();
	});

	it("wrong-type boolean emits warning and uses default", () => {
		const notify = vi.fn();
		const config = loadConfig(
			notify,
			makeReader(JSON.stringify({ supersededReadsEnabled: "yes" })),
		);
		expect(config.supersededReadsEnabled).toBe(DEFAULTS.supersededReadsEnabled);
		expect(notify).toHaveBeenCalledTimes(1);
		const [msg, level] = notify.mock.calls[0];
		expect(level).toBe("warning");
		expect(msg).toContain("supersededReadsEnabled");
	});

	it("returns defaults and calls notify for unreadable file (non-ENOENT error)", () => {
		const permErr = new Error("EACCES: permission denied") as NodeJS.ErrnoException;
		permErr.code = "EACCES";
		const notify = vi.fn();
		const config = loadConfig(notify, makeReader(permErr));
		expect(config).toEqual(DEFAULTS);
		expect(notify).toHaveBeenCalledTimes(1);
		expect(notify.mock.calls[0][1]).toBe("warning");
	});
});

describe("defaultConfig", () => {
	it("returns a copy of DEFAULTS", () => {
		const c = defaultConfig();
		expect(c).toEqual(DEFAULTS);
	});

	it("returns a new object each time (not the same reference)", () => {
		expect(defaultConfig()).not.toBe(defaultConfig());
	});
});
