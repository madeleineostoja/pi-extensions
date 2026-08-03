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

type Binding = { token: object; execute: SandboxBashExecutor };
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
