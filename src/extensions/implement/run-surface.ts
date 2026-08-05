import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  getMarkdownTheme,
  keyHint,
  rawKeyHint,
  type ExtensionCommandContext,
  type KeybindingsManager,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { Markdown, type Component, type TUI } from "@earendil-works/pi-tui";
import { Panel } from "#lib/ui/panel";
import { ScrollViewport } from "#lib/ui/scroll-viewport";
import { plannerAttemptPath } from "./execution-plan.js";
import { sourceCorpusPath } from "./requirements-context.js";
import { checkoutPaths, type RunState } from "./store.js";

type RunSurfaceMode = "overview" | "details";

export async function showImplementRunSurface(
  ctx: ExtensionCommandContext,
  checkoutRoot: string,
  state: RunState,
  mode: RunSurfaceMode,
): Promise<void> {
  await ctx.ui.custom<void>(
    (tui, theme, keybindings, done) =>
      new ImplementRunSurface(
        tui,
        theme,
        keybindings,
        done,
        checkoutRoot,
        state,
        mode,
      ),
  );
}

class ImplementRunSurface implements Component {
  readonly #scroll: ScrollViewport;
  readonly #panel: Panel;

  constructor(
    private readonly tui: TUI,
    theme: Theme,
    private readonly keybindings: Pick<KeybindingsManager, "matches">,
    private readonly done: () => void,
    checkoutRoot: string,
    state: RunState,
    mode: RunSurfaceMode,
  ) {
    const maxRows = Math.max(8, Math.floor((tui.terminal.rows ?? 24) * 0.8));
    this.#scroll = new ScrollViewport({
      content: new Markdown(
        runMarkdown(checkoutRoot, state, mode),
        0,
        0,
        getMarkdownTheme(),
      ),
      viewportHeight: Math.max(1, maxRows - 6),
    });
    this.#panel = new Panel({
      theme,
      title: `Implement · ${state.run.id}`,
      subtitle: `${state.phase} · ${taskProgress(state)}`,
      child: this.#scroll,
      footer: {
        render: () => [
          `${rawKeyHint("↑↓", "scroll")}  ${keyHint("tui.select.cancel", "close")}`,
        ],
        invalidate() {},
      },
    });
  }

  handleInput(data: string): void {
    if (this.keybindings.matches(data, "tui.select.cancel")) {
      this.done();
      return;
    }
    const up = this.keybindings.matches(data, "tui.select.up");
    const down = this.keybindings.matches(data, "tui.select.down");
    if (up || down) {
      this.#scroll.handleInput(up ? "\x1b[A" : "\x1b[B", {
        homeEnd: true,
      });
      this.tui.requestRender();
    }
  }

  render(width: number): string[] {
    return this.#panel.render(width);
  }

  invalidate(): void {
    this.#panel.invalidate();
  }
}

