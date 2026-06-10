import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  compact,
  getAgentDir,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { convertCurrency, refreshCurrencyRate } from "@pi-extensions/lib";
import { prepareCompaction } from "./compaction";
import {
  buildModelRef,
  getSwitchSkipReason,
  makeHandoffDecision,
} from "./decision";
import {
  clearPendingHandoff,
  getPendingHandoff,
  setPendingHandoff,
} from "./handoff";
import {
  formatHandoffPrompt,
  HANDOFF_INSTRUCTIONS,
  OPTION_CONTINUE_FULL_CONTEXT,
  OPTION_CREATE_HANDOFF,
} from "./prompt";

function formatSkipReason(reason: string): string {
  switch (reason) {
    case "Model restored":
      return "restored";
    case "No previous model":
      return "no previous model";
    case "Not running in TUI":
      return "not TUI";
    case "Same model":
      return "same model";
    case "No compaction preparation available":
      return "nothing to compact";
    case "No messages to summarize":
      return "nothing to summarize";
    case "Estimated context savings are below 20%":
      return "savings < 20%";
    case "Full context tokens are below handoff warning threshold":
      return "under token threshold";
    case "Full context cost is below handoff warning threshold":
      return "under cost threshold";
    case "Full context cost is below handoff warning threshold (USD fallback)":
      return "under USD cost threshold";
    default:
      return reason;
  }
}

function notifySkip(ctx: ExtensionContext, reason: string) {
  const message = `handoff skipped: ${formatSkipReason(reason)}`;
  if (ctx.mode === "tui") {
    const notify = ctx.ui.notify;
    setTimeout(() => notify(message, "info"), 0);
    return;
  }
  ctx.ui.notify(message, "info");
}

export default function (pi: ExtensionAPI) {
  pi.on("model_select", async (event, ctx) => {
    const switchSkipReason = getSwitchSkipReason(event, ctx.mode);
    if (switchSkipReason) {
      notifySkip(ctx, switchSkipReason);
      return;
    }

    const branchEntries = ctx.sessionManager.getBranch();
    const settings = SettingsManager.create(
      ctx.cwd,
      getAgentDir(),
    ).getCompactionSettings();
    const preparation = prepareCompaction(branchEntries, settings);

    const sourceRef = buildModelRef(
      event.previousModel!,
      ctx.modelRegistry.isUsingOAuth(event.previousModel!),
    );
    const targetRef = buildModelRef(
      event.model,
      ctx.modelRegistry.isUsingOAuth(event.model),
    );

    await refreshCurrencyRate({ from: "USD", to: "NZD" }).catch(() => {});
    const decision = makeHandoffDecision(preparation, targetRef, {
      convertFullContextCostToNzd: (amount) =>
        convertCurrency({ amount, from: "USD", to: "NZD" }),
    });
    if (decision.kind === "skip") {
      notifySkip(ctx, decision.reason);
      return;
    }

    const prompt = formatHandoffPrompt(sourceRef, targetRef, decision.estimate);
    const choice = await ctx.ui.select(prompt, [
      OPTION_CREATE_HANDOFF,
      OPTION_CONTINUE_FULL_CONTEXT,
    ]);

    if (choice !== OPTION_CREATE_HANDOFF) {
      return;
    }

    setPendingHandoff({ previousModel: event.previousModel! });
    ctx.compact({
      customInstructions: HANDOFF_INSTRUCTIONS,
      onComplete: () => {
        clearPendingHandoff();
      },
      onError: () => {
        clearPendingHandoff();
      },
    });
  });

  pi.on("session_before_compact", async (event, ctx) => {
    const pending = getPendingHandoff();
    if (!pending) {
      return undefined;
    }

    const { previousModel } = pending;
    clearPendingHandoff();

    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(previousModel);
    if (!auth.ok) {
      ctx.ui.notify(`Handoff cancelled: ${auth.error}`, "error");
      return { cancel: true };
    }

    const result = await compact(
      event.preparation,
      previousModel,
      auth.apiKey,
      auth.headers,
      HANDOFF_INSTRUCTIONS,
      event.signal,
    );

    return { compaction: result };
  });

  pi.on("session_shutdown", async (_event, _ctx) => {
    clearPendingHandoff();
  });
}
