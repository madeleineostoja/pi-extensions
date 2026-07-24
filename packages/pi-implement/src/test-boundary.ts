type PromiseState = "pending" | "fulfilled" | "rejected";

export type PromiseObservation = {
  readonly describe: () => string;
  readonly state: () => PromiseState;
};

export function observePromise(
  label: string,
  promise: Promise<unknown>,
): PromiseObservation {
  let state: PromiseState = "pending";
  let detail = "";
  void promise.then(
    () => {
      state = "fulfilled";
    },
    (error: unknown) => {
      state = "rejected";
      detail = error instanceof Error ? error.message : String(error);
    },
  );
  return {
    describe: () => `${label} is ${state}${detail ? `: ${detail}` : ""}`,
    state: () => state,
  };
}

export async function waitForCondition(
  description: string,
  condition: () => boolean,
  options: {
    timeoutMs?: number;
    diagnostics?: () => string;
    observations?: PromiseObservation[];
  } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 2_000;
  const started = Date.now();
  while (!condition()) {
    const settled = options.observations?.find(
      (observation) => observation.state() !== "pending",
    );
    if (settled) {
      throw new Error(`${settled.describe()} before ${description} completed`);
    }
    if (Date.now() - started >= timeoutMs) {
      throw new Error(
        `Timed out waiting for ${description} after ${timeoutMs}ms${options.diagnostics ? `; ${options.diagnostics()}` : ""}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

export async function remainsTrue(
  description: string,
  condition: () => boolean,
  options: { durationMs?: number; diagnostics?: () => string } = {},
): Promise<void> {
  const durationMs = options.durationMs ?? 30;
  const deadline = Date.now() + durationMs;
  while (Date.now() < deadline) {
    if (!condition()) {
      throw new Error(
        `${description} changed before ${durationMs}ms${options.diagnostics ? `; ${options.diagnostics()}` : ""}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

export async function within<T>(
  description: string,
  promise: Promise<T>,
  options: { timeoutMs?: number; diagnostics?: () => string } = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 2_000;
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          reject(
            new Error(
              `Timed out waiting for ${description} after ${timeoutMs}ms${options.diagnostics ? `; ${options.diagnostics()}` : ""}`,
            ),
          );
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

export async function settle(
  description: string,
  promise: Promise<unknown>,
  options: { timeoutMs?: number; diagnostics?: () => string } = {},
): Promise<void> {
  let settled = false;
  void promise
    .finally(() => {
      settled = true;
    })
    .catch(() => undefined);
  await waitForCondition(`${description} to settle`, () => settled, options);
}

export async function settleAll(cleanups: Promise<void>[]): Promise<void> {
  const results = await Promise.allSettled(cleanups);
  const failed = results.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (failed) {
    throw failed.reason;
  }
}
