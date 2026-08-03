import { isAbsolute } from "node:path";
import type { Static } from "typebox";
import {
  anchoredOverallReviewSchema,
  anchoredWorkstreamReviewSchema,
  initialAnchoredOverallReviewSchema,
  initialAnchoredWorkstreamReviewSchema,
  initialOverallReviewSchema,
  initialWorkstreamReviewSchema,
  repositoryStateReviewSchema,
  overallReworkSchema,
  reconciliationCompletionSchema,
  revisionCompletionSchema,
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
    description: "Report the workstream outcome and evidence.",
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
    description:
      "Return direct whole-plan findings; the scheduler derives approval.",
    schema: initialOverallReviewSchema,
  },
  "initial-review": {
    role: "reviewer",
    readOnly: true,
    description:
      "Review a changed workstream and author its publication subject.",
    schema: initialWorkstreamReviewSchema,
  },
  "repository-state-review": {
    role: "reviewer",
    readOnly: true,
    description:
      "Return direct repository-state findings; the scheduler derives approval.",
    schema: repositoryStateReviewSchema,
  },
  "initial-anchored-review": {
    role: "reviewer",
    readOnly: true,
    description:
      "Assess an anchored changed candidate and author its first publication subject.",
    schema: initialAnchoredWorkstreamReviewSchema,
  },
  "anchored-review": {
    role: "reviewer",
    readOnly: true,
    description: "Assess every outstanding finding.",
    schema: anchoredWorkstreamReviewSchema,
  },
  "initial-anchored-overall-review": {
    role: "reviewer",
    readOnly: true,
    description:
      "Assess an anchored whole-plan repair and author its publication subject and replacement handoff.",
    schema: initialAnchoredOverallReviewSchema,
  },
  "anchored-overall-review": {
    role: "reviewer",
    readOnly: true,
    description:
      "Assess an anchored whole-plan repair and author its replacement handoff.",
    schema: anchoredOverallReviewSchema,
  },
  reconciliation: {
    role: "implementer",
    readOnly: false,
    description:
      "Report semantic evidence for the assigned candidate reconciliation.",
    schema: reconciliationCompletionSchema,
  },
  revision: {
    role: "implementer",
    readOnly: false,
    description:
      "Report semantic evidence for the assigned candidate revision.",
    schema: revisionCompletionSchema,
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
