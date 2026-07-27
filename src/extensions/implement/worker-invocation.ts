import { isAbsolute } from "node:path";
import type { Static, TSchema } from "typebox";
import type {
  ImplementRoles,
  PiImplementWorkerRole,
  SpawnArgs,
  SubagentClient,
  SubagentHandle,
} from "./subagents.js";

export const MAX_WORKER_PROMPT_BYTES = 524_288;

export class WorkerPacketError extends Error {}

type InvocableWorkerPacket = {
  role: PiImplementWorkerRole;
  workspace: { path: string };
  identity: string;
};

export async function spawnValidatedWorker<
  TPacket extends InvocableWorkerPacket,
  TSchemaValue extends TSchema,
>(args: {
  packet: TPacket;
  subagents: SubagentClient;
  roles: ImplementRoles;
  taskId: string;
  description: string;
  readOnly?: boolean;
  completion: NonNullable<SpawnArgs<TSchemaValue>["completion"]>;
  render: (packet: TPacket) => string;
}): Promise<SubagentHandle<Static<TSchemaValue>>> {
  if (!isAbsolute(args.packet.workspace.path)) {
    throw new WorkerPacketError(
      `${args.packet.role} packet ${args.packet.identity} has a non-absolute workspace.`,
    );
  }
  const role = args.roles[args.packet.role];
  const expectedIdentity = `pipkin:implement:${args.packet.role}`;
  if (role.type !== expectedIdentity) {
    throw new WorkerPacketError(
      `${args.packet.role} packet ${args.packet.identity} has an invalid worker identity.`,
    );
  }
  const prompt = args.render(args.packet);
  const actualBytes = Buffer.byteLength(prompt, "utf8");
  if (actualBytes > MAX_WORKER_PROMPT_BYTES) {
    throw new WorkerPacketError(
      `${args.packet.role} packet ${args.packet.identity} is ${actualBytes} bytes; maximum is ${MAX_WORKER_PROMPT_BYTES}.`,
    );
  }
  return args.subagents.spawn({
    type: role.type,
    role: args.packet.role,
    model: role.model,
    thinking: role.thinking,
    taskId: args.taskId,
    description: args.description,
    cwd: args.packet.workspace.path,
    ...(args.readOnly ? { readOnly: true } : {}),
    prompt,
    completion: args.completion,
  });
}
