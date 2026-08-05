import {
  getSelectListTheme,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  Key,
  matchesKey,
  type Component,
  type SelectItem,
  SelectList,
  Text,
  type TUI,
} from "@earendil-works/pi-tui";
import { isAbsolute, relative } from "node:path";
import { Panel } from "#lib/ui/panel";
import { WideSelectList, type WideListItem } from "#lib/ui/wide-select-list";
import type { SandboxDenial, SandboxDenialRecorder } from "./denials.js";
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

function effectivePolicyFields(
  state: SandboxSessionState,
  supportedMac: boolean,
): readonly [string, string][] {
  const status = sandboxStatus(state, supportedMac);
  const repositoryReadOnly = status === "on" && state.repositoryReadOnly();
  if (status === "off") {
    return [
      ["Direct write/edit scope", "unrestricted (Sandbox off)"],
      ["Bash writable roots", "unrestricted (Sandbox off)"],
    ];
  }
  if (status === "unavailable") {
    return supportedMac
      ? [
          [
            "Direct write/edit scope",
            "mutation denied until Sandbox is turned off",
          ],
          ["Bash writable roots", "none (Sandbox unavailable)"],
        ]
      : [
          ["Direct write/edit scope", "unrestricted (Sandbox unavailable)"],
          ["Bash writable roots", "unrestricted (Sandbox unavailable)"],
        ];
  }
  const policy = state.policy();
  if (!policy) {
    return [];
  }
  return [
    [
      "Direct write/edit scope",
      repositoryReadOnly ? "repository mutation denied" : policy.workspaceRoot,
    ],
    [
      "Bash writable roots",
      effectiveBashWriteScopes(repositoryReadOnly, policy).join(", ") || "none",
    ],
  ];
}

function formatDenial(denial: SandboxDenial): string {
  if (denial.kind === "direct") {
    const requested = denial.requestedPath
      ? `requested ${denial.requestedPath}`
      : "requested path unavailable";
    const target = denial.target ? ` · resolved ${denial.target}` : "";
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
    `Mode: ${status}${repositoryReadOnly ? " (repository-read-only child)" : ""}`,
  ];
  lines.push(
    ...effectivePolicyFields(state, supportedMac).map(
      ([label, value]) => `${label}: ${value}`,
    ),
  );
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
    lines.push(
      "Recent denials:",
      ...[...snapshot.recent].reverse().map(formatDenial),
    );
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

function titleCase(status: ReturnType<typeof sandboxStatus>): string {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function formatTime(at: number): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(at);
}

function workspacePath(path: string, state: SandboxSessionState): string {
  const root = state.policy()?.workspaceRoot;
  if (!root) {
    return path;
  }
  const within = relative(root, path);
  return !isAbsolute(within) && within !== ".." && !within.startsWith("../")
    ? within || "."
    : path;
}

function denialPath(denial: SandboxDenial, state: SandboxSessionState): string {
  if (denial.kind === "direct") {
    return denial.target
      ? workspacePath(denial.target, state)
      : (denial.requestedPath ?? "path unavailable");
  }
  return workspacePath(denial.path, state);
}

function denialItem(
  denial: SandboxDenial,
  state: SandboxSessionState,
): WideListItem<SandboxDenial> {
  const source =
    denial.kind === "direct"
      ? `direct/${denial.tool}`
      : `bash/${denial.process}`;
  const operation = denial.kind === "direct" ? denial.reason : denial.operation;
  return {
    kind: "item",
    value: `${denial.kind}:${denial.at}:${source}:${operation}:${denialPath(denial, state)}`,
    data: denial,
    fixed: [
      { text: formatTime(denial.at), width: 8 },
      { text: source, width: 16 },
      { text: operation, width: 24 },
    ],
    elastic: denialPath(denial, state),
  };
}

function fieldsComponent(fields: readonly [string, string][]): Component {
  const text = new Text(
    fields.map(([label, value]) => `${label}: ${value}`).join("\n"),
    0,
    0,
  );
  return text;
}

class DenialPage implements Component {
  #list: WideSelectList<SandboxDenial>;
  #selected: SandboxDenial | undefined;

  constructor(
    private readonly options: {
      theme: Theme;
      state: SandboxSessionState;
      denials: SandboxDenialRecorder;
      back: () => void;
      requestRender: () => void;
    },
  ) {
    this.#list = this.#createList();
  }

  refresh(): void {
    if (this.#selected) {
      return;
    }
    const selected = this.#list.getSelectedItem()?.value;
    this.#list = this.#createList();
    this.#list.setSelectedValue(selected);
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      if (this.#selected) {
        this.#selected = undefined;
      } else {
        this.options.back();
      }
      this.options.requestRender();
      return;
    }
    this.#list.handleInput(data);
    this.options.requestRender();
  }

  render(width: number): string[] {
    return this.#selected
      ? fieldsComponent(this.#detailFields(this.#selected)).render(width)
      : this.#list.render(width);
  }

  invalidate(): void {
    this.#list.invalidate();
  }

  #createList(): WideSelectList<SandboxDenial> {
    return new WideSelectList({
      entries: this.options.denials
        .snapshot()
        .recent.slice()
        .reverse()
        .map((denial) => denialItem(denial, this.options.state)),
      maxVisible: 10,
      selectedPrefix: (text) => this.options.theme.fg("accent", text),
      empty: {
        text: "No recent denials.",
        style: (text) => this.options.theme.fg("muted", text),
      },
      onSelect: (item) => {
        this.#selected = item.data;
      },
    });
  }

  #detailFields(denial: SandboxDenial): readonly [string, string][] {
    if (denial.kind === "direct") {
      const fields: [string, string][] = [
        ["Time", formatTime(denial.at)],
        ["Requested", denial.requestedPath ?? "unavailable"],
      ];
      if (denial.target) {
        fields.push(["Resolved", denial.target]);
      }
      fields.push(["Reason", denial.reason]);
      return fields;
    }
    return [
      ["Time", formatTime(denial.at)],
      ["Process", denial.process],
      ["PID", String(denial.pid)],
      ["Operation", denial.operation],
      ["Path", denial.path],
    ];
  }
}

