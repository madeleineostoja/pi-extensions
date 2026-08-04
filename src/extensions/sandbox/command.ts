import {
  getSettingsListTheme,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  Key,
  matchesKey,
  type Component,
  SettingsList,
  Text,
  type TUI,
} from "@earendil-works/pi-tui";
import { Panel } from "#lib/ui/panel";
import type { SandboxDenial, SandboxDenialRecorder } from "./denials.js";
import {
  parseSandboxSettingChange,
  sandboxSettingItems,
  type SandboxSetting,
} from "./settings.js";
import type { SandboxSessionState } from "./state.js";
import { sandboxStatus, syncSandboxStatus } from "./status.js";

function effectiveBashWriteScopes(
  repositoryReadOnly: boolean,
  policy: NonNullable<ReturnType<SandboxSessionState["policy"]>>,
): readonly string[] {
  return repositoryReadOnly
    ? [...policy.temporaryRoots, ...policy.cacheRoots].filter(
        (root, index, roots) => roots.indexOf(root) === index,
      )
    : policy.writableRoots;
}

function formatDenial(denial: SandboxDenial): string {
  if (denial.kind === "direct") {
    const requested = denial.requestedPath
      ? `requested ${denial.requestedPath}`
      : "requested path unavailable";
    const target = denial.target ? ` · target ${denial.target}` : "";
    return `direct ${denial.tool} · ${requested}${target} · ${denial.reason}`;
  }
  return `bash ${denial.process} (pid ${denial.pid}) · ${denial.operation} · ${denial.path}`;
}

function panelDetail(
  state: SandboxSessionState,
  supportedMac: boolean,
  denials: SandboxDenialRecorder,
): string {
  const status = sandboxStatus(state, supportedMac);
  const repositoryReadOnly = status === "on" && state.repositoryReadOnly();
  const lines = [
    `State: ${status}${repositoryReadOnly ? " (repository-read-only child)" : ""}`,
  ];
  const policy = state.policy();
  if (policy) {
    lines.push(
      repositoryReadOnly
        ? "Direct write/edit scope: repository mutation denied"
        : `Direct write/edit scope: ${policy.workspaceRoot}`,
    );
    lines.push(
      "Sandbox Bash write scopes:",
      ...effectiveBashWriteScopes(repositoryReadOnly, policy).map(
        (root) => `  ${root}`,
      ),
    );
  }
  if (status === "unavailable") {
    lines.push(
      `Unavailable: ${
        supportedMac
          ? (state.unavailableReason() ??
            "Sandbox initialization failed. Reload to retry.")
          : "Sandbox is available only on macOS."
      }`,
    );
  }
  const snapshot = denials.snapshot();
  lines.push(`Confirmed denials: ${snapshot.count}`);
  if (snapshot.recent.length) {
    lines.push("Recent denials:", ...snapshot.recent.map(formatDenial));
  }
  return lines.join("\n");
}

function setMode(
  enabled: boolean,
  ctx: ExtensionCommandContext,
  state: SandboxSessionState,
  denials: SandboxDenialRecorder,
  supportedMac: boolean,
): boolean {
  if (enabled && (!supportedMac || !state.policy())) {
    ctx.ui.notify(
      !supportedMac
        ? "sandbox: unavailable on this platform"
        : "sandbox: unavailable; reload to retry initialization",
      "warning",
    );
    return state.enabled();
  }
  if (!enabled && !supportedMac) {
    ctx.ui.notify("sandbox: unavailable on this platform", "warning");
    return state.enabled();
  }
  state.setEnabled(enabled);
  syncSandboxStatus(ctx, state, supportedMac, denials);
  ctx.ui.notify(`sandbox: ${enabled ? "on" : "off"}`, "info");
  return state.enabled();
}

export class SandboxPanel implements Component {
  private readonly detail = new Text("", 0, 0);
  private readonly content = new Container();
  private readonly settings: SettingsList | undefined;
  private readonly panel: Panel;
  private readonly help: () => void;
  private readonly close: () => void;
  private readonly requestRender: () => void;
  private closed = false;
  private unsubscribe: (() => void) | undefined;

