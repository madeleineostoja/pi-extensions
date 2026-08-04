type Schema = {
  description?: unknown;
  properties?: Record<string, Schema>;
  items?: Schema | Schema[];
  anyOf?: Schema[];
  oneOf?: Schema[];
  allOf?: Schema[];
};

function hasStructuralChildren(schema: Schema): boolean {
  return Boolean(
    Object.keys(schema.properties ?? {}).length ||
    schema.items ||
    schema.anyOf?.length ||
    schema.oneOf?.length ||
    schema.allOf?.length,
  );
}

function hasDescription(schema: Schema): boolean {
  return (
    typeof schema.description === "string" &&
    schema.description.trim().length > 0
  );
}

function childSchemas(schema: Schema): Array<[string, Schema]> {
  const children: Array<[string, Schema]> = [];
  if (schema.items) {
    for (const [index, item] of (Array.isArray(schema.items)
      ? schema.items
      : [schema.items]
    ).entries()) {
      children.push([
        `items${Array.isArray(schema.items) ? `[${index}]` : ""}`,
        item,
      ]);
    }
  }
  for (const key of ["anyOf", "oneOf", "allOf"] as const) {
    for (const [index, branch] of (schema[key] ?? []).entries()) {
      children.push([`${key}[${index}]`, branch]);
    }
  }
  return children;
}

/** Returns model-selectable property paths that lack useful documentation. */
export function undocumentedSchemaProperties(
  schema: unknown,
  path = "$",
): string[] {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return [];
  }
  const value = schema as Schema;
  const missing: string[] = [];
  for (const [name, property] of Object.entries(value.properties ?? {})) {
    const propertyPath = `${path}.properties.${name}`;
    if (!hasDescription(property)) {
      missing.push(propertyPath);
    }
    missing.push(...undocumentedSchemaProperties(property, propertyPath));
  }
  for (const [name, child] of childSchemas(value)) {
    const childPath = `${path}.${name}`;
    if (
      name.startsWith("items") &&
      !hasStructuralChildren(child) &&
      !hasDescription(child)
    ) {
      missing.push(childPath);
    }
    missing.push(...undocumentedSchemaProperties(child, childPath));
  }
  return missing;
}
