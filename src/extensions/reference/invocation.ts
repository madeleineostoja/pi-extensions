import { LIMITS } from "./bounds.js";

export function createReferenceInvocation(signal?: AbortSignal): {
  signal: AbortSignal;
  dispose(): void;
} {
  const controller = new AbortController();
  const deadline = setTimeout(
    () => controller.abort("deadline"),
    LIMITS.deadlineMs,
  );
  const abort = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) {
    abort();
  }
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(deadline);
      signal?.removeEventListener("abort", abort);
      controller.abort();
    },
  };
}

export function isCancelled(signal: AbortSignal): boolean {
  return signal.aborted && signal.reason !== "deadline";
}
