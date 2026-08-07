import type {
  AgentToolResult,
  AgentToolUpdateCallback,
  BashToolDetails,
  BashToolInput,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

export type SandboxBashHost = ExtensionAPI["events"];

export type SandboxBashRequest = Readonly<{
  toolCallId: string;
  params: BashToolInput;
  signal: AbortSignal | undefined;
  onUpdate: AgentToolUpdateCallback<BashToolDetails | undefined> | undefined;
  ctx: ExtensionContext;
}>;

type SandboxBashExecutor = (
  request: SandboxBashRequest,
) => Promise<AgentToolResult<BashToolDetails | undefined>>;

export type SandboxOutputEvent = Readonly<{
  stream: "stdout" | "stderr";
  data: Buffer;
}>;

export type SandboxExecutionTerminal = Readonly<{
  exitCode: number | null;
  signal: string | null;
  termination: "natural" | "stopped" | "shutdown";
  outputComplete: boolean;
}>;

export type SandboxExecutionLease = Readonly<{
  pid: number;
  completion: Promise<SandboxExecutionTerminal>;
  stop: () => Promise<SandboxExecutionTerminal>;
}>;

export type SandboxManagedRequest = Readonly<{
  toolCallId: string;
  command: string;
  cwd: string;
  ctx: ExtensionContext;
  signal: AbortSignal | undefined;
  onOutput: (event: SandboxOutputEvent) => void;
}>;

type SandboxManagedExecutor = (
  request: SandboxManagedRequest,
) => Promise<SandboxExecutionLease>;

type Binding = {
  token: object;
  execute: SandboxBashExecutor;
  startManaged: SandboxManagedExecutor | undefined;
};
type SandboxBashManager = { bindings: WeakMap<object, Binding> };
type EventHost = {
  emit: (channel: string, data: unknown) => void;
  on: (channel: string, handler: (data: unknown) => void) => () => void;
};
const managerKey = Symbol.for("pipkin:sandbox:bash");
export const SANDBOX_BASH_LOOKUP_CHANNEL = "pipkin:sandbox:bash-lookup";

function getManager(): SandboxBashManager | undefined {
  return (globalThis as Record<symbol, unknown>)[managerKey] as
    | SandboxBashManager
    | undefined;
}

export async function executeSandboxBash(
  host: SandboxBashHost,
  request: SandboxBashRequest,
): Promise<AgentToolResult<BashToolDetails | undefined>> {
  const binding = lookupBinding(host);
  if (!binding) {
    throw new Error("Sandbox: Bash execution is unavailable.");
  }
  return binding.execute(request);
}

export async function startSandboxManagedExecution(
  host: SandboxBashHost,
  request: SandboxManagedRequest,
): Promise<SandboxExecutionLease> {
  const binding = lookupBinding(host);
  if (!binding?.startManaged) {
    throw new Error("Sandbox: managed execution is unavailable.");
  }
  return binding.startManaged(request);
}

function lookupBinding(host: SandboxBashHost): Binding | undefined {
  const direct = getManager()?.bindings.get(host);
  if (direct) {
    return direct;
  }
  let resolved: Binding | undefined;
  eventHost(host)?.emit(SANDBOX_BASH_LOOKUP_CHANNEL, {
    resolve: (binding: Binding) => (resolved ??= binding),
  });
  return resolved;
}

function eventHost(host: SandboxBashHost): EventHost | undefined {
  return host &&
    typeof host.emit === "function" &&
    typeof host.on === "function"
    ? host
    : undefined;
}
