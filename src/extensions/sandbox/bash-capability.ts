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

const managerKey = Symbol.for("pipkin:sandbox:bash");

function getManager(): SandboxBashManager | undefined {
  return (globalThis as Record<symbol, unknown>)[managerKey] as
    | SandboxBashManager
    | undefined;
}

export async function executeSandboxBash(
  host: SandboxBashHost,
  request: SandboxBashRequest,
): Promise<AgentToolResult<BashToolDetails | undefined>> {
  const binding = getManager()?.bindings.get(host);
  if (!binding) {
    throw new Error("Sandbox: Bash execution is unavailable.");
  }
  return binding.execute(request);
}

export async function startSandboxManagedExecution(
  host: SandboxBashHost,
  request: SandboxManagedRequest,
): Promise<SandboxExecutionLease> {
  const binding = getManager()?.bindings.get(host);
  if (!binding?.startManaged) {
    throw new Error("Sandbox: managed execution is unavailable.");
  }
  return binding.startManaged(request);
}
