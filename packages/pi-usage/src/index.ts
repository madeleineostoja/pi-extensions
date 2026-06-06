import type {
  ExtensionAPI,
  ExtensionContext,
  SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import type { Model, Api, AssistantMessage } from "@earendil-works/pi-ai";
import { getUsage, isCodexProvider } from "./usage.js";
import { formatStatus, formatResetMessage } from "./format.js";
import { STATUS_KEY, CACHE_TTL_MS } from "./constants.js";
import {
  isCodexLimitError,
  buildLimitReplacementMessage,
} from "./limit-error.js";

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
export {
  isCodexLimitError,
  formatLimitReplacementText,
} from "./limit-error.js";

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
    if (!ctx.hasUI) {
      return;
    }
    ctx.ui.setStatus(STATUS_KEY, undefined);
  }

  async function refreshStatus(
    model: Model<Api>,
    ctx: ExtensionContext,
    force = false,
  ) {
    if (!ctx.hasUI) {
      return;
    }

    const requestId = ++currentRequestId;

    cancelTimer();

    const snapshot = await getUsage(model, ctx, force);

    if (requestId !== currentRequestId) {
      return;
    }
    if (!ctx.hasUI) {
      return;
    }

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
    if (!isCodexLimitError(event.message)) {
      return;
    }
    const model = ctx.model;
    if (!model || !isCodexProvider(model.provider)) {
      return;
    }
    const replacement = await buildLimitReplacementMessage(
      event.message as AssistantMessage,
      model,
      ctx,
    );
    await refreshStatus(model, ctx, false);
    return { message: replacement };
  });

  pi.on("session_shutdown", (_event, ctx) => {
    cancelTimer();
    ++currentRequestId;
    clearStatus(ctx);
  });

  pi.registerCommand("usage", {
    description: "Show the next Codex 5h window reset time",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        return;
      }
      const model = ctx.model;
      if (!model || !isCodexProvider(model.provider)) {
        ctx.ui.notify("No Codex model is active.", "warning");
        return;
      }
      const snapshot = await getUsage(model, ctx, true);
      ctx.ui.notify(formatResetMessage(snapshot), "info");
    },
  });
}
