const MAX_RECENT_DENIALS = 10;
const MAX_VALUE_LENGTH = 512;

export type SandboxDirectDenial = Readonly<{
  kind: "direct";
  at: number;
  tool: "write" | "edit";
  requestedPath?: string;
  target?: string;
  reason: string;
}>;

export type SandboxBashDenial = Readonly<{
  kind: "bash";
  at: number;
  process: string;
  pid: number;
  operation: string;
  path: string;
}>;

export type SandboxDenial = SandboxDirectDenial | SandboxBashDenial;

export type SandboxDenialRecorder = Readonly<{
  recordDirect: (denial: Omit<SandboxDirectDenial, "at" | "kind">) => void;
  recordBash: (denial: Omit<SandboxBashDenial, "at" | "kind">) => void;
  reset: () => void;
  snapshot: () => Readonly<{
    count: number;
    recent: readonly SandboxDenial[];
  }>;
  subscribe: (listener: () => void) => () => void;
}>;

function bounded(value: string): string {
  return Array.from(value, (character) =>
    /\p{C}/u.test(character) ? "�" : character,
  )
    .join("")
    .slice(0, MAX_VALUE_LENGTH);
}

export function createSandboxDenialRecorder(): SandboxDenialRecorder {
  let count = 0;
  let recent: SandboxDenial[] = [];
  const listeners = new Set<() => void>();

  const changed = () => {
    for (const listener of listeners) {
      listener();
    }
  };
  const record = (denial: SandboxDenial) => {
    count = Math.min(count + 1, Number.MAX_SAFE_INTEGER);
    recent = [...recent, denial].slice(-MAX_RECENT_DENIALS);
    changed();
  };

  return {
    recordDirect(denial) {
      record({
        kind: "direct",
        at: Date.now(),
        tool: denial.tool,
        requestedPath:
          denial.requestedPath === undefined
            ? undefined
            : bounded(denial.requestedPath),
        target:
          denial.target === undefined ? undefined : bounded(denial.target),
        reason: bounded(denial.reason),
      });
    },
    recordBash(denial) {
      record({
        kind: "bash",
        at: Date.now(),
        process: bounded(denial.process),
        pid: denial.pid,
        operation: bounded(denial.operation),
        path: bounded(denial.path),
      });
    },
    reset() {
      count = 0;
      recent = [];
      changed();
    },
    snapshot() {
      return { count, recent: [...recent] };
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
