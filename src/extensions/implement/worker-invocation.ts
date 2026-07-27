import { isAbsolute } from "node:path";
import type { Static, TSchema } from "typebox";
import {
  anchoredWorkstreamReviewSchema,
  initialWorkstreamReviewSchema,
  recoveryCompletionSchema,
  strictExecutionPlanSchema,
  workstreamImplementerResultSchema,
} from "./result-schemas.js";
import type {
  ImplementRoles,
  PiImplementWorkerRole,
  SpawnArgs,
  SubagentClient,
  SubagentHandle,
} from "./subagents.js";

export const MAX_WORKER_PROMPT_BYTES = 524_288;

export class WorkerPacketError extends Error {}

const completionContracts = {
  planner: {
    description: "Return the strict execution plan.",
    schema: strictExecutionPlanSchema,
  },
  implementer: {
    description: "Report the workstream checkpoints or satisfied evidence.",
    schema: workstreamImplementerResultSchema,
  },
  "initial-review": {
    description: "Approve or return direct blocking findings.",
    schema: initialWorkstreamReviewSchema,
  },
  "anchored-review": {
    description: "Assess every outstanding finding.",
    schema: anchoredWorkstreamReviewSchema,
  },
  recovery: {
    description: "Return one bounded recovery action.",
    schema: recoveryCompletionSchema,
  },
} as const;

export type WorkerCompletionKind =
  | "planner"
  | "implementer"
  | "initial-review"
  | "anchored-review"
  | "recovery";

type InvocableWorkerPacket = {
  role: PiImplementWorkerRole;
  completionKind: WorkerCompletionKind;
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
  readOnly: boolean;
  completionKind: TPacket["completionKind"];
  completion: NonNullable<SpawnArgs<TSchemaValue>["completion"]>;
  render: (packet: TPacket) => string;
}): Promise<SubagentHandle<Static<TSchemaValue>>> {
  const expectedReadOnly =
    args.packet.role === "planner" || args.packet.role === "reviewer";
  if (args.readOnly !== expectedReadOnly) {
    throw new WorkerPacketError(
      `${args.packet.role} packet ${args.packet.identity} has an invalid read-only contract.`,
    );
  }
  const completion = completionContracts[args.packet.completionKind];
  if (
    args.completionKind !== args.packet.completionKind ||
    args.completion.description !== completion.description ||
    (args.completion.schema as TSchema) !== completion.schema
  ) {
    throw new WorkerPacketError(
      `${args.packet.role} packet ${args.packet.identity} has a mismatched completion contract.`,
    );
  }
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
