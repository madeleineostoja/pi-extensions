export type ThinkingLevel =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh";

export type AgentDefinition = {
  name: string;
  public: boolean;
  displayName: string;
  description: string;
  promptMode: "append" | "replace";
  systemPrompt: string;
  tools: "all" | string[];
  includeExploreTool: boolean;
  defaultThinking?: ThinkingLevel;
  resolveModel?: "public-config" | "caller-only";
};

export const GENERAL_DEFINITION: AgentDefinition = {
  name: "General",
  public: true,
  displayName: "General",
  description:
    "General-purpose subagent for complex research, codebase investigation, and implementation assistance. Use it when work benefits from a separate context window or parallel execution. Do not use it for simple single-file reads/searches or when a specialized Explore or Review agent fits better.",
  promptMode: "append",
  systemPrompt:
    "You are a general-purpose coding assistant. You have access to the normal coding tools. Do not spawn additional agents or use agent management tools. If you need to explore the codebase, use the explore tool when available.",
  tools: "all",
  includeExploreTool: true,
  defaultThinking: "high",
  resolveModel: "public-config",
};

export const EXPLORE_DEFINITION: AgentDefinition = {
  name: "Explore",
  public: true,
  displayName: "Explore",
  description:
    "Read-only exploration agent for locating things in a codebase. Use it to find files by pattern, locate definitions and references, trace where behavior lives, map related files, or answer 'where is X / what references Y / how is Z wired.' Specify breadth: 'quick' for a single targeted lookup, 'medium' for normal discovery, 'very thorough' for broad searches across multiple locations and naming conventions. NOT for code review, design-doc auditing, cross-file consistency checks, or conclusions requiring full-file analysis — it reads excerpts, not whole files, and will miss content past its read window.",
  promptMode: "append",
  systemPrompt: `You are a read-only exploration agent. Your job is to locate things in a codebase.

Constraints:
- Read-only mode. Do not create, modify, delete, or move files, including temp files.
- No redirect or heredoc writes.
- Bash only for read-only operations.
- Prefer the find tool for file pattern matching, the grep tool for content search, and the read tool for reading files.
- Make independent read-only tool calls in parallel when possible.
- Adapt your search approach to the requested breadth.
- Use absolute file paths. Do not use emojis. Be thorough and precise.
`,
  tools: ["read", "bash", "grep", "find", "ls"],
  includeExploreTool: false,
  defaultThinking: "medium",
  resolveModel: "public-config",
};

export const REVIEW_DEFINITION: AgentDefinition = {
  name: "Review",
  public: true,
  displayName: "Review",
  description:
    "Independent read-only reviewer for concrete code artifacts: PRs, commits, patches, staged/unstaged diffs, or named files. Inspects correctness, safety, verification, scope, and maintainability. Do not use for routine small edits, open-ended discovery, locating code, debugging, or broad audits without a concrete artifact to review.",
  promptMode: "append",
  systemPrompt: `You are an independent read-only code reviewer. You inspect concrete changes and identify material correctness, safety, verification, scope, and maintainability issues.

Constraints:
- Return the caller's requested output format exactly when one is specified.
- Block only for concrete material issues: incorrect behavior, missing stated requirements, regressions, unsafe/security-sensitive behavior, broken or insufficient verification, risky scope expansion, and maintainability problems likely to cause real trouble.
- Do not block for style preferences, trivial nits, speculative improvements, unrelated existing problems, or nice-to-have refactors.
- You may use the explore tool for targeted read-only context checks.
`,
  tools: ["read", "bash", "grep", "find", "ls"],
  includeExploreTool: true,
  defaultThinking: "high",
  resolveModel: "public-config",
};

export const PUBLIC_BUILTINS = [
  GENERAL_DEFINITION,
  EXPLORE_DEFINITION,
  REVIEW_DEFINITION,
];
