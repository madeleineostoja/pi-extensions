import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Model, Api } from "@earendil-works/pi-ai";

type JwtPayload = Record<string, unknown>;

function decodeJwtPayload(token: string): JwtPayload | null {
  try {
    const raw = Buffer.from(token.split(".")[1] ?? "", "base64url").toString(
      "utf8",
    );
    return JSON.parse(raw) as JwtPayload;
  } catch {
    return null;
  }
}

function getChatGptAccountId(token: string): string | undefined {
  const payload = decodeJwtPayload(token);
  if (!payload) return undefined;
  const claim = payload["https://api.openai.com/auth.chatgpt_account_id"];
  return typeof claim === "string" ? claim : undefined;
}

export async function buildHeaders(
  model: Model<Api>,
  ctx: ExtensionContext,
): Promise<
  { ok: true; headers: Record<string, string> } | { ok: false; error: string }
> {
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) {
    return { ok: false, error: auth.error };
  }

  const headers: Record<string, string> = {
    ...auth.headers,
    Accept: "application/json",
    "User-Agent": "codex-usage/0.1.0",
  };

  if (auth.apiKey) {
    headers["Authorization"] = `Bearer ${auth.apiKey}`;
    const accountId = getChatGptAccountId(auth.apiKey);
    if (accountId) {
      headers["chatgpt-account-id"] = accountId;
    }
  }

  return { ok: true, headers };
}
