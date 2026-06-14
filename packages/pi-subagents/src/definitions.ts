export type AgentDefinitionVisibility = "public" | "internal";

export type AgentDefinition = {
  type: string;
  title: string;
  description: string;
  visibility: AgentDefinitionVisibility;
  prompt?: string;
  builtin?: boolean;
};

const normalizeDefinition = (definition: AgentDefinition): AgentDefinition => ({
  ...definition,
});

const equivalentDefinitions = (
  left: AgentDefinition,
  right: AgentDefinition,
): boolean =>
  left.type === right.type &&
  left.title === right.title &&
  left.description === right.description &&
  left.visibility === right.visibility &&
  left.prompt === right.prompt &&
  left.builtin === right.builtin;

export class AgentDefinitionRegistry {
  #definitions = new Map<string, AgentDefinition>();

  register(definition: AgentDefinition): AgentDefinition {
    const normalized = normalizeDefinition(definition);
    const existing = this.#definitions.get(normalized.type);
    if (!existing) {
      this.#definitions.set(normalized.type, normalized);
      return normalized;
    }
    if (!equivalentDefinitions(existing, normalized)) {
      throw new Error(
        `Conflicting subagent definition registration for ${normalized.type}`,
      );
    }
    return existing;
  }

  get(type: string): AgentDefinition | undefined {
    return this.#definitions.get(type);
  }

  list(): AgentDefinition[] {
    return [...this.#definitions.values()];
  }

  listPublic(): AgentDefinition[] {
    return this.list().filter(
      (definition) => definition.visibility === "public",
    );
  }

  listInternal(): AgentDefinition[] {
    return this.list().filter(
      (definition) => definition.visibility === "internal",
    );
  }
}

export const PUBLIC_BUILTIN_TYPES = ["General", "Explore", "Review"] as const;

export type PublicBuiltinType = (typeof PUBLIC_BUILTIN_TYPES)[number];

export const PUBLIC_BUILTIN_DEFINITIONS: AgentDefinition[] = [
  {
    type: "General",
    title: "General",
    description:
      "General-purpose subagent for well-scoped implementation or research tasks.",
    visibility: "public",
    builtin: true,
  },
  {
    type: "Explore",
    title: "Explore",
    description:
      "Exploration subagent for codebase discovery and usage tracing.",
    visibility: "public",
    builtin: true,
  },
  {
    type: "Review",
    title: "Review",
    description: "Review subagent for independent second-pass code review.",
    visibility: "public",
    builtin: true,
  },
];

export function createAgentDefinitionRegistry(): AgentDefinitionRegistry {
  const registry = new AgentDefinitionRegistry();
  for (const definition of PUBLIC_BUILTIN_DEFINITIONS) {
    registry.register(definition);
  }
  return registry;
}
