import { Type, type Static } from "typebox";

const nonEmptyString = () => Type.String({ minLength: 1 });
const commitMessageString = (options: { description?: string } = {}) =>
  Type.String({
    minLength: 1,
    pattern: "^[a-z]+(?:\\([^\\r\\n()]+\\))?!?: [^\\r\\n]+$",
    ...options,
  });
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

export const workstreamImplementerResultSchema = Type.Union([
  Type.Object(
    {
      outcome: Type.Literal("changed"),
      summary: nonEmptyString(),
      verification: Type.Array(nonEmptyString(), { minItems: 1 }),
      uncertainty: Type.Optional(nonEmptyString()),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      outcome: Type.Literal("already_satisfied"),
      evidence: nonEmptyString(),
      summary: nonEmptyString(),
      verification: Type.Array(nonEmptyString(), { minItems: 1 }),
      uncertainty: Type.Optional(nonEmptyString()),
    },
    { additionalProperties: false },
  ),
]);

export const directReviewFindingSchema = Type.Object(
  {
    summary: nonEmptyString(),
    evidence: nonEmptyString(),
    requiredChange: nonEmptyString(),
    acceptanceCriteria: Type.Array(nonEmptyString(), { minItems: 1 }),
  },
  { additionalProperties: false },
);

const approvalSchema = Type.Object(
  { verdict: Type.Literal("approved") },
  { additionalProperties: false },
);
const changesRequestedReviewSchema = Type.Object(
  {
    verdict: Type.Literal("changes_requested"),
    findings: Type.Array(directReviewFindingSchema, { minItems: 1 }),
  },
  { additionalProperties: false },
);
const publicationCommitSubject = () =>
  commitMessageString({
    description:
      "Conventional Commit subject for the complete reviewed workstream, not an internal checkpoint or correction commit.",
  });

export const initialWorkstreamReviewSchema = Type.Union([
  Type.Object(
    {
      verdict: Type.Literal("approved"),
      publicationCommitSubject: publicationCommitSubject(),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      verdict: Type.Literal("changes_requested"),
      findings: Type.Array(directReviewFindingSchema, { minItems: 1 }),
      publicationCommitSubject: publicationCommitSubject(),
    },
    { additionalProperties: false },
  ),
]);
export const repositoryStateReviewSchema = Type.Union([
  approvalSchema,
  changesRequestedReviewSchema,
]);
export const initialOverallReviewSchema = Type.Union([
  approvalSchema,
  changesRequestedReviewSchema,
]);

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

const anchoredReviewProperties = {
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
};

export const anchoredWorkstreamReviewSchema = Type.Object(
  anchoredReviewProperties,
  { additionalProperties: false },
);
export const initialAnchoredWorkstreamReviewSchema = Type.Object(
  {
    ...anchoredReviewProperties,
    publicationCommitSubject: publicationCommitSubject(),
  },
  { additionalProperties: false },
);
export const anchoredReviewSchema = anchoredWorkstreamReviewSchema;

export const overallReworkSchema = Type.Object(
  {
    summary: nonEmptyString(),
    verification: Type.Array(nonEmptyString(), { minItems: 1 }),
    uncertainty: Type.Optional(nonEmptyString()),
  },
  { additionalProperties: false },
);

export const revisionCompletionSchema = Type.Union([
  Type.Object(
    {
      outcome: Type.Literal("changed"),
      summary: nonEmptyString(),
      verification: Type.Array(nonEmptyString(), { minItems: 1 }),
      uncertainty: Type.Optional(nonEmptyString()),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      outcome: Type.Literal("blocked"),
      summary: nonEmptyString(),
      evidence: nonEmptyString(),
      verification: Type.Array(nonEmptyString(), { minItems: 1 }),
      uncertainty: Type.Optional(nonEmptyString()),
    },
    { additionalProperties: false },
  ),
]);

export type WorkstreamImplementerCompletion = Static<
  typeof workstreamImplementerResultSchema
>;
export type DirectReviewFinding = Static<typeof directReviewFindingSchema>;
export type InitialWorkstreamReviewCompletion = Static<
  typeof initialWorkstreamReviewSchema
>;
export type RepositoryStateReviewCompletion = Static<
  typeof repositoryStateReviewSchema
>;
export type InitialOverallReviewCompletion = Static<
  typeof initialOverallReviewSchema
>;
export type AnchoredWorkstreamReviewCompletion = Static<
  typeof anchoredWorkstreamReviewSchema
>;
export type InitialAnchoredWorkstreamReviewCompletion = Static<
  typeof initialAnchoredWorkstreamReviewSchema
>;
export type OverallReworkCompletion = Static<typeof overallReworkSchema>;
export type RevisionCompletion = Static<typeof revisionCompletionSchema>;
