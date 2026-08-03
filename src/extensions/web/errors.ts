export class WebError extends Error {
  constructor(
    readonly kind:
      | "target"
      | "dns"
      | "network"
      | "redirect"
      | "oversize"
      | "http"
      | "content"
      | "extract",
    message: string,
  ) {
    super(message);
    this.name = "WebError";
  }
}

export class DeadlineError extends Error {
  constructor() {
    super("Web Fetch timed out before the request could complete.");
    this.name = "TimeoutError";
  }
}

export function abortReason(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) {
    return signal.reason;
  }
  return new DOMException("The operation was cancelled.", "AbortError");
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw abortReason(signal);
  }
}
