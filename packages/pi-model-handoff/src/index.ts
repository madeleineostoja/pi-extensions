import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  compact,
  getAgentDir,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { convertCurrency, refreshCurrencyRate } from "@pi-extensions/lib";
import { prepareCompaction } from "./compaction";
import {
  buildModelRef,
  isEligibleSwitch,
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

export default function (pi: ExtensionAPI) {
  pi.on("model_select", async (event, ctx) => {
    if (!isEligibleSwitch(event, ctx.hasUI)) {
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

    const initialDecision = makeHandoffDecision(
      preparation,
      sourceRef,
      targetRef,
    );
    if (initialDecision.kind === "skip") {
      return;
    }

    await refreshCurrencyRate({ from: "USD", to: "NZD" });
    const decision = makeHandoffDecision(preparation, sourceRef, targetRef, {
      convertFullContextCostToNzd: (amount) =>
        convertCurrency({ amount, from: "USD", to: "NZD" }),
    });
    if (decision.kind === "skip") {
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
