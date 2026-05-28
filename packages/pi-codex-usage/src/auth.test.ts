import { describe, it, expect } from "vitest";
import { buildHeaders } from "./auth.js";

type FakeModel = { provider: string; id: string };
type FakeCtx = {
  modelRegistry: {
    getApiKeyAndHeaders: (
      model: FakeModel,
    ) => Promise<
      | { ok: true; apiKey?: string; headers?: Record<string, string> }
      | { ok: false; error: string }
    >;
  };
};

function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256" })).toString(
    "base64url",
  );
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.fakesig`;
}

function makeCtx(
  result:
    | { ok: true; apiKey?: string; headers?: Record<string, string> }
    | { ok: false; error: string },
): FakeCtx {
  return {
    modelRegistry: {
      getApiKeyAndHeaders: async () => result,
    },
  };
}

const fakeModel: FakeModel = { provider: "openai-codex", id: "codex-1" };

describe("buildHeaders", () => {
  it("returns ok:false when getApiKeyAndHeaders fails", async () => {
    const ctx = makeCtx({ ok: false, error: "no creds" });
    const result = await buildHeaders(fakeModel as never, ctx as never);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("no creds");
    }
  });

  it("includes Authorization header when apiKey is present", async () => {
    const ctx = makeCtx({ ok: true, apiKey: "sk-test" });
    const result = await buildHeaders(fakeModel as never, ctx as never);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.headers["Authorization"]).toBe("Bearer sk-test");
    }
  });

  it("does not include Authorization when only headers are present", async () => {
    const ctx = makeCtx({ ok: true, headers: { "X-Custom": "val" } });
    const result = await buildHeaders(fakeModel as never, ctx as never);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.headers["Authorization"]).toBeUndefined();
      expect(result.headers["X-Custom"]).toBe("val");
    }
  });

  it("merges extra headers from auth result", async () => {
    const ctx = makeCtx({
      ok: true,
      apiKey: "sk-abc",
      headers: { "X-Forwarded-For": "1.2.3.4" },
    });
    const result = await buildHeaders(fakeModel as never, ctx as never);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.headers["X-Forwarded-For"]).toBe("1.2.3.4");
      expect(result.headers["Authorization"]).toBe("Bearer sk-abc");
    }
  });

  it("always includes Accept and User-Agent headers", async () => {
    const ctx = makeCtx({ ok: true, apiKey: "sk-test" });
    const result = await buildHeaders(fakeModel as never, ctx as never);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.headers["Accept"]).toBe("application/json");
      expect(result.headers["User-Agent"]).toBe("codex-usage/0.1.0");
    }
  });

  it("extracts chatgpt_account_id from JWT and sets header", async () => {
    const payload = {
      "https://api.openai.com/auth.chatgpt_account_id": "acct-xyz",
    };
    const token = makeJwt(payload);
    const ctx = makeCtx({ ok: true, apiKey: token });
    const result = await buildHeaders(fakeModel as never, ctx as never);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.headers["chatgpt-account-id"]).toBe("acct-xyz");
    }
  });

  it("does not set chatgpt-account-id when JWT has no matching claim", async () => {
    const payload = { sub: "user-123" };
    const token = makeJwt(payload);
    const ctx = makeCtx({ ok: true, apiKey: token });
    const result = await buildHeaders(fakeModel as never, ctx as never);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.headers["chatgpt-account-id"]).toBeUndefined();
    }
  });

  it("does not set chatgpt-account-id for a malformed JWT with only 1 part", async () => {
    const ctx = makeCtx({ ok: true, apiKey: "not-a-jwt" });
    const result = await buildHeaders(fakeModel as never, ctx as never);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.headers["chatgpt-account-id"]).toBeUndefined();
    }
  });

  it("does not set chatgpt-account-id when JWT payload is not valid JSON", async () => {
    const badPayload = Buffer.from("not-json").toString("base64url");
    const badJwt = `header.${badPayload}.sig`;
    const ctx = makeCtx({ ok: true, apiKey: badJwt });
    const result = await buildHeaders(fakeModel as never, ctx as never);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.headers["chatgpt-account-id"]).toBeUndefined();
    }
  });
});
