import { Type, type Static, type TSchema } from "typebox";

const nonEmptyString = () => Type.String({ minLength: 1 });
const stringArray = () => Type.Array(nonEmptyString());
const verificationStepSchema = Type.Object({
  command: nonEmptyString(),
  result: nonEmptyString(),
  rationale: nonEmptyString(),
});
const findingReworkCompletionSchema = Type.Object({
  id: nonEmptyString(),
  status: Type.Union([
    Type.Literal("addressed"),
    Type.Literal("not_addressed"),
  ]),
  evidence: nonEmptyString(),
  changedPaths: Type.Array(nonEmptyString()),
  verification: Type.Array(verificationStepSchema, { minItems: 1 }),
});
const papercutCandidatesSchema = Type.Optional(
  Type.Array(Type.Unknown(), {
    description:
      "Optional papercut proposals. Each candidate must provide key, title, trigger, impact, currentGap, proposedResolution, and suggestedDestination (agents, skill, test, lint, tooling, docs, or code). Malformed candidates are discarded without failing the result.",
  }),
);
const withPapercuts = <T extends Record<string, TSchema>>(schema: T) =>
  Type.Object({ ...schema, papercuts: papercutCandidatesSchema });
const closedWithPapercuts = <T extends Record<string, TSchema>>(schema: T) =>
  Type.Object(
    { ...schema, papercuts: papercutCandidatesSchema },
    { additionalProperties: false },
  );

const sourceMaterialModeSchema = Type.Union([
  Type.Object({ kind: Type.Literal("full-file") }),
  Type.Object({
    kind: Type.Literal("line-range"),
    startLine: Type.Integer({ minimum: 1 }),
    endLine: Type.Integer({ minimum: 1 }),
  }),
]);

export const sourceMaterialReferenceSchema = Type.Object({
  origin: Type.Union([
    Type.Literal("task-anchor"),
    Type.Literal("task-link"),
    Type.Literal("planner"),
    Type.Literal("needs-material"),
    Type.Literal("fallback"),
  ]),
  path: nonEmptyString(),
  mode: sourceMaterialModeSchema,
  reason: nonEmptyString(),
});

export const needsMaterialRequestSchema = Type.Object({
  pathHint: nonEmptyString(),
  relativeTo: Type.Optional(nonEmptyString()),
  reason: nonEmptyString(),
});

export const needsMaterialResponseSchema = Type.Object({
  kind: Type.Literal("needs_material"),
  requests: Type.Array(needsMaterialRequestSchema, { minItems: 1 }),
});

const compiledContractSchema = Type.Object({
  objective: nonEmptyString(),
  inScope: Type.Array(nonEmptyString(), { minItems: 1 }),
  acceptanceCriteria: Type.Array(nonEmptyString(), { minItems: 1 }),
  outOfScope: Type.Array(nonEmptyString(), { minItems: 1 }),
  supportingDesignContext: Type.Optional(nonEmptyString()),
  implementationNotes: Type.Optional(nonEmptyString()),
  verificationGuidance: Type.Optional(nonEmptyString()),
});

const executionTaskSchema = Type.Object({
  id: nonEmptyString(),
  planIndex: Type.Optional(Type.Integer({ minimum: 1 })),
  title: nonEmptyString(),
  taskHash: Type.Optional(nonEmptyString()),
  status: Type.Union([Type.Literal("todo"), Type.Literal("done")]),
  dependsOn: stringArray(),
  affectedAreas: stringArray(),
  conflictHints: stringArray(),
  sourceReferences: stringArray(),
  sourceRefs: Type.Optional(
    Type.Array(
      Type.Object({
        path: nonEmptyString(),
        quote: Type.Optional(nonEmptyString()),
      }),
    ),
  ),
  sourceMaterialRefs: Type.Optional(Type.Array(sourceMaterialReferenceSchema)),
  validationCommands: Type.Optional(stringArray()),
  reasons: Type.Optional(stringArray()),
  evidencePaths: Type.Optional(stringArray()),
  sourceCheckbox: Type.Optional(
    Type.Object({
      path: nonEmptyString(),
      lineNumber: Type.Integer({ minimum: 1 }),
      lineText: nonEmptyString(),
    }),
  ),
  compiledContract: compiledContractSchema,
});

