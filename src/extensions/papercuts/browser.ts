import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { promptForPermission } from "#lib/permission-prompt";
import type { PapercutFile, PapercutRecord, PapercutStatus } from "./store.js";
import { createPapercutStatusController } from "./status.js";

const SUMMARY_LIMIT = 16_384;

type PapercutStatusController = ReturnType<
  typeof createPapercutStatusController
>;

function sortedRecords(
  file: PapercutFile,
  status?: PapercutStatus,
): PapercutRecord[] {
  return file.records
    .filter((record) => status === undefined || record.status === status)
    .sort(
      (a, b) =>
        (a.status === b.status ? 0 : a.status === "open" ? -1 : 1) ||
        a.key.localeCompare(b.key),
    );
}

export function formatPapercutSummary(file: PapercutFile): string {
  const records = sortedRecords(file);
  const lines = [
    `open (${records.filter((record) => record.status === "open").length})`,
    `closed (${records.filter((record) => record.status === "closed").length})`,
  ];
  let included = 0;
  for (const record of records) {
    const line = `- ${record.status} ${record.key}: ${record.title} (${record.occurrences})`;
    const candidate = [...lines, line].join("\n");
    if (Buffer.byteLength(candidate, "utf8") > SUMMARY_LIMIT) {
      break;
    }
    lines.push(line);
    included += 1;
  }
  const omitted = records.length - included;
  if (!omitted) {
    return lines.join("\n");
  }
  const suffix = `… ${omitted} record${omitted === 1 ? "" : "s"} omitted`;
  while (
    Buffer.byteLength([...lines, suffix].join("\n"), "utf8") > SUMMARY_LIMIT &&
    lines.length > 2
  ) {
    lines.pop();
    included -= 1;
  }
  return [
    ...lines,
    `… ${records.length - included} record${records.length - included === 1 ? "" : "s"} omitted`,
  ].join("\n");
}

function detail(record: PapercutRecord): string {
  return [
    `Title: ${record.title}`,
    `Key: ${record.key}`,
    "",
    `Assigned task: ${record.task}`,
    "",
    `Incident: ${record.incident}`,
    "",
    `Evidence: ${record.evidence}`,
    "",
    "Exercised workarounds:",
    ...record.workarounds.map(
      (workaround, index) => `${index + 1}. ${workaround}`,
    ),
    "",
    `Task outcome: ${record.taskOutcome}`,
    ...(record.guardrailCandidate
      ? ["", `Guardrail candidate: ${record.guardrailCandidate}`]
      : []),
    ...(record.suggestedDestination
      ? [`Suggested destination: ${record.suggestedDestination}`]
      : []),
    "",
    `Occurrences: ${record.occurrences}`,
    `First seen: ${record.firstSeenAt}`,
    `Last seen: ${record.lastSeenAt}`,
  ].join("\n");
}

async function browseStatus(
  ctx: ExtensionContext,
  status: PapercutStatus,
  controller: PapercutStatusController,
): Promise<void> {
  while (true) {
    const records = sortedRecords(
      await (await controller.storeFor(ctx)).load(),
      status,
    );
    const selected = await ctx.ui.select(
      `${status === "open" ? "Open" : "Closed"} papercuts`,
      [...records.map((record) => `${record.key} — ${record.title}`), "Back"],
    );
    if (!selected || selected === "Back") {
      return;
    }
    const record = records.find((candidate) =>
      selected.startsWith(`${candidate.key} — `),
    );
    if (!record) {
      continue;
    }
    const action = await promptForPermission({
      ui: ctx.ui,
      title: record.title,
      detail: detail(record),
      choices:
        status === "open"
          ? [
              { value: "close", label: "Close Finding" },
              { value: "back", label: "Back" },
            ]
          : [{ value: "back", label: "Back" }],
    });
    if (action.kind !== "selected" || action.value === "back") {
      continue;
    }
    try {
      await (await controller.storeFor(ctx)).close(record.key);
      await controller.refreshStatus(ctx);
    } catch {
      ctx.ui.notify("Papercut action failed.", "error");
    }
  }
}

export function registerPapercutsBrowser(
  pi: ExtensionAPI,
  status: PapercutStatusController,
): void {
  pi.registerCommand("papercuts", {
    description: "Browse incidental papercut findings",
    handler: async (args, ctx) => {
      if (args.trim()) {
        ctx.ui.notify("usage: /papercuts", "warning");
        return;
      }
      try {
        const file = await (await status.storeFor(ctx)).load();
        if (!ctx.hasUI || ctx.mode !== "tui") {
          ctx.ui.notify(formatPapercutSummary(file), "info");
          return;
        }
        while (true) {
          const current = await (await status.storeFor(ctx)).load();
          const open = current.records.filter(
            (record) => record.status === "open",
          ).length;
          const closed = current.records.length - open;
          const choice = await ctx.ui.select("Papercuts", [
            `Open (${open})`,
            `Closed (${closed})`,
            "Back",
          ]);
          if (!choice || choice === "Back") {
            return;
          }
          await browseStatus(
            ctx,
            choice.startsWith("Open") ? "open" : "closed",
            status,
          );
        }
      } catch {
        ctx.ui.notify("Papercuts unavailable.", "error");
      }
    },
  });
}
