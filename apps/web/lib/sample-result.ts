/** Build a JSON value that satisfies a small result schema so the sandbox can release escrow. */
export function sampleResult(schema: unknown): unknown {
  return sampleValue(schema, 0);
}

function sampleValue(schema: unknown, depth: number): unknown {
  if (depth > 6 || !isRecord(schema)) return "sandbox";
  const type = schema.type;
  if (type === "object" || (type === undefined && isRecord(schema.properties))) {
    const properties = isRecord(schema.properties) ? schema.properties : {};
    const required = Array.isArray(schema.required)
      ? schema.required.filter((key): key is string => typeof key === "string")
      : [];
    const keys = required.length > 0 ? required : Object.keys(properties);
    const result: Record<string, unknown> = {};
    for (const key of keys) result[key] = sampleValue(properties[key], depth + 1);
    return result;
  }
  if (type === "array") return [];
  if (type === "integer" || type === "number") return 1;
  if (type === "boolean") return true;
  if (type === "string") {
    if (Array.isArray(schema.enum)) {
      const first = schema.enum.find((entry) => typeof entry === "string");
      if (typeof first === "string") return first;
    }
    return "sandbox";
  }
  return "sandbox";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
