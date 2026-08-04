import { Type, type Static } from "typebox";

const text = (description: string) =>
  Type.String({ minLength: 1, description });
const textList = (description: string, itemDescription: string) =>
  Type.Array(text(itemDescription), { minItems: 1, description });
const handoffDraft = () =>
  Type.String({
    minLength: 1,
    maxLength: 12_000,
    pattern: "\\S",
    description:
      "Complete replacement Markdown handoff for the cumulative Implement run, organized under Summary, Material changes, Verification, and Residual findings.",
  });
const commitMessageString = (description: string) =>
  Type.String({
    minLength: 1,
    pattern: "^[a-z]+(?:\\([^\\r\\n()]+\\))?!?: [^\\r\\n]+$",
    description,
  });
const strictCompiledContractSchema = Type.Object(
  {
    objective: text("Observable goal the task must achieve."),
    inScope: textList(
      "Required work included in this task.",
      "One concrete required scope item.",
    ),
    acceptanceCriteria: textList(
      "Observable conditions that determine whether the task is complete.",
      "One concrete condition the completed work must satisfy.",
    ),
    outOfScope: textList(
      "Work deliberately excluded from this task.",
      "One excluded change or concern.",
    ),
    implementationNotes: Type.Optional(
      text(
        "Required implementation constraint, decision, or reuse opportunity; omit when none is material.",
      ),
    ),
    verificationGuidance: Type.Optional(
      text(
        "Proportionate verification guidance for the changed behavior; omit when ordinary project checks suffice.",
      ),
    ),
  },
  {
    additionalProperties: false,
    description: "Complete executable contract for one source-plan task.",
  },
);
const strictExecutionTaskSchema = Type.Object(
  {
    id: Type.String({
      pattern: "^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$",
      description: "Stable lowercase task identifier, one to 64 characters.",
    }),
    planIndex: Type.Integer({
      minimum: 1,
      description: "One-based source-plan position for this task.",
    }),
    title: text("Concise task title describing the intended change."),
    dependsOn: Type.Array(
      text("Identifier of an earlier task this task depends on."),
      {
        description:
          "Earlier task identifiers that must complete before this task.",
      },
    ),
    supportingDocuments: Type.Optional(
      Type.Array(
        text("Linked requirement-document path supplied to the planner."),
        {
          description:
            "Linked requirement documents relevant to this task; omit when none are needed.",
        },
      ),
    ),
    compiledContract: strictCompiledContractSchema,
  },
  { additionalProperties: false },
);
const strictWorkstreamSchema = Type.Object(
  {
    id: Type.String({
      pattern: "^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$",
      description:
        "Stable lowercase workstream identifier, one to 64 characters.",
    }),
    taskIds: textList(
      "Task identifiers assigned to this ordered workstream.",
      "Identifier of a task assigned to this workstream.",
    ),
  },
  { additionalProperties: false },
);

export const strictExecutionPlanSchema = Type.Object(
  {
    version: Type.Literal(1, {
      description: "Execution-plan format version; must be 1.",
    }),
    tasks: Type.Array(strictExecutionTaskSchema, {
      minItems: 1,
      description: "Every unchecked source task with its executable contract.",
    }),
    workstreams: Type.Array(strictWorkstreamSchema, {
      minItems: 1,
      description:
        "Ordered task groupings for coherent implementation and review.",
    }),
  },
  { additionalProperties: false },
);

const changedOutcome = Type.Literal("changed", {
  description: "Use when this invocation left a committed candidate change.",
});
const alreadySatisfiedOutcome = Type.Literal("already_satisfied", {
  description:
    "Use only when every assigned contract was already satisfied and this invocation made no commit.",
});
const unchangedOutcome = Type.Literal("unchanged", {
  description:
    "Use when no candidate-changing revision could be produced after the assigned attempt.",
});
const summary = (
  description = "Concise account of the completed work and outcome.",
) => text(description);
const evidence = (
  description = "Concrete repository-state evidence supporting the reported outcome.",
) => text(description);
const verification = () =>
  textList(
    "Checks, analysis, or direct inspection performed and their outcomes.",
    "One concise verification statement naming what was checked and the outcome.",
  );
const uncertainty = () =>
  Type.Optional(
    text("Material remaining uncertainty; omit when none remains."),
  );

export const workstreamImplementerResultSchema = Type.Union([
  Type.Object(
    {
      outcome: changedOutcome,
      summary: summary(),
      verification: verification(),
      uncertainty: uncertainty(),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      outcome: alreadySatisfiedOutcome,
      evidence: evidence(
        "Concrete repository-state evidence that every assigned contract was already satisfied.",
      ),
      summary: summary(),
      verification: verification(),
      uncertainty: uncertainty(),
    },
    { additionalProperties: false },
  ),
]);

export const directReviewFindingSchema = Type.Object(
  {
    summary: summary("Concise statement of one direct material finding."),
    evidence: evidence("Current evidence demonstrating the finding."),
    requiredChange: text(
      "Minimum observable correction required to resolve the finding.",
    ),
    acceptanceCriteria: textList(
      "Concrete conditions the correction must satisfy.",
      "One observable condition for resolving the finding.",
    ),
  },
  { additionalProperties: false },
);

