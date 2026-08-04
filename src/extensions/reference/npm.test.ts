import { existsSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { NpmError, npmEnvironment, searchNpm } from "./npm.js";

describe("npm package search boundary", () => {
  it("uses fixed argv, isolated cwd/config, minimal environment, and removes temporary state", async () => {
    const run = vi.fn(
      (_file: string, _args: string[], _options: Record<string, unknown>) =>
        Object.assign(
          Promise.resolve({
            exitCode: 0,
            stdout: JSON.stringify([
              {
                name: "@acme/widget",
                version: "1.0.0",
                description: "widget",
                publisher: { username: "owner", email: "hidden@example.test" },
              },
            ]),
            stderr: "",
          }),
          { kill: vi.fn(() => true) },
        ),
    );
    const result = await searchNpm(
      "--strange;query",
      3,
      new AbortController().signal,
      { run: run as never },
    );
    const [file, args, options] = run.mock.calls[0]!;
    expect(file).toBe("npm");
    expect(args).toEqual([
      "search",
      "--json",
      "--searchlimit=3",
      "--registry=https://registry.npmjs.org/",
      "--prefer-online",
      "--no-color",
      "--",
      "--strange;query",
    ]);
    expect(options).toMatchObject({ shell: false, killDescendants: true });
    const env = options.env as NodeJS.ProcessEnv;
    expect(env).toMatchObject({
      HOME: options.cwd,
      NPM_CONFIG_USERCONFIG: expect.stringContaining("user.npmrc"),
      NPM_CONFIG_GLOBALCONFIG: expect.stringContaining("global.npmrc"),
      NPM_CONFIG_CACHE: expect.stringContaining("cache"),
    });
    expect(
      Object.keys(env).some((key) =>
        /token|npm_config_.*registry|node_options/i.test(key),
      ),
    ).toBe(false);
    expect(existsSync(options.cwd as string)).toBe(false);
    expect(JSON.stringify(result)).not.toContain("hidden@example.test");
  });

  it("normalizes malformed and nonzero npm output", async () => {
    const child = (exitCode: number, stdout: string) =>
      Object.assign(Promise.resolve({ exitCode, stdout, stderr: "failure" }), {
        kill: vi.fn(() => true),
      });
    await expect(
      searchNpm("widget", 1, new AbortController().signal, {
        run: (() => child(0, "not json")) as never,
      }),
    ).rejects.toThrow("malformed");
    const unavailable = searchNpm("widget", 1, new AbortController().signal, {
      run: (() => child(1, "[]")) as never,
    });
    await expect(unavailable).rejects.toMatchObject({
      kind: "unavailable",
      message: "npm search is temporarily unavailable.",
    } satisfies Partial<NpmError>);
  });

  it("terminates the process when cancellation arrives during execution", async () => {
    const controller = new AbortController();
    let resolve!: (value: {
      exitCode: number;
      stdout: string;
      stderr: string;
    }) => void;
    const child = Object.assign(
      new Promise<{ exitCode: number; stdout: string; stderr: string }>(
        (done) => {
          resolve = done;
        },
      ),
      { kill: vi.fn(() => true) },
    );
    const run = vi.fn(() => child);
    const pending = searchNpm("widget", 1, controller.signal, {
      run: run as never,
    });
    await vi.waitFor(() => expect(run).toHaveBeenCalled());
    controller.abort("cancelled");
    resolve({ exitCode: 0, stdout: "[]", stderr: "" });
    await expect(pending).rejects.toThrow("cancelled");
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("does not create a process for a pre-cancelled signal", async () => {
    const controller = new AbortController();
    controller.abort("cancelled");
    const run = vi.fn();
    await expect(
      searchNpm("widget", 1, controller.signal, { run: run as never }),
    ).rejects.toThrow("cancelled");
    expect(run).not.toHaveBeenCalled();
  });

  it("normalizes temporary setup and cleanup failures without replacing cancellation", async () => {
    await expect(
      searchNpm("widget", 1, new AbortController().signal, {
        makeDirectory: async () => {
          throw new Error("/private/tmp/secret");
        },
      }),
    ).rejects.toThrow("temporary setup failed");

    const controller = new AbortController();
    controller.abort("cancelled");
    await expect(
      searchNpm("widget", 1, controller.signal, {
        removeDirectory: async () => {
          throw new Error("/private/tmp/secret");
        },
      }),
    ).rejects.toThrow("cancelled");
  });

  it("constructs a credential-free allowlisted environment", () => {
    const environment = npmEnvironment(
      "/tmp/home",
      "/tmp/user",
      "/tmp/global",
      "/tmp/cache",
    );
    expect(environment).toMatchObject({
      HOME: "/tmp/home",
      NPM_CONFIG_USERCONFIG: "/tmp/user",
      NPM_CONFIG_GLOBALCONFIG: "/tmp/global",
      NPM_CONFIG_CACHE: "/tmp/cache",
    });
    expect(
      Object.keys(environment).every((key) =>
        [
          "PATH",
          "SystemRoot",
          "SYSTEMROOT",
          "ComSpec",
          "COMSPEC",
          "PATHEXT",
          "HOME",
          "NPM_CONFIG_USERCONFIG",
          "NPM_CONFIG_GLOBALCONFIG",
          "NPM_CONFIG_CACHE",
        ].includes(key),
      ),
    ).toBe(true);
  });
});
