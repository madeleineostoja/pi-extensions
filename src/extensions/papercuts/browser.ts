import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type {
  PapercutFile,
  PapercutProposal,
  PapercutRecord,
} from "./store.js";
import { createPapercutStatusController } from "./status.js";

function pendingRecords(file: PapercutFile): PapercutRecord[] {
  return file.records.filter((record) => record.status === "pending");
}

export function formatPapercutSummary(file: PapercutFile): string {
  const groups = (["pending", "ignored", "resolved"] as const).map((status) => {
    const records = file.records.filter((record) => record.status === status);
    const lines = records
      .sort((a, b) => a.key.localeCompare(b.key))
      .map(
        (record) => `- ${record.key}: ${record.title} (${record.occurrences})`,
      );
    return `${status} (${records.length})${lines.length ? `\n${lines.join("\n")}` : ""}`;
  });
  return groups.join("\n");
}

function remediationPrompt(record: PapercutRecord): string {
  return [
    `Address papercut: ${record.title}`,
    "",
    `Trigger: ${record.trigger}`,
    `Impact: ${record.impact}`,
    `Current gap: ${record.currentGap}`,
    `Proposed resolution: ${record.proposedResolution}`,
    `Suggested destination: ${record.suggestedDestination}`,
    "",
    "Implement and validate a durable remediation. Do not change this papercut's status automatically; return to /papercuts and mark it resolved after human review.",
  ].join("\n");
}

async function editProposal(
  ctx: ExtensionContext,
  record: PapercutRecord,
): Promise<PapercutProposal | undefined> {
  const fields: Array<keyof PapercutProposal> = [
    "key",
    "title",
    "trigger",
    "impact",
    "currentGap",
    "proposedResolution",
    "suggestedDestination",
  ];
  const proposal = {} as PapercutProposal;
  for (const field of fields) {
    const response = await ctx.ui.input(`Edit ${field}`, record[field]);
    if (response === undefined) {
      return undefined;
    }
    proposal[field] = response.trim() as never;
  }
  return proposal;
}

async function chooseDisposition(
  ctx: ExtensionContext,
  action: "resolved" | "ignored",
): Promise<{ note?: string; target?: string } | undefined> {
  const note = await ctx.ui.input(
    action === "resolved"
      ? "Resolution note (optional)"
      : "Ignore reason (optional)",
    "",
  );
  if (note === undefined) {
    return undefined;
  }
  const target = await ctx.ui.input(
    action === "resolved"
      ? "Resolution target (optional)"
      : "Ignore target (optional)",
    "",
  );
  if (target === undefined) {
    return undefined;
  }
  return {
    ...(note.trim() ? { note: note.trim() } : {}),
    ...(target.trim() ? { target: target.trim() } : {}),
  };
}

type PapercutStatusController = ReturnType<
  typeof createPapercutStatusController
>;

export function registerPapercutsBrowser(
  pi: ExtensionAPI,
  status: PapercutStatusController,
): void {
  const browse = async (
    ctx: ExtensionContext,
    generation: number,
  ): Promise<void> => {
    const store = await status.storeFor(ctx);
    while (true) {
      const file = await store.load();
      const view = await ctx.ui.select("Papercuts", [
        `Pending (${pendingRecords(file).length})`,
        `Ignored (${file.records.filter((record) => record.status === "ignored").length})`,
        `Resolved (${file.records.filter((record) => record.status === "resolved").length})`,
        "Close",
      ]);
      if (!view || view === "Close") {
        return;
      }
      const recordStatus = view.startsWith("Pending")
        ? "pending"
        : view.startsWith("Ignored")
          ? "ignored"
          : "resolved";
      const records = file.records
        .filter((record) => record.status === recordStatus)
        .sort((a, b) => a.key.localeCompare(b.key));
      const selected = await ctx.ui.select(
        `${recordStatus[0].toUpperCase()}${recordStatus.slice(1)} papercuts`,
        [...records.map((record) => `${record.key} — ${record.title}`), "Back"],
      );
      if (!selected || selected === "Back") {
        continue;
      }
      const record = records.find((candidate) =>
        selected.startsWith(`${candidate.key} — `),
      );
      if (!record) {
        continue;
      }
      const actions =
        recordStatus === "pending"
          ? [
              "Work on this",
              "Mark resolved",
              "Ignore",
              "Edit proposal",
              "Delete",
              "Back",
            ]
          : ["Reopen", "Edit proposal", "Delete", "Back"];
      const action = await ctx.ui.select(
        `${record.title}\n${record.trigger}\n\n${record.currentGap}\n\nProposed: ${record.proposedResolution}`,
        actions,
      );
      if (!action || action === "Back") {
        continue;
      }
      try {
        if (action === "Work on this") {
          ctx.ui.setEditorText(remediationPrompt(record));
          ctx.ui.notify("Remediation prompt added to the editor.", "info");
        } else if (action === "Mark resolved" || action === "Ignore") {
          const disposition = await chooseDisposition(
            ctx,
            action === "Mark resolved" ? "resolved" : "ignored",
          );
          if (disposition) {
            await store.transition(
              record.key,
              action === "Mark resolved" ? "resolved" : "ignored",
              disposition,
            );
          }
        } else if (action === "Reopen") {
          await store.transition(record.key, "pending");
        } else if (action === "Edit proposal") {
          const proposal = await editProposal(ctx, record);
          if (proposal) {
            await store.edit(record.key, proposal);
          }
        } else if (action === "Delete") {
          const confirmed = await ctx.ui.confirm(
            "Delete papercut",
            `Permanently delete ${record.key}?`,
          );
          if (confirmed) {
            await store.delete(record.key, true);
          }
        }
        await status.refreshStatus(ctx, generation);
      } catch (error) {
        ctx.ui.notify(
          `Papercut action failed: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
      }
    }
  };

  pi.registerCommand("papercuts", {
    description: "Browse durable project papercuts",
    handler: async (args, ctx) => {
      const generation = status.generation();
      if (args.trim()) {
        ctx.ui.notify("usage: /papercuts", "warning");
        return;
      }
      try {
        const store = await status.storeFor(ctx);
        const file = await store.load();
        if (!ctx.hasUI || ctx.mode !== "tui") {
          ctx.ui.notify(formatPapercutSummary(file), "info");
          return;
        }
        await browse(ctx, generation);
      } catch (error) {
        ctx.ui.notify(
          `Papercuts unavailable: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
      }
    },
  });
}
