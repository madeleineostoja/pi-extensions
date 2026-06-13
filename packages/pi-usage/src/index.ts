import type {
  ExtensionAPI,
  ExtensionContext,
  SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import type { Model, Api, AssistantMessage } from "@earendil-works/pi-ai";
import {
  getUsage,
  providerForModel,
  enumerateAvailableProviders,
} from "./provider.js";
import { formatStatus, formatUsageSummary } from "./format.js";
import { STATUS_KEY, CACHE_TTL_MS } from "./constants.js";
import {
  isCodexLimitError,
  buildLimitReplacementMessage,
} from "./limit-error.js";
import { runOpencodeAuthSetup } from "./config.js";
import { getAllUsage } from "./providers/opencode.js";

export { buildHeaders } from "./auth.js";
export { getUsage, providerForModel } from "./provider.js";
export type { UsageSnapshot } from "./provider.js";
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
    if (ctx.mode !== "tui") {
      return;
    }
    ctx.ui.setStatus(STATUS_KEY, undefined);
  }

  async function refreshStatus(
    model: Model<Api>,
    ctx: ExtensionContext,
    force = false,
  ) {
    if (ctx.mode !== "tui") {
      return;
    }

    const requestId = ++currentRequestId;

    cancelTimer();

    const snapshot = await getUsage(model, ctx, force);

    if (requestId !== currentRequestId) {
      return;
    }
    if (ctx.mode !== "tui") {
      return;
    }

    const providerLabel = providerForModel(model) ?? undefined;
    ctx.ui.setStatus(
      STATUS_KEY,
      formatStatus(snapshot, ctx.ui.theme, providerLabel),
    );

    if (snapshot?.stale) {
      cancelTimer();
      const timer = setTimeout(() => {
        refreshTimer = null;
        void refreshStatus(model, ctx, true);
      }, 5000);
      if (typeof timer === "object" && timer !== null && "unref" in timer) {
        (timer as { unref(): void }).unref();
      }
      refreshTimer = timer;
    } else {
      scheduleRefresh(model, ctx);
    }
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
    const provider = providerForModel(model);
    if (model && provider) {
      await refreshStatus(model, ctx);
    } else {
      cancelTimer();
      ++currentRequestId;
      clearStatus(ctx);
    }
  });

  pi.on("model_select", async (event, ctx) => {
    const model = event.model;
    const provider = providerForModel(model);
    if (provider) {
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
    if (!model || providerForModel(model) !== "codex") {
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
    description: "Show usage window reset time or run auth setup",
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui") {
        return;
      }
      const subcommand = args.trim();
      if (subcommand === "auth") {
        const saved = await runOpencodeAuthSetup(ctx);
        if (saved && ctx.model && providerForModel(ctx.model) === "opencode") {
          await refreshStatus(ctx.model, ctx, true);
        }
        return;
      }
      if (subcommand) {
        ctx.ui.notify("usage: /usage [auth]", "warning");
        return;
      }

      const available = enumerateAvailableProviders(ctx);
      if (available.length === 0) {
        ctx.ui.notify(
          "No usage providers configured. Sign in via /login.",
          "warning",
        );
        return;
      }

      const results = await Promise.all(
        available.map(async ({ provider, model }) => {
          if (provider.id === "opencode") {
            const accounts = await getAllUsage(model, ctx, true);
            const activeAccount = accounts.find((a) => a.snapshot?.active);
            return {
              provider: provider.id,
              snapshot: activeAccount?.snapshot ?? null,
              accounts: accounts.map((a) => ({
                accountId: a.accountId,
                snapshot: a.snapshot,
              })),
            };
          }
          return {
            provider: provider.id,
            snapshot: await getUsage(model, ctx, true),
          };
        }),
      );

      ctx.ui.notify(formatUsageSummary(results), "info");
    },
  });
}
