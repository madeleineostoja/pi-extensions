import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { filesystemScope } from "./enforcement/tool-gate.js";
import { prepareExplicitFilesystemGrant } from "./enforcement/decide.js";
import {
  managedNonoPath,
  NONO_VERSION,
  nonoRecoveryMessage,
} from "./runtime/nono.js";
import type { GuardRuntimeState } from "./state.js";
import { guardStatus, syncGuardStatus } from "./status.js";

function grantLabel(grant: {
  path: string;
  kind: string;
  access: string;
}): string {
  return `${grant.access} ${
    grant.kind === "directory" ? `${grant.path}/**` : grant.path
  }`;
}

export function guardMenuDetail(
  state: GuardRuntimeState,
  supportedMac: boolean,
): string {
  const approvals = state.protectedReadApprovals().length;
  const shared = [
    `Protected-read approvals: ${approvals ? approvals : "none"}.`,
    `Semantic confirmation: ${state.semanticConfirmationEnabled() ? "enabled" : "disabled"}.`,
  ];
  if (!supportedMac) {
    return [
      "Guard uses local Bash here because Nono confinement supports only macOS arm64 and x64.",
      ...shared,
    ].join("\n");
  }

  const location = managedNonoPath() ?? "the managed Nono location";
  const health = state.backendHealth();
  const backend =
    health?.kind === "healthy"
      ? `Managed Nono ${NONO_VERSION} at ${health.path}: healthy.`
      : health?.kind === "tools-only"
        ? `Managed Nono ${NONO_VERSION} at ${location}: unhealthy. ${nonoRecoveryMessage(health)}`
        : `Managed Nono ${NONO_VERSION} at ${location}: checking health.`;
  return [
    state.boundaryEnabled()
      ? "Filesystem boundary is on."
      : "Filesystem boundary is off: Bash runs locally.",
    backend,
    ...shared,
  ].join("\n");
}

async function addGrant(
  ctx: ExtensionCommandContext,
  state: GuardRuntimeState,
  supportedMac: boolean,
): Promise<void> {
  const path = await ctx.ui.input("Guard: existing path", "file or directory");
  if (!path) {
    return;
  }
  const mode = await ctx.ui.select("Guard: access mode", ["Read", "Write"]);
  if (!mode) {
    return;
  }
  const grant = prepareExplicitFilesystemGrant({
    path,
    cwd: ctx.cwd,
    access: mode === "Read" ? "read" : "write",
    supportedMac,
    state,
  });
  if (!grant) {
    ctx.ui.notify("Guard: choose an existing file or directory.", "warning");
    return;
  }
  const effects = [
    grant.effects.includes("outside-boundary")
      ? "outside-boundary reachability"
      : "already within fixed capabilities",
    grant.effects.includes("protected-read") ? "protected-read approval" : "",
  ].filter(Boolean);
  const confirmed = await ctx.ui.confirm(
    "Guard: add session capability?",
    `${grantLabel(grant)}\nScope: ${filesystemScope(grant)}\nEffects: ${effects.join(", ")}`,
  );
  if (confirmed) {
    state.addGrant(grant);
  }
}

async function reviewGrants(
  ctx: ExtensionCommandContext,
  state: GuardRuntimeState,
): Promise<void> {
  const grants = state.filesystemGrants();
  if (!grants.length) {
    ctx.ui.notify("Guard: no filesystem grants in this session.", "info");
    return;
  }
  const labels = grants.map(grantLabel);
  const selected = await ctx.ui.select("Guard: remove filesystem grant", [
    ...labels,
    "Close",
  ]);
  const index = labels.indexOf(selected ?? "");
  if (index >= 0) {
    state.removeFilesystemGrant(grants[index]!);
  }
}

async function reviewProtected(
  ctx: ExtensionCommandContext,
  state: GuardRuntimeState,
): Promise<void> {
  const grants = state.protectedReadApprovals();
  if (!grants.length) {
    ctx.ui.notify(
      "Guard: no protected-read approvals in this session.",
      "info",
    );
    return;
  }
  const labels = grants.map(grantLabel);
  const selected = await ctx.ui.select(
    "Guard: remove protected-read approval",
    [...labels, "Close"],
  );
  const index = labels.indexOf(selected ?? "");
  if (index >= 0) {
    state.removeProtectedReadApproval(grants[index]!);
  }
}

export function registerGuardCommand(options: {
  pi: ExtensionAPI;
  state: GuardRuntimeState;
  supportedMac: boolean;
}): void {
  options.pi.registerCommand("guard", {
    description: "Review Guard boundary and session approvals",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        return;
      }
      for (;;) {
        const choices = [
          ...(options.supportedMac
            ? [
                options.state.boundaryEnabled()
                  ? "Turn boundary off"
                  : "Turn boundary on",
                "Add filesystem grant",
                "Review filesystem grants",
              ]
            : []),
          "Review protected-read approvals",
          ...(options.state.semanticConfirmationEnabled()
            ? []
            : ["Re-enable semantic confirmation"]),
          "Close",
        ];
        const selected = await ctx.ui.select(
          `Guard: ${guardStatus(options.state, options.supportedMac)}\n${guardMenuDetail(options.state, options.supportedMac)}`,
          choices,
        );
        if (!selected || selected === "Close") {
          return;
        }
        if (
          selected === "Turn boundary off" ||
          selected === "Turn boundary on"
        ) {
          options.state.setBoundaryEnabled(selected === "Turn boundary on");
          syncGuardStatus(ctx, options.state, options.supportedMac);
        } else if (selected === "Add filesystem grant") {
          await addGrant(ctx, options.state, options.supportedMac);
        } else if (selected === "Review filesystem grants") {
          await reviewGrants(ctx, options.state);
        } else if (selected === "Review protected-read approvals") {
          await reviewProtected(ctx, options.state);
        } else if (selected === "Re-enable semantic confirmation") {
          options.state.setSemanticConfirmationEnabled(true);
        }
      }
    },
  });
}
