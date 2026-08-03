import { describe, expect, it } from "vitest";
import { AuthError, loadContext7Auth, loadGithubAuth } from "./auth.js";
import { LIMITS } from "./bounds.js";

const read = (content: string | Error) => () => {
  if (content instanceof Error) {
    throw content;
  }
  return Buffer.from(content);
};

describe("Context7 agent authentication", () => {
  it("accepts only the bounded context7 field and ignores unrelated fields", () => {
    expect(
      loadContext7Auth(
        "/agent",
        read('{"context7":"token", "github":"ignored"}'),
      ),
    ).toBe("token");
    expect(
      loadContext7Auth("/agent", read('{"github":"ignored"}')),
    ).toBeUndefined();
    expect(loadGithubAuth("/agent", read('{"github":"token"}'))).toBe("token");
    expect(() =>
      loadGithubAuth("/agent", read(JSON.stringify({ github: " bad " }))),
    ).toThrow("GitHub credential is malformed");
  });

  it("treats a missing file as anonymous but keeps auth failures safe", () => {
    const missing = Object.assign(new Error("not found"), { code: "ENOENT" });
    expect(loadContext7Auth("/agent", read(missing))).toBeUndefined();
    expect(() => loadContext7Auth("/agent", read("{"))).toThrow(AuthError);
    expect(() =>
      loadContext7Auth("/agent", read(JSON.stringify({ context7: " bad " }))),
    ).toThrow("malformed");
    expect(() =>
      loadContext7Auth("/agent", read("x".repeat(LIMITS.authFileBytes + 1))),
    ).toThrow("too large");
  });
});
