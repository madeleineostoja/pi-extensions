import type {
  ExtensionAPI,
  ExtensionContext,
  SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import type { Model, Api } from "@earendil-works/pi-ai";
import { getUsage, isCodexProvider } from "./usage.js";
import { formatStatus } from "./format.js";
import { STATUS_KEY, CACHE_TTL_MS } from "./constants.js";

export { buildHeaders } from "./auth.js";
export { fetchUsage, getUsage, isCodexProvider } from "./usage.js";
export type { UsageSnapshot } from "./usage.js";
export {
  STATUS_KEY,
  CODEX_USAGE_URL,
  CACHE_TTL_MS,
  TIMEOUT_MS,
  ICON,
} from "./constants.js";

function isLimitFailureMessage(message: unknown): boolean {
  const msg = message as {
    role?: string;
    content?: unknown;
    errorMessage?: unknown;
  };
  if (msg?.role !== "assistant") return false;

  let text = "";
  const content = msg.content;
  if (Array.isArray(content)) {
    for (const part of content) {
      const p = part as { type?: string; text?: string };
      if (p?.type === "text" && typeof p.text === "string") {
        text += p.text;
      }
    }
  } else if (typeof content === "string") {
    text = content;
  }

  if (typeof msg.errorMessage === "string") {
    text += msg.errorMessage;
  }

  const lower = text.toLowerCase();
  const hasLimit =
    lower.includes("rate limit") || lower.includes("limit reached");
  const hasCodex = lower.includes("codex") || lower.includes("chatgpt");
  return hasLimit && hasCodex;
}

export default function (pi: ExtensionAPI) {
  let refreshTimer: ReturnType<typeof setTimeout> | null = null;
  let currentRequestId = 0;

  function cancelTimer() {
    if (refreshTimer !== null) {
      clearTimeout(refreshTimer);
      refreshTimer = null;
    }
  }

  function clearStatus(ctx: ExtensionContext) {
    if (!ctx.hasUI) return;
    ctx.ui.setStatus(STATUS_KEY, undefined);
  }

  async function refreshStatus(
    model: Model<Api>,
    ctx: ExtensionContext,
    force = false,
  ) {
    if (!ctx.hasUI) return;

    const requestId = ++currentRequestId;

    cancelTimer();

    const snapshot = await getUsage(model, ctx, force);

    if (requestId !== currentRequestId) return;
    if (!ctx.hasUI) return;

    ctx.ui.setStatus(STATUS_KEY, formatStatus(snapshot, ctx.ui.theme));

    scheduleRefresh(model, ctx);
  }

  function scheduleRefresh(model: Model<Api>, ctx: ExtensionContext) {
    cancelTimer();
    const timer = setTimeout(() => {
      refreshTimer = null;
      void refreshStatus(model, ctx, true);
    }, CACHE_TTL_MS);
    if (typeof timer === "object" && timer !== null && "unref" in timer) {
      (timer as { unref(): void }).unref();
    }
    refreshTimer = timer;
  }

  pi.on("session_start", async (_event: SessionStartEvent, ctx) => {
    const model = ctx.model;
    if (model && isCodexProvider(model.provider)) {
      await refreshStatus(model, ctx);
    } else {
      cancelTimer();
      ++currentRequestId;
      clearStatus(ctx);
    }
  });

  pi.on("model_select", async (event, ctx) => {
    const model = event.model;
    if (isCodexProvider(model.provider)) {
      await refreshStatus(model, ctx);
    } else {
      cancelTimer();
      ++currentRequestId;
      clearStatus(ctx);
    }
  });

  pi.on("message_end", async (event, ctx) => {
    if (!isLimitFailureMessage(event.message)) return;
    const model = ctx.model;
    if (!model || !isCodexProvider(model.provider)) return;
    await refreshStatus(model, ctx, true);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    cancelTimer();
    ++currentRequestId;
    clearStatus(ctx);
  });
}