export function runMarkdown(
  checkoutRoot: string,
  state: RunState,
  mode: RunSurfaceMode,
): string {
  const paths = checkoutPaths(checkoutRoot);
  const runDirectory = join(paths.runs, state.run.id);
  const worktree = join(paths.worktrees, state.run.id);
  const source = Object.values(state.workstreams.source);
  const overall = Object.values(state.workstreams.overall);
  const workstreams = [
    ...source.map((item) => ({ id: item.id, phase: item.phase })),
    ...overall.map((item) => ({ id: item.repairId, phase: item.phase })),
  ];
  const activeProcesses = Object.values(state.processLeases);
  const openFindings = Object.values(state.findings).filter(
    (finding) => finding.status === "open",
  );
  const openRevisions = Object.values(state.revisionAssignments).filter(
    (revision) => revision.status === "open",
  );
  const receipts = Object.keys(state.publication.receipts).length;
  const intents = Object.keys(state.publication.intents).length;
  const failures = Object.values(state.failures);
  const latestFailure = failures.at(-1) ?? state.failure;
  const publicationUncertainty =
    state.failure?.category === "publication_uncertain"
      ? state.failure.reason
      : failures
          .filter((failure) => failure.category === "publication_uncertain")
          .at(-1)?.evidence;
  const overview = [
    "## Overview",
    `- **Phase:** ${state.phase}`,
    `- **Tasks:** ${taskProgress(state)}`,
    `- **Workstreams:** ${workstreams.length}`,
    `- **Active processes:** ${activeProcesses.length}`,
    `- **Open findings:** ${openFindings.length}`,
    `- **Open revisions:** ${openRevisions.length}`,
    `- **Publication:** ${receipts}/${intents} receipted`,
    `- **Projection debt:** ${state.projectionDebt.length}`,
  ];
  const sections: string[][] = [overview];
  if (latestFailure) {
    sections.push([
      "## Latest failure",
      `- **${latestFailure.category}:** ${"evidence" in latestFailure ? latestFailure.evidence : latestFailure.reason}`,
    ]);
  }
  if (mode === "overview") {
    return sections.map((section) => section.join("\n")).join("\n\n");
  }

  if (workstreams.length > 0) {
    sections.push([
      "## Workstreams",
      ...workstreams.map((item) => `- **${item.id}:** ${item.phase}`),
    ]);
  }
  if (activeProcesses.length > 0) {
    sections.push([
      "## Active processes",
      ...activeProcesses.map((lease) => `- **${lease.kind}:** ${lease.id}`),
    ]);
  }
  sections.push([
    "## Attention",
    `- Open findings: ${openFindings.length}`,
    ...openFindings.map(
      (finding) => `- **${finding.id}:** ${finding.evidence}`,
    ),
    `- Open revisions: ${openRevisions.length}`,
    ...openRevisions.map(
      (revision) => `- **${revision.id}:** ${revision.status}`,
    ),
  ]);

  const candidates = Object.values(state.candidates);
  if (candidates.length > 0) {
    sections.push([
      "## Candidates",
      ...candidates.map((candidate) => {
        const key =
          candidate.workstream.kind === "source"
            ? `source:${candidate.workstream.id}`
            : `overall:${candidate.workstream.repairId}`;
        const review = state.reviews[key];
        return `- **${candidate.id}:** base ${candidate.baseSha}${candidate.integrationBaseSha ? ` · integration ${candidate.integrationBaseSha}` : ""}${review?.latestCorrection ? ` · ${review.latestCorrection.mode} correction: ${review.latestCorrection.evidence}` : ""}`;
      }),
    ]);
  }

  const reconciliation = Object.values(state.reconciliationAssignments);
  if (reconciliation.length > 0) {
    sections.push([
      "## Reconciliation",
      ...reconciliation.map(
        (assignment) =>
          `- **${assignment.id}:** attempt ${assignment.semanticAttempt} · ${assignment.status} · target ${assignment.targetSha}`,
      ),
    ]);
  }

  if (failures.length > 0 || state.failure) {
    sections.push([
      "## Failures",
      ...failures.map(
        (failure) =>
          `- **${failure.category}:** ${failure.assignment} · ${failure.evidence}`,
      ),
      ...(state.failure
        ? [
            `- **${state.failure.category}:** ${state.failure.reason} · ${state.failure.originPhase}`,
          ]
        : []),
    ]);
  }

  const publication = Object.values(state.publication.intents);
  sections.push([
    "## Publication",
    `- Receipts: ${receipts}/${intents}`,
    `- Superseded: ${Object.keys(state.publication.supersessions).length}`,
    `- Abandoned: ${Object.keys(state.publication.abandonments).length}`,
    ...publication.map((intent) => {
      const receipt = state.publication.receipts[intent.id];
      const supersession = state.publication.supersessions[intent.id];
      const abandonment = state.publication.abandonments[intent.id];
      const outcome = receipt
        ? `published ${receipt.publishedCommitSha}`
        : supersession
          ? `superseded by ${supersession.actualTargetSha}`
          : abandonment
            ? "abandoned"
            : "pending";
      return `- **${intent.id}:** target ${intent.targetBaseSha} · ${outcome}`;
    }),
    ...(publicationUncertainty
      ? [`- **Uncertainty:** ${publicationUncertainty}`]
      : []),
  ]);

  const executionPlan = join(runDirectory, "execution-plan.json");
  const sourceCorpus = sourceCorpusPath(runDirectory);
  const plannerAttempt = plannerAttemptPath(runDirectory);
  const artifacts = join(runDirectory, "artifacts");
  sections.push([
    "## Paths",
    `- State: ${join(runDirectory, "run-state.json")}`,
    `- Source plan: ${state.run.source.entry.path}`,
    `- Planner attempt: ${retainedPath(plannerAttempt)}`,
    `- Execution plan: ${retainedPath(executionPlan)}`,
    `- Source corpus: ${retainedPath(sourceCorpus)}`,
    `- Artifacts: ${retainedPath(artifacts)}`,
    `- Retained worktree: ${existsSync(worktree) ? worktree : "none"}`,
  ]);

  return sections.map((section) => section.join("\n")).join("\n\n");
}

function retainedPath(path: string): string {
  return existsSync(path) ? path : `${path} (not retained)`;
}

function taskProgress(state: RunState): string {
  const tasks = Object.values(state.tasks);
  const completed = tasks.filter((task) => task.phase === "published").length;
  return `${completed}/${tasks.length}`;
}