export const executionManifestSchema = Type.Object({
  version: Type.Literal(1),
  tasks: Type.Array(executionTaskSchema, { minItems: 1 }),
  sourcePlanHash: Type.Optional(nonEmptyString()),
  sourcePlanPath: Type.Optional(nonEmptyString()),
  sourceCorpusHash: Type.Optional(nonEmptyString()),
  plannerReason: Type.Optional(nonEmptyString()),
  plannerConfidence: Type.Optional(
    Type.Union([
      Type.Literal("high"),
      Type.Literal("medium"),
      Type.Literal("low"),
    ]),
  ),
  maxConcurrency: Type.Optional(Type.Integer({ minimum: 1 })),
});

const strictProvenanceSchema = Type.Object(
  { path: nonEmptyString(), quote: nonEmptyString() },
  { additionalProperties: false },
);
const strictCompiledContractSchema = Type.Object(
  {
    objective: nonEmptyString(),
    inScope: Type.Array(nonEmptyString(), { minItems: 1 }),
    acceptanceCriteria: Type.Array(nonEmptyString(), { minItems: 1 }),
    outOfScope: Type.Array(nonEmptyString(), { minItems: 1 }),
    supportingDesignContext: Type.Optional(nonEmptyString()),
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
    dependsOn: stringArray(),
    provenance: Type.Array(strictProvenanceSchema, { minItems: 1 }),
    compiledContract: strictCompiledContractSchema,
  },
  { additionalProperties: false },
);
const strictWorkstreamSchema = Type.Object(
  {
    id: Type.String({ pattern: "^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$" }),
    taskIds: Type.Array(nonEmptyString(), { minItems: 1 }),
    dependsOn: stringArray(),
    rationale: nonEmptyString(),
    risk: Type.Union([Type.Literal("normal"), Type.Literal("isolated")]),
  },
  { additionalProperties: false },
);

export const strictExecutionPlanSchema = Type.Object(
  {
    version: Type.Literal(1),
    plannerReason: nonEmptyString(),
    plannerConfidence: Type.Union([
      Type.Literal("high"),
      Type.Literal("medium"),
      Type.Literal("low"),
    ]),
    tasks: Type.Array(strictExecutionTaskSchema, { minItems: 1 }),
    workstreams: Type.Array(strictWorkstreamSchema, { minItems: 1 }),
  },
  { additionalProperties: false },
);

export const sourceMaterialRepairSchema = Type.Union([
  Type.Object({
    taskId: nonEmptyString(),
    sourceMaterialRefs: Type.Array(sourceMaterialReferenceSchema),
    reason: nonEmptyString(),
  }),
  needsMaterialResponseSchema,
]);

export const implementerResultSchema = Type.Union([
  withPapercuts({
    outcome: Type.Literal("changed"),
    summary: nonEmptyString(),
    verification: Type.Array(verificationStepSchema, { minItems: 1 }),
    findingCompletions: Type.Optional(
      Type.Array(findingReworkCompletionSchema),
    ),
    commitMessage: nonEmptyString(),
  }),
  withPapercuts({
    outcome: Type.Literal("already_satisfied"),
    summary: nonEmptyString(),
    verification: Type.Array(verificationStepSchema, { minItems: 1 }),
    findingCompletions: Type.Optional(
      Type.Array(findingReworkCompletionSchema),
    ),
    commitMessage: Type.Optional(nonEmptyString()),
  }),
]);

