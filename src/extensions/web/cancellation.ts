import { DeadlineError, throwIfAborted } from "./errors.js";

export type Deadline = {
  signal: AbortSignal;
  remaining: () => number;
  dispose: () => void;
};

export function createDeadline(milliseconds: number): Deadline {
  const controller = new AbortController();
  const endsAt = Date.now() + milliseconds;
  const timer = setTimeout(
    () => controller.abort(new DeadlineError()),
    milliseconds,
  );
  timer.unref();
  return {
    signal: controller.signal,
    remaining: () => Math.max(0, endsAt - Date.now()),
    dispose: () => clearTimeout(timer),
  };
}

export type ComposedSignal = {
  signal: AbortSignal;
  dispose: () => void;
};

export function composeSignal(
  signals: Array<AbortSignal | undefined>,
): ComposedSignal {
  const controller = new AbortController();
  const listeners: Array<readonly [AbortSignal, () => void]> = [];
  const abort = (signal: AbortSignal) => {
    if (!controller.signal.aborted) {
      controller.abort(signal.reason);
    }
  };
  for (const signal of signals) {
    if (!signal) {
      continue;
    }
    if (signal.aborted) {
      abort(signal);
      break;
    }
    const listener = () => abort(signal);
    signal.addEventListener("abort", listener, { once: true });
    listeners.push([signal, listener]);
  }
  return {
    signal: controller.signal,
    dispose: () => {
      for (const [signal, listener] of listeners) {
        signal.removeEventListener("abort", listener);
      }
    },
  };
}

export function assertActive(deadline: Deadline, signal?: AbortSignal): void {
  throwIfAborted(signal);
  throwIfAborted(deadline.signal);
  if (deadline.remaining() <= 0) {
    throwIfAborted(deadline.signal);
    throw new DeadlineError();
  }
}
