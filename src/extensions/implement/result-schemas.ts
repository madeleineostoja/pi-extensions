import { Type, type Static } from "typebox";

const nonEmptyString = () => Type.String({ minLength: 1 });
const strictCompiledContractSchema = Type.Object(
  {
    objective: nonEmptyString(),
    inScope: Type.Array(nonEmptyString(), { minItems: 1 }),
    acceptanceCriteria: Type.Array(nonEmptyString(), { minItems: 1 }),
    outOfScope: Type.Array(nonEmptyString(), { minItems: 1 }),
    implementationNotes: Type.Optional(nonEmptyString()),
    verificationGuidance: Type.Optional(nonEmptyString()),
  },
  { additionalProperties: false },
);
const strictExecutionTaskSchema = Type.Object(
  {
    id: Type.String({ pattern: "^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$" }),
    planIndex: Type.Integer({ minimum: 1 }),
    title: nonEmptyString(),
    dependsOn: Type.Array(nonEmptyString()),
    supportingDocuments: Type.Optional(Type.Array(nonEmptyString())),
    compiledContract: strictCompiledContractSchema,
  },
  { additionalProperties: false },
);
const strictWorkstreamSchema = Type.Object(
  {
    id: Type.String({ pattern: "^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$" }),
    taskIds: Type.Array(nonEmptyString(), { minItems: 1 }),
    dependsOn: Type.Array(nonEmptyString()),
  },
  { additionalProperties: false },
);

export const strictExecutionPlanSchema = Type.Object(
  {
    version: Type.Literal(1),
    tasks: Type.Array(strictExecutionTaskSchema, { minItems: 1 }),
    workstreams: Type.Array(strictWorkstreamSchema, { minItems: 1 }),
  },
  { additionalProperties: false },
);

export const workstreamImplementerResultSchema = Type.Object(
  {
    outcome: Type.Union([
      Type.Literal("changed"),
      Type.Literal("already_satisfied"),
    ]),
    summary: nonEmptyString(),
    verification: Type.Array(nonEmptyString(), { minItems: 1 }),
    uncertainty: Type.Optional(nonEmptyString()),
    taskCompletions: Type.Array(
      Type.Object(
        {
          taskId: nonEmptyString(),
          kind: Type.Union([
            Type.Literal("checkpoint"),
            Type.Literal("already_satisfied"),
          ]),
          checkpoint: Type.Optional(nonEmptyString()),
          evidence: Type.Optional(nonEmptyString()),
        },
        { additionalProperties: false },
      ),
      { minItems: 1 },
    ),
    candidateTip: Type.Optional(nonEmptyString()),
  },
  { additionalProperties: false },
);

export const directReviewFindingSchema = Type.Object(
  {
    summary: nonEmptyString(),
    evidence: nonEmptyString(),
    requiredChange: nonEmptyString(),
    acceptanceCriteria: Type.Array(nonEmptyString(), { minItems: 1 }),
  },
  { additionalProperties: false },
);

const initialReviewSchema = Type.Union([
  Type.Object(
    { verdict: Type.Literal("approved") },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      verdict: Type.Literal("changes_requested"),
      findings: Type.Array(directReviewFindingSchema, { minItems: 1 }),
    },
    { additionalProperties: false },
  ),
]);

export const initialWorkstreamReviewSchema = initialReviewSchema;
export const initialOverallReviewSchema = initialReviewSchema;

const findingAssessmentSchema = Type.Object(
  {
    id: nonEmptyString(),
    status: Type.Union([Type.Literal("resolved"), Type.Literal("unresolved")]),
    evidence: nonEmptyString(),
  },
  { additionalProperties: false },
);
const regressionFindingSchema = Type.Object(
  {
    summary: nonEmptyString(),
    evidence: nonEmptyString(),
    requiredChange: nonEmptyString(),
    acceptanceCriteria: Type.Array(nonEmptyString(), { minItems: 1 }),
    changedPaths: Type.Array(nonEmptyString(), { minItems: 1 }),
  },
  { additionalProperties: false },
);

export const anchoredWorkstreamReviewSchema = Type.Object(
  {
    assessments: Type.Array(findingAssessmentSchema),
    regressions: Type.Array(regressionFindingSchema),
    observations: Type.Optional(
      Type.Array(
        Type.Object(
          { summary: nonEmptyString(), evidence: nonEmptyString() },
          { additionalProperties: false },
        ),
      ),
    ),
  },
  { additionalProperties: false },
);
export const anchoredReviewSchema = anchoredWorkstreamReviewSchema;

export const overallReworkSchema = Type.Object(
  {
    summary: nonEmptyString(),
    verification: Type.Array(nonEmptyString(), { minItems: 1 }),
    commitMessage: Type.Optional(nonEmptyString()),
  },
  { additionalProperties: false },
);

export const wholePlanRecoveryCompletionSchema = Type.Object(
  {
    action: Type.Union([
      Type.Literal("diagnose"),
      Type.Literal("retry"),
      Type.Literal("no_safe_action"),
    ]),
    summary: nonEmptyString(),
    evidence: nonEmptyString(),
    diagnosis: Type.Optional(nonEmptyString()),
  },
  { additionalProperties: false },
);

export const recoveryCompletionSchema = Type.Object(
  {
    action: Type.Union([
      Type.Literal("diagnose"),
      Type.Literal("retry"),
      Type.Literal("rework_candidate"),
      Type.Literal("reconcile"),
      Type.Literal("recreate_workspace"),
      Type.Literal("no_safe_action"),
    ]),
    summary: nonEmptyString(),
    evidence: nonEmptyString(),
    diagnosis: Type.Optional(nonEmptyString()),
    candidateTip: Type.Optional(nonEmptyString()),
    changedPaths: Type.Optional(Type.Array(nonEmptyString())),
    trustedCheckpoint: Type.Optional(nonEmptyString()),
  },
  { additionalProperties: false },
);

export type WorkstreamImplementerCompletion = Static<
  typeof workstreamImplementerResultSchema
>;
export type DirectReviewFinding = Static<typeof directReviewFindingSchema>;
export type InitialWorkstreamReviewCompletion = Static<
  typeof initialWorkstreamReviewSchema
>;
export type InitialOverallReviewCompletion = Static<
  typeof initialOverallReviewSchema
>;
export type AnchoredWorkstreamReviewCompletion = Static<
  typeof anchoredWorkstreamReviewSchema
>;
export type OverallReworkCompletion = Static<typeof overallReworkSchema>;
export type WholePlanRecoveryCompletion = Static<
  typeof wholePlanRecoveryCompletionSchema
>;
export type RecoveryCompletion = Static<typeof recoveryCompletionSchema>;