const publicationCommitSubject = () =>
  commitMessageString(
    "Conventional Commit subject for the complete reviewed workstream or repair, not an internal checkpoint or correction commit.",
  );

export const initialWorkstreamReviewSchema = Type.Object(
  {
    findings: Type.Array(directReviewFindingSchema, {
      description:
        "Complete set of direct material findings for the reviewed workstream.",
    }),
    publicationCommitSubject: publicationCommitSubject(),
  },
  { additionalProperties: false },
);
export const repositoryStateReviewSchema = Type.Object(
  {
    findings: Type.Array(directReviewFindingSchema, {
      description: "Complete set of direct material repository-state findings.",
    }),
  },
  { additionalProperties: false },
);
export const initialOverallReviewSchema = Type.Object(
  {
    findings: Type.Array(directReviewFindingSchema, {
      description:
        "Complete set of direct material findings for the whole run.",
    }),
    handoffDraft: handoffDraft(),
  },
  { additionalProperties: false },
);

const findingAssessmentSchema = Type.Union([
  Type.Object(
    {
      id: text(
        "Identifier of the supplied outstanding finding being assessed.",
      ),
      status: Type.Literal("resolved", {
        description:
          "Use when current evidence shows the supplied finding is resolved.",
      }),
      evidence: evidence(
        "Current evidence that the supplied finding is resolved.",
      ),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      id: text(
        "Identifier of the supplied outstanding finding being assessed.",
      ),
      status: Type.Literal("unresolved", {
        description: "Use when the supplied finding remains unresolved.",
      }),
      evidence: evidence(
        "Current evidence that the supplied finding remains unresolved.",
      ),
      summary: summary("Concise statement of the remaining material problem."),
      requiredChange: text("Minimum observable correction still required."),
      acceptanceCriteria: textList(
        "Concrete conditions a later correction must satisfy.",
        "One observable condition for resolving the remaining problem.",
      ),
    },
    { additionalProperties: false },
  ),
]);
const regressionFindingSchema = Type.Object(
  {
    summary: summary(
      "Concise statement of one correction-caused material regression.",
    ),
    evidence: evidence(
      "Current evidence that the canonical correction range caused the regression.",
    ),
    requiredChange: text(
      "Minimum observable correction required for the regression.",
    ),
    acceptanceCriteria: textList(
      "Concrete conditions the regression correction must satisfy.",
      "One observable condition for resolving the regression.",
    ),
    changedPaths: textList(
      "Paths in the canonical correction range that caused the regression.",
      "One changed path causally involved in the regression.",
    ),
  },
  { additionalProperties: false },
);

const anchoredReviewProperties = {
  assessments: Type.Array(findingAssessmentSchema, {
    description:
      "One resolved or unresolved assessment for each supplied outstanding finding.",
  }),
  regressions: Type.Array(regressionFindingSchema, {
    description:
      "New material regressions directly caused by the latest changed correction.",
  }),
  observations: Type.Optional(
    Type.Array(
      Type.Object(
        {
          summary: summary("Concise non-causal concern that is not a finding."),
          evidence: evidence("Current evidence supporting the observation."),
        },
        { additionalProperties: false },
      ),
      {
        description:
          "Optional non-causal observations that require no correction.",
      },
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
export const initialAnchoredOverallReviewSchema = Type.Object(
  {
    ...anchoredReviewProperties,
    publicationCommitSubject: publicationCommitSubject(),
    handoffDraft: handoffDraft(),
  },
  { additionalProperties: false },
);
export const anchoredOverallReviewSchema = Type.Object(
  { ...anchoredReviewProperties, handoffDraft: handoffDraft() },
  { additionalProperties: false },
);
export const anchoredReviewSchema = anchoredWorkstreamReviewSchema;

const repairCompletion = (summaryDescription: string) =>
  Type.Object(
    {
      summary: summary(summaryDescription),
      verification: verification(),
      uncertainty: uncertainty(),
    },
    { additionalProperties: false },
  );

export const overallReworkSchema = repairCompletion(
  "Concise account of corrections made for the whole-plan findings.",
);
export const reconciliationCompletionSchema = repairCompletion(
  "Concise semantic account of the reconciled candidate.",
);

export const revisionCompletionSchema = Type.Union([
  Type.Object(
    {
      outcome: changedOutcome,
      summary: summary(
        "Concise account of the committed candidate-changing revision.",
      ),
      verification: verification(),
      uncertainty: uncertainty(),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      outcome: unchangedOutcome,
      summary: summary(
        "Concise account of why no candidate-changing revision was produced.",
      ),
      evidence: evidence(
        "Concrete evidence of the attempted revision and its remaining limitation.",
      ),
      verification: verification(),
      uncertainty: uncertainty(),
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
export type InitialAnchoredOverallReviewCompletion = Static<
  typeof initialAnchoredOverallReviewSchema
>;
export type AnchoredOverallReviewCompletion = Static<
  typeof anchoredOverallReviewSchema
>;
export type OverallReworkCompletion = Static<typeof overallReworkSchema>;
export type ReconciliationCompletion = Static<
  typeof reconciliationCompletionSchema
>;
export type RevisionCompletion = Static<typeof revisionCompletionSchema>;
