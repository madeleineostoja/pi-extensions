import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  createPapercutStoreForCwd,
  type PapercutFile,
  type PapercutProposal,
  type PapercutRecord,
} from "./store.js";

export {
  createPapercutStore,
  createPapercutStoreForCwd,
  normalizeKey,
  parsePapercutFile,
} from "./store.js";
export type {
  PapercutFile,
  PapercutProposal,
  PapercutRecord,
  PapercutSource,
  PapercutStatus,
  ProposalOutcome,
} from "./store.js";

export const PAPERCUT_STATUS_KEY = "pi-papercuts.status";
export const PapercutProposalSchema = Type.Object({
  key: Type.String({
    description:
      "Stable lowercase slug, e.g. ruby-validation-requires-devcontainer",
  }),
  title: Type.String({ description: "Concrete concise title" }),
  trigger: Type.String({
    description: "What reliably exposes this project-specific gap",
  }),
  impact: Type.String({
    description: "Why this will matter to a future independent session",
  }),
  currentGap: Type.String({
    description:
      "What instructions, tests, tooling, errors, or docs currently fail to prevent or explain",
  }),
  proposedResolution: Type.String({
    description:
      "Concrete durable human-reviewed remedy; this tool never applies it",
  }),
  suggestedDestination: Type.Union([
    Type.Literal("agents"),
    Type.Literal("skill"),
    Type.Literal("test"),
    Type.Literal("lint"),
    Type.Literal("tooling"),
    Type.Literal("docs"),
    Type.Literal("code"),
  ]),
});

const TOOL_DESCRIPTION = `Propose a durable, human-reviewed papercut for a recurring project-specific failure mode or hidden operational constraint. Use only when the lesson is likely to matter in an independent future session, is specific enough for a concrete resolution, current instructions/tests/tooling/errors/docs did not adequately prevent or explain it, and there is a plausible durable resolution. Do not use for expected intermediate failures during an intentionally incomplete multi-step edit; tests correctly detecting the current bug; typos, malformed calls, transient provider failures, unavailable services; ordinary self-corrected failed approaches; one-off task context; or failures correctly anticipated and handled by existing guidance. In particular, a correctly handled devcontainer failure is not a papercut unless that guidance has a demonstrated gap. This records personal checkout metadata only and never edits the suggested destination or project source.`;

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

export default function (pi: ExtensionAPI) {
  async function storeFor(ctx: ExtensionContext) {
    const store = await createPapercutStoreForCwd(ctx.cwd);
    await store.initialize();
    return store;
  }

  async function refreshStatus(ctx: ExtensionContext): Promise<void> {
    if (ctx.mode !== "tui") {
      return;
    }
    try {
      const file = await (await storeFor(ctx)).load();
      const count = pendingRecords(file).length;
      ctx.ui.setStatus(
        PAPERCUT_STATUS_KEY,
        count > 0
          ? `${ctx.ui.theme.fg("warning", "󰶯")} ${ctx.ui.theme.fg("warning", String(count))}`
          : undefined,
      );
    } catch (error) {
      ctx.ui.setStatus(PAPERCUT_STATUS_KEY, undefined);
      ctx.ui.notify(
        `Papercuts unavailable: ${error instanceof Error ? error.message : String(error)}`,
        "error",
      );
    }
  }

  async function browse(ctx: ExtensionContext): Promise<void> {
    const store = await storeFor(ctx);
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
      const status = view.startsWith("Pending")
        ? "pending"
        : view.startsWith("Ignored")
          ? "ignored"
          : "resolved";
      const records = file.records
        .filter((record) => record.status === status)
        .sort((a, b) => a.key.localeCompare(b.key));
      const selected = await ctx.ui.select(
        `${status[0].toUpperCase()}${status.slice(1)} papercuts`,
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
        status === "pending"
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
        await refreshStatus(ctx);
      } catch (error) {
        ctx.ui.notify(
          `Papercut action failed: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
      }
    }
  }

  pi.registerTool({
    name: "propose_papercut",
    label: "propose_papercut",
    description: TOOL_DESCRIPTION,
    promptSnippet:
      "propose_papercut — record an eligible recurring project-specific gap for human review",
    parameters: PapercutProposalSchema,
    async execute(_id, proposal: PapercutProposal, _signal, _update, ctx) {
      try {
        const result = await (
          await storeFor(ctx)
        ).propose(proposal, { kind: "agent" });
        await refreshStatus(ctx);
        const text =
          result.kind === "rejected"
            ? `Papercut rejected: ${result.reason}`
            : result.kind === "created"
              ? `Papercut created: ${result.record.key}`
              : result.kind === "merged"
                ? `Papercut merged into pending: ${result.record.key}`
                : result.kind === "ignored"
                  ? `Papercut already ignored: ${result.record.key}`
                  : `Papercut already resolved: ${result.record.key}`;
        if (result.kind === "created") {
          ctx.ui.notify(`Papercut added: ${result.record.title}`, "info");
        }
        return { content: [{ type: "text" as const, text }], details: result };
      } catch (error) {
        const text = `Papercut rejected: ${error instanceof Error ? error.message : String(error)}`;
        return {
          content: [{ type: "text" as const, text }],
          details: { kind: "rejected", reason: text },
        };
      }
    },
  });

  pi.registerCommand("papercuts", {
    description: "Browse durable project papercuts",
    handler: async (args, ctx) => {
      if (args.trim()) {
        ctx.ui.notify("usage: /papercuts", "warning");
        return;
      }
      try {
        const store = await storeFor(ctx);
        const file = await store.load();
        if (!ctx.hasUI || ctx.mode !== "tui") {
          ctx.ui.notify(formatPapercutSummary(file), "info");
          return;
        }
        await browse(ctx);
      } catch (error) {
        ctx.ui.notify(
          `Papercuts unavailable: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
      }
    },
  });

  pi.on("session_start", async (_event, ctx) => refreshStatus(ctx));
  pi.on("session_shutdown", (_event, ctx) => {
    if (ctx.mode === "tui") {
      ctx.ui.setStatus(PAPERCUT_STATUS_KEY, undefined);
    }
  });
}