export const reviewFindingDraftSchema = Type.Object({
  summary: nonEmptyString(),
  evidence: nonEmptyString(),
  requiredChange: nonEmptyString(),
  acceptanceCriteria: Type.Array(nonEmptyString(), { minItems: 1 }),
});

const reviewFindingProposalBasisSchema = Type.Union([
  Type.Object({
    kind: Type.Literal("requirement"),
    requirementIds: Type.Array(nonEmptyString(), { minItems: 1 }),
  }),
  Type.Object({
    kind: Type.Literal("candidate_regression"),
    changedPaths: Type.Array(nonEmptyString(), { minItems: 1 }),
    causalEvidence: nonEmptyString(),
  }),
  Type.Object({
    kind: Type.Literal("correctness_invariant"),
    invariant: nonEmptyString(),
  }),
]);

export const reviewFindingProposalSchema = Type.Intersect([
  reviewFindingDraftSchema,
  Type.Object({
    proposalId: Type.Optional(nonEmptyString()),
    basis: reviewFindingProposalBasisSchema,
  }),
]);

const findingAdmissionDispositionSchema = Type.Object({
  proposalId: nonEmptyString(),
  disposition: Type.Union([
    Type.Literal("admit"),
    Type.Literal("defer"),
    Type.Literal("demote"),
    Type.Literal("reject"),
  ]),
  certainty: Type.Union([Type.Literal("certain"), Type.Literal("uncertain")]),
  rationale: nonEmptyString(),
});

export const findingAdmissionBatchSchema = closedWithPapercuts({
  proposalBatchId: nonEmptyString(),
  dispositions: Type.Array(findingAdmissionDispositionSchema),
});

export const regressionFindingDraftSchema = Type.Intersect([
  reviewFindingDraftSchema,
  Type.Object({
    changedPaths: Type.Array(nonEmptyString(), { minItems: 1 }),
    causalEvidence: nonEmptyString(),
  }),
]);

export const reviewObservationSchema = Type.Object({
  summary: nonEmptyString(),
  evidence: nonEmptyString(),
});

export const findingAssessmentSchema = Type.Object({
  id: nonEmptyString(),
  status: Type.Union([Type.Literal("resolved"), Type.Literal("unresolved")]),
  evidence: nonEmptyString(),
});

export const deferredConcernAssessmentSchema = Type.Object({
  id: nonEmptyString(),
  status: Type.Union([
    Type.Literal("not_reproducible"),
    Type.Literal("covered_by_proposal"),
    Type.Literal("observed_non_blocking"),
  ]),
  proposalId: Type.Optional(nonEmptyString()),
  evidence: nonEmptyString(),
});

const initialReviewSchema = (allowRecommendationMarkdown: boolean) =>
  Type.Union([
    closedWithPapercuts({
      verdict: Type.Literal("approved"),
      ...(allowRecommendationMarkdown
        ? {
            deferredConcernAssessments: Type.Optional(
              Type.Array(deferredConcernAssessmentSchema),
            ),
          }
        : {}),
    }),
    closedWithPapercuts({
      verdict: Type.Literal("changes_requested"),
      findings: Type.Array(reviewFindingProposalSchema, { minItems: 1 }),
      ...(allowRecommendationMarkdown
        ? {
            recommendationMarkdown: Type.Optional(nonEmptyString()),
            deferredConcernAssessments: Type.Optional(
              Type.Array(deferredConcernAssessmentSchema),
            ),
          }
        : {}),
    }),
  ]);

export const initialTaskReviewSchema = Type.Union([
  closedWithPapercuts({ verdict: Type.Literal("approved") }),
  closedWithPapercuts({
    verdict: Type.Literal("changes_requested"),
    findings: Type.Array(reviewFindingProposalSchema, { minItems: 1 }),
  }),
]);
export const initialOverallReviewSchema = initialReviewSchema(true);
export const anchoredReviewSchema = withPapercuts({
  assessments: Type.Array(findingAssessmentSchema),
  regressions: Type.Array(regressionFindingDraftSchema),
  observations: Type.Optional(Type.Array(reviewObservationSchema)),
});