  constructor(options: {
    tui: TUI;
    theme: Theme;
    done: () => void;
    ctx: ExtensionCommandContext;
    state: SandboxSessionState;
    denials: SandboxDenialRecorder;
    supportedMac: boolean;
  }) {
    this.close = () => {
      if (this.closed) {
        return;
      }
      this.closed = true;
      options.done();
    };
    this.requestRender = () => options.tui.requestRender();
    this.help = () =>
      options.ctx.ui.notify(
        "Sandbox permits direct write/edit only in the workspace; Bash uses the listed writable roots.",
        "info",
      );
    const status = sandboxStatus(options.state, options.supportedMac);
    const settings: readonly SandboxSetting[] =
      status === "unavailable"
        ? options.supportedMac
          ? [
              {
                kind: "boolean",
                id: "mode",
                label: "Sandbox",
                description: "Turn off unavailable Sandbox mode",
                value: options.state.enabled(),
              },
            ]
          : []
        : [
            {
              kind: "boolean",
              id: "mode",
              label: "Sandbox",
              description: "Repository-write Sandbox mode",
              value: status === "on",
            },
          ];
    this.content.addChild(this.detail);
    if (settings.length) {
      this.settings = new SettingsList(
        [...sandboxSettingItems(settings)],
        2,
        getSettingsListTheme(),
        (id, value) => {
          const change = parseSandboxSettingChange(settings, id, value);
          if (change.id === "mode" && typeof change.value === "boolean") {
            const actual = setMode(
              change.value,
              options.ctx,
              options.state,
              options.denials,
              options.supportedMac,
            );
            this.settings?.updateValue("mode", actual ? "on" : "off");
            this.refresh(options.state, options.supportedMac, options.denials);
            this.requestRender();
          }
        },
        this.close,
        { enableSearch: true },
      );
      this.content.addChild(this.settings);
    }
    this.panel = new Panel({
      theme: options.theme,
      title: "/sandbox",
      child: this.content,
      footer:
        "↑↓ navigate · enter change · /sandbox on|off · ? help · esc close",
    });
    this.refresh(options.state, options.supportedMac, options.denials);
    this.unsubscribe = options.denials.subscribe(() => {
      this.refresh(options.state, options.supportedMac, options.denials);
      options.tui.requestRender();
    });
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      this.close();
      return;
    }
    if (data === "?") {
      this.help();
      return;
    }
    this.settings?.handleInput(data);
    this.requestRender();
  }

  render(width: number): string[] {
    return this.panel.render(width);
  }

  invalidate(): void {
    this.panel.invalidate();
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  private refresh(
    state: SandboxSessionState,
    supportedMac: boolean,
    denials: SandboxDenialRecorder,
  ): void {
    this.detail.setText(panelDetail(state, supportedMac, denials));
  }
}

export function registerSandboxCommand(options: {
  pi: ExtensionAPI;
  state: SandboxSessionState;
  denials: SandboxDenialRecorder;
  supportedMac: boolean;
}): void {
  options.pi.registerCommand("sandbox", {
    description: "Configure repository-write Sandbox",
    handler: async (args, ctx) => {
      const action = args.trim();
      if (action === "on" || action === "off") {
        setMode(
          action === "on",
          ctx,
          options.state,
          options.denials,
          options.supportedMac,
        );
        return;
      }
      if (action) {
        ctx.ui.notify("usage: /sandbox [on|off]", "warning");
        return;
      }
      if (ctx.mode !== "tui") {
        ctx.ui.notify(
          panelDetail(options.state, options.supportedMac, options.denials),
          "info",
        );
        return;
      }
      await ctx.ui.custom<void>(
        (tui, theme, _keybindings, done) =>
          new SandboxPanel({
            tui,
            theme,
            done,
            ctx,
            state: options.state,
            denials: options.denials,
            supportedMac: options.supportedMac,
          }),
      );
    },
  });
}

export { panelDetail as sandboxPanelDetail };
