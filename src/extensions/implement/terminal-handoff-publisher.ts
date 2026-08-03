import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { SchedulerEvent } from "./scheduler/scheduler.js";
import type { RunState } from "./store.js";
import { renderTerminalHandoff } from "./terminal-handoff.js";

type TransitionEvent = SchedulerEvent | { kind: "planner_bound" };
type TerminalTransition = Extract<
  SchedulerEvent,
  { kind: "run_completed" | "run_incomplete" | "run_failed" }
>;

type PendingHandoff = Readonly<{ identity: string; text: string }>;

type HandoffContext = Pick<ExtensionContext, "isIdle">;

type TerminalHandoffPublisher = {
  capture(state: RunState, event: TransitionEvent, ctx: HandoffContext): void;
  flush(ctx: HandoffContext): void;
  hasPending(): boolean;
  dispose(): void;
};

export function createTerminalHandoffPublisher(
  pi: Pick<ExtensionAPI, "sendMessage">,
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
      pi.sendMessage(
        {
          customType: "pipkin.implement.terminal-handoff",
          content: pending.text,
          display: true,
        },
        { triggerTurn: true },
      );
      delivered.add(pending.identity);
      pending = undefined;
    } catch {
      return;
    }
  };

  return {
    capture(state, event, ctx) {
      if (disposed || !isTerminalTransition(event)) {
        return;
      }
      const identity = `${state.run.id}:${event.kind}`;
      if (captured.has(identity) || delivered.has(identity) || pending) {
        return;
      }
      try {
        pending = { identity, text: render(state) };
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