export const integrationInitialReviewSchema = initialReviewSchema(false);
export const integrationAnchoredReviewSchema = anchoredReviewSchema;

const selfHealBaseSchema = {
  repaired: Type.Boolean(),
  summary: Type.Optional(nonEmptyString()),
  commands: Type.Optional(stringArray()),
  filesChanged: Type.Optional(stringArray()),
  remainingBlocker: Type.Optional(Type.Union([nonEmptyString(), Type.Null()])),
};

export const integrationSelfHealSchema = Type.Union([
  withPapercuts({
    ...selfHealBaseSchema,
    retryIntegration: Type.Literal(false),
  }),
  withPapercuts({
    ...selfHealBaseSchema,
    retryIntegration: Type.Literal(true),
    retryMode: Type.Union([
      Type.Literal("continue_candidate"),
      Type.Literal("retry_cherry_pick"),
      Type.Literal("retry_validation"),
    ]),
  }),
]);

export const integrationRecoverySchema = withPapercuts({
  disposition: Type.Union([
    Type.Literal("retry_validation"),
    Type.Literal("candidate_rework"),
    Type.Literal("blocked"),
  ]),
  summary: nonEmptyString(),
  commands: Type.Optional(stringArray()),
  remainingBlocker: Type.Optional(Type.Union([nonEmptyString(), Type.Null()])),
});

export const schedulerSelfHealSchema = withPapercuts({
  ...selfHealBaseSchema,
  retryScheduler: Type.Boolean(),
});

export const overallReworkSchema = withPapercuts({
  summary: nonEmptyString(),
  verification: Type.Array(verificationStepSchema, { minItems: 1 }),
  findingCompletions: Type.Optional(Type.Array(findingReworkCompletionSchema)),
  commitMessage: Type.Optional(nonEmptyString()),
});

export type ExecutionManifestCompletion = Static<
  typeof executionManifestSchema
>;
export type SourceMaterialRepairCompletion = Static<
  typeof sourceMaterialRepairSchema
>;
export type NeedsMaterialCompletion = Static<
  typeof needsMaterialResponseSchema
>;
export type FindingReworkCompletion = Static<
  typeof findingReworkCompletionSchema
>;
export type ImplementerCompletion = Static<typeof implementerResultSchema>;
export type ReviewFindingDraft = Static<typeof reviewFindingDraftSchema>;
export type ReviewFindingProposal = Static<typeof reviewFindingProposalSchema>;
export type FindingAdmissionBatch = Static<typeof findingAdmissionBatchSchema>;
export type RegressionFindingDraft = Static<
  typeof regressionFindingDraftSchema
>;
export type ReviewObservation = Static<typeof reviewObservationSchema>;
export type FindingAssessment = Static<typeof findingAssessmentSchema>;
export type DeferredConcernAssessment = Static<
  typeof deferredConcernAssessmentSchema
>;
export type InitialTaskReviewCompletion = Static<
  typeof initialTaskReviewSchema
>;
export type InitialOverallReviewCompletion = Static<
  typeof initialOverallReviewSchema
>;
export type AnchoredReviewCompletion = Static<typeof anchoredReviewSchema>;
export type IntegrationInitialReviewCompletion = Static<
  typeof integrationInitialReviewSchema
>;
export type IntegrationAnchoredReviewCompletion = Static<
  typeof integrationAnchoredReviewSchema
>;
export type IntegrationSelfHealCompletion = Static<
  typeof integrationSelfHealSchema
>;
export type IntegrationRecoveryCompletion = Static<
  typeof integrationRecoverySchema
>;
export type SchedulerSelfHealCompletion = Static<
  typeof schedulerSelfHealSchema
>;
export type OverallReworkCompletion = Static<typeof overallReworkSchema>;
