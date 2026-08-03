import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { SchedulerEvent } from "./scheduler/scheduler.js";
import type { RunState } from "./store.js";
import {
  TERMINAL_HANDOFF_ENTRY_TYPE,
  type TerminalHandoffEntry,
} from "./terminal-handoff-renderer.js";
import { renderTerminalHandoff } from "./terminal-handoff.js";

type TransitionEvent = SchedulerEvent | { kind: "planner_bound" };
type TerminalTransition = Extract<
  SchedulerEvent,
  { kind: "run_completed" | "run_incomplete" | "run_failed" }
>;

type PendingHandoff = Readonly<{
  identity: string;
  entry: TerminalHandoffEntry;
}>;

type HandoffContext = Pick<ExtensionContext, "isIdle">;

type TerminalHandoffPublisher = {
  capture(state: RunState, event: TransitionEvent, ctx: HandoffContext): void;
  flush(ctx: HandoffContext): void;
  hasPending(): boolean;
  dispose(): void;
};

export function createTerminalHandoffPublisher(
  pi: Pick<ExtensionAPI, "appendEntry">,
  render: (state: RunState) => string = renderTerminalHandoff,
): TerminalHandoffPublisher {
  let pending: PendingHandoff | undefined;
  let disposed = false;
  const captured = new Set<string>();
  const delivered = new Set<string>();

  const flush = (ctx: HandoffContext): void => {
    if (disposed || !pending || !ctx.isIdle()) {
      return;
    }
    try {
      pi.appendEntry(TERMINAL_HANDOFF_ENTRY_TYPE, pending.entry);
      delivered.add(pending.identity);
      pending = undefined;
    } catch {
      return;
    }
  };

  return {
    capture(state, event, ctx) {
      if (
        disposed ||
        !isTerminalTransition(event) ||
        !isTerminalPhase(state.phase)
      ) {
        return;
      }
      const identity = `${state.run.id}:${event.kind}`;
      if (captured.has(identity) || delivered.has(identity) || pending) {
        return;
      }
      try {
        pending = {
          identity,
          entry: {
            phase: state.phase,
            runId: state.run.id,
            text: render(state),
          },
        };
        captured.add(identity);
      } catch {
        return;
      }
      flush(ctx);
    },
    flush,
    hasPending() {
      return !disposed && pending !== undefined;
    },
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      pending = undefined;
      captured.clear();
      delivered.clear();
    },
  };
}

function isTerminalTransition(
  event: TransitionEvent,
): event is TerminalTransition {
  return ["run_completed", "run_incomplete", "run_failed"].includes(event.kind);
}

function isTerminalPhase(
  phase: RunState["phase"],
): phase is TerminalHandoffEntry["phase"] {
  return ["completed", "incomplete", "failed"].includes(phase);
}