export class SandboxPanel implements Component {
  #panel: Panel;
  #main: SelectList;
  #denialPage: DenialPage | undefined;
  #page: "main" | "denials" | "policy" = "main";
  #closed = false;
  #disposed = false;
  #unsubscribe: (() => void) | undefined;

  constructor(
    private readonly options: {
      tui: TUI;
      theme: Theme;
      done: () => void;
      ctx: ExtensionCommandContext;
      state: SandboxSessionState;
      denials: SandboxDenialRecorder;
      supportedMac: boolean;
    },
  ) {
    this.#main = this.#createMain();
    this.#panel = this.#makePanel("Sandbox", this.#main);
    this.#unsubscribe = options.denials.subscribe(() => {
      if (this.#disposed) {
        return;
      }
      if (this.#page === "main") {
        this.#main = this.#createMain(this.#main.getSelectedItem()?.value);
        this.#panel = this.#makePanel("Sandbox", this.#main);
      } else if (this.#page === "denials") {
        this.#denialPage?.refresh();
      }
      options.tui.requestRender();
    });
  }

  handleInput(data: string): void {
    if (this.#page === "main") {
      this.#main.handleInput(data);
    } else if (this.#page === "denials") {
      this.#denialPage?.handleInput(data);
    } else if (matchesKey(data, Key.escape)) {
      this.#showMain();
    }
    this.options.tui.requestRender();
  }

  render(width: number): string[] {
    return this.#panel.render(width);
  }

  invalidate(): void {
    this.#panel.invalidate();
  }

  dispose(): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
  }

  #createMain(selected?: string): SelectList {
    const status = sandboxStatus(this.options.state, this.options.supportedMac);
    const items: SelectItem[] = [
      {
        value: "mode",
        label: "Mode",
        description: titleCase(status),
      },
      {
        value: "denials",
        label: "Confirmed denials",
        description: String(this.options.denials.snapshot().count),
      },
      { value: "policy", label: "Policy details" },
    ];
    const list = new SelectList(items, items.length, getSelectListTheme());
    const index = items.findIndex((item) => item.value === selected);
    list.setSelectedIndex(index >= 0 ? index : 0);
    list.onSelect = (item) => {
      if (item.value === "mode") {
        setMode(
          !this.options.state.enabled(),
          this.options.ctx,
          this.options.state,
          this.options.denials,
          this.options.supportedMac,
        );
        this.#main = this.#createMain("mode");
        this.#panel = this.#makePanel("Sandbox", this.#main);
      } else if (item.value === "denials") {
        this.#showDenials();
      } else {
        this.#showPolicy();
      }
    };
    list.onCancel = () => this.#close();
    return list;
  }

  #makePanel(title: string, child: Component): Panel {
    return new Panel({ theme: this.options.theme, title, child });
  }

  #showMain(): void {
    this.#page = "main";
    this.#denialPage = undefined;
    this.#main = this.#createMain();
    this.#panel = this.#makePanel("Sandbox", this.#main);
  }

  #showDenials(): void {
    this.#page = "denials";
    this.#denialPage = new DenialPage({
      theme: this.options.theme,
      state: this.options.state,
      denials: this.options.denials,
      back: () => this.#showMain(),
      requestRender: () => this.options.tui.requestRender(),
    });
    this.#panel = this.#makePanel("Sandbox denials", this.#denialPage);
  }

  #showPolicy(): void {
    this.#page = "policy";
    const status = sandboxStatus(this.options.state, this.options.supportedMac);
    const repositoryReadOnly =
      status === "on" && this.options.state.repositoryReadOnly();
    const fields: [string, string][] = [
      [
        "Mode",
        `${status}${repositoryReadOnly ? " (repository-read-only child)" : ""}`,
      ],
      ...effectivePolicyFields(this.options.state, this.options.supportedMac),
    ];
    this.#panel = this.#makePanel("Sandbox policy", fieldsComponent(fields));
  }

  #close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.dispose();
    this.options.done();
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
