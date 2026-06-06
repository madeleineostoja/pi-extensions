import type {
  ExtensionAPI,
  ExtensionContext,
  SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import { convertCurrency, refreshCurrencyRate } from "@pi-extensions/lib";
import { getFooterCostInfo } from "./cost.js";
import {
  buildFooterLines,
  buildLeftSegment,
  buildRightSegment,
} from "./format.js";

export default function (pi: ExtensionAPI) {
  pi.on(
    "session_start",
    async (_event: SessionStartEvent, ctx: ExtensionContext) => {
      if (!ctx.hasUI) {
        return;
      }

      ctx.ui.setFooter((tui, theme, footerData) => {
        const unsub = footerData.onBranchChange(() => tui.requestRender());

        refreshCurrencyRate({ from: "USD", to: "NZD" }).then(() => {
          tui.requestRender();
        });

        return {
          dispose: unsub,
          invalidate() {},
          render(width: number): string[] {
            const branch = footerData.getGitBranch();
            const left = buildLeftSegment(ctx.cwd, branch, theme);

            const model = ctx.model;
            const thinkingLevel = pi.getThinkingLevel();
            const { totalCost, hideCost } = getFooterCostInfo(
              ctx.sessionManager.getBranch(),
              ctx.modelRegistry,
              model,
            );
            const nzdCost = convertCurrency({
              amount: totalCost,
              from: "USD",
              to: "NZD",
            });
            const displayCost = nzdCost ?? 0;
            const displayHideCost = hideCost || nzdCost === undefined;

            const contextUsage = ctx.getContextUsage();
            const footerModel = model
              ? { name: model.name, id: model.id, provider: model.provider }
              : undefined;
            const rightWithWindow = buildRightSegment(
              footerModel,
              thinkingLevel,
              displayCost,
              contextUsage,
              displayHideCost,
              theme,
              true,
              false,
            );

            const rightWithoutWindow = buildRightSegment(
              footerModel,
              thinkingLevel,
              displayCost,
              contextUsage,
              displayHideCost,
              theme,
              false,
              false,
            );

            return buildFooterLines(
              width,
              left,
              rightWithWindow,
              rightWithoutWindow,
              footerData.getExtensionStatuses(),
              theme,
            );
          },
        };
      });
    },
  );
}
