import { isAbsolute } from "node:path";
import type { Static } from "typebox";
import {
  anchoredWorkstreamReviewSchema,
  initialOverallReviewSchema,
  initialWorkstreamReviewSchema,
  overallReworkSchema,
  recoveryCompletionSchema,
  wholePlanRecoveryCompletionSchema,
  strictExecutionPlanSchema,
  workstreamImplementerResultSchema,
} from "./result-schemas.js";
import type {
  ImplementRoles,
  PiImplementWorkerRole,
  SubagentClient,
  SubagentHandle,
} from "./subagents.js";

export class WorkerPacketError extends Error {}

const completionContracts = {
  planner: {
    role: "planner",
    readOnly: true,
    description: "Return the strict execution plan.",
    schema: strictExecutionPlanSchema,
  },
  implementer: {
    role: "implementer",
    readOnly: false,
    description: "Report the workstream checkpoints or satisfied evidence.",
    schema: workstreamImplementerResultSchema,
  },
  "overall-rework": {
    role: "implementer",
    readOnly: false,
    description: "Report evidence for each whole-plan finding.",
    schema: overallReworkSchema,
  },
  "initial-overall-review": {
    role: "reviewer",
    readOnly: true,
    description: "Approve the complete run or return direct blocking findings.",
    schema: initialOverallReviewSchema,
  },
  "initial-review": {
    role: "reviewer",
    readOnly: true,
    description: "Approve or return direct blocking findings.",
    schema: initialWorkstreamReviewSchema,
  },
  "anchored-review": {
    role: "reviewer",
    readOnly: true,
    description: "Assess every outstanding finding.",
    schema: anchoredWorkstreamReviewSchema,
  },
  recovery: {
    role: "recovery",
    readOnly: false,
    description: "Return one bounded recovery action.",
    schema: recoveryCompletionSchema,
  },
  "whole-plan-recovery": {
    role: "recovery",
    readOnly: true,
    description: "Return a bounded whole-plan recovery action.",
    schema: wholePlanRecoveryCompletionSchema,
  },
} as const;

export type WorkerCompletionKind = keyof typeof completionContracts;
type CompletionSchema<K extends WorkerCompletionKind> =
  (typeof completionContracts)[K]["schema"];
type InvocableWorkerPacket<K extends WorkerCompletionKind> = {
  completionKind: K;
  workspace: { path: string };
  identity: string;
};

export async function spawnValidatedWorker<
  TPacket extends { completionKind: WorkerCompletionKind },
>(args: {
  packet: TPacket & InvocableWorkerPacket<TPacket["completionKind"]>;
  subagents: SubagentClient;
  roles: ImplementRoles;
  taskId: string;
  description: string;
  render: (packet: TPacket) => string;
}): Promise<
  SubagentHandle<Static<CompletionSchema<TPacket["completionKind"]>>>
> {
  const { packet } = args;
  const completion = completionContracts[packet.completionKind];
  if (!isAbsolute(packet.workspace.path)) {
    throw new WorkerPacketError(
      `${completion.role} packet ${packet.identity} has a non-absolute workspace.`,
    );
  }
  const roleName = completion.role;
  const role = args.roles[roleName as PiImplementWorkerRole];
  const expectedIdentity = `pipkin:implement:${roleName}`;
  if (role.type !== expectedIdentity) {
    throw new WorkerPacketError(
      `${roleName} packet ${packet.identity} has an invalid worker identity.`,
    );
  }
  const prompt = args.render(packet);
  return args.subagents.spawn({
    type: role.type,
    role: roleName,
    model: role.model,
    thinking: role.thinking,
    taskId: args.taskId,
    description: args.description,
    cwd: packet.workspace.path,
    ...(completion.readOnly ? { readOnly: true } : {}),
    prompt,
    completion: {
      description: completion.description,
      schema: completion.schema,
    },
  }) as Promise<
    SubagentHandle<Static<CompletionSchema<TPacket["completionKind"]>>>
  >;
}
