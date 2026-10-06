/** JSON Schema helpers for imported tools and operations. */

type Json = Record<string, unknown>;

const FIELD_RE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const DROP_KEYS = new Set(["xml", "externalDocs", "discriminator", "$schema", "$id", "$comment", "readOnly", "writeOnly", "deprecated"]);
const MAX_INPUT_CHARS = 15_000;

/** Inline local `$ref`s (#/components/…, #/definitions/…) with a depth cap and cycle guard. */
export function resolveLocalRefs(schema: unknown, doc: unknown, depth = 0, seen: ReadonlySet<string> = new Set()): Json {
  if (!isRecord(schema)) return {};
  if (depth > 10) return { type: "object" };
  if (typeof schema.$ref === "string") {
    const ref = schema.$ref;
    if (!ref.startsWith("#/") || seen.has(ref)) return { type: "object" };
    const target = pointer(doc, ref);
    if (!isRecord(target)) return { type: "object" };
    return resolveLocalRefs(target, doc, depth + 1, new Set([...seen, ref]));
  }
  const out: Json = {};
  for (const [key, value] of Object.entries(schema)) {
    if (DROP_KEYS.has(key) || key.startsWith("x-")) continue;
    if (key === "properties" && isRecord(value)) {
      out.properties = Object.fromEntries(Object.entries(value).map(([name, child]) => [name, resolveLocalRefs(child, doc, depth + 1, seen)]));
    } else if ((key === "items" || key === "additionalProperties" || key === "not") && isRecord(value)) {
      out[key] = resolveLocalRefs(value, doc, depth + 1, seen);
    } else if ((key === "allOf" || key === "anyOf" || key === "oneOf") && Array.isArray(value)) {
      out[key] = value.slice(0, 8).map((child) => resolveLocalRefs(child, doc, depth + 1, seen));
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** Input schema for the registry: refs inlined, size capped, always an object schema. */
export function toInputSchema(schema: unknown, doc: unknown = null): Json {
  const resolved = resolveLocalRefs(schema, doc);
  const typed: Json = resolved.type === undefined && isRecord(resolved.properties) ? { type: "object", ...resolved } : resolved;
  if (typed.type !== "object") return { type: "object", properties: {} };
  return JSON.stringify(typed).length > MAX_INPUT_CHARS ? { type: "object", properties: shallowProperties(typed) } : typed;
}

function shallowProperties(schema: Json): Json {
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const out: Json = {};
  for (const [name, child] of Object.entries(properties).slice(0, 40)) {
    const type = isRecord(child) ? primaryType(child) : null;
    out[name] = type ? { type, ...(isRecord(child) && typeof child.description === "string" ? { description: child.description.slice(0, 200) } : {}) } : {};
  }
  return out;
}

/**
 * Convert a resolved JSON Schema to Roster's escrow subset (type, properties,
 * items; no required below the top level). Deliberately lenient: real APIs
 * often omit documented fields, and a strict check would refund honest sellers.
 * Returns null when the value cannot be typed.
 */
export function toEscrowNode(schema: unknown, depth = 0, maxDepth = 3): Json | null {
  if (!isRecord(schema)) return null;
  const merged = mergeAllOf(schema);
  const type = primaryType(merged);
  if (!type) return null;
  if (type === "object") {
    if (depth >= maxDepth || !isRecord(merged.properties)) return { type: "object" };
    const properties: Json = {};
    for (const [name, child] of Object.entries(merged.properties)) {
      if (Object.keys(properties).length >= 40) break;
      if (!FIELD_RE.test(name)) continue;
      const node = toEscrowNode(child, depth + 1, maxDepth);
      if (node) properties[name] = node;
    }
    return Object.keys(properties).length > 0 ? { type: "object", properties } : { type: "object" };
  }
  if (type === "array") {
    const items = depth >= maxDepth ? primitiveOnly(merged.items) : toEscrowNode(merged.items, depth + 1, maxDepth);
    return items ? { type: "array", items } : null;
  }
  return { type };
}

function primitiveOnly(schema: unknown): Json | null {
  if (!isRecord(schema)) return null;
  const type = primaryType(mergeAllOf(schema));
  if (!type) return null;
  return type === "array" ? null : { type };
}

/** Wrap an OpenAPI response schema: the proxy delivers `{ status, data }`. */
export function openApiOutputSchema(responseSchema: unknown): Json {
  const data = toEscrowNode(responseSchema, 1, 2);
  if (!data) return { type: "object", required: ["status"], properties: { status: { type: "integer" } } };
  return { type: "object", required: ["status", "data"], properties: { status: { type: "integer" }, data } };
}

/** MCP tools deliver `{ content, structuredContent? }`. */
export function mcpOutputSchema(outputSchema: unknown): Json {
  const structured = isRecord(outputSchema) ? toEscrowNode(outputSchema, 1, 2) : null;
  if (structured && structured.type === "object") {
    return { type: "object", required: ["structuredContent"], properties: { structuredContent: structured } };
  }
  return {
    type: "object",
    required: ["content"],
    properties: { content: { type: "array", items: { type: "object" }, minItems: 1 } },
  };
}

function mergeAllOf(schema: Json): Json {
  if (!Array.isArray(schema.allOf)) {
    const variants = Array.isArray(schema.oneOf) ? schema.oneOf : Array.isArray(schema.anyOf) ? schema.anyOf : null;
    // A single non-null variant (common for nullable refs) stands in for the union.
    if (variants && schema.type === undefined) {
      const real = variants.filter((variant) => isRecord(variant) && variant.type !== "null");
      if (real.length === 1 && isRecord(real[0])) return mergeAllOf(real[0]);
    }
    return schema;
  }
  const properties: Json = isRecord(schema.properties) ? { ...schema.properties } : {};
  let type: unknown = schema.type;
  for (const part of schema.allOf) {
    if (!isRecord(part)) continue;
    const inner = mergeAllOf(part);
    if (isRecord(inner.properties)) Object.assign(properties, inner.properties);
    type ??= inner.type ?? (isRecord(inner.properties) ? "object" : undefined);
  }
  return { ...schema, type: type ?? "object", properties };
}

function primaryType(schema: Json): string | null {
  const raw = schema.type;
  const types = Array.isArray(raw) ? raw.filter((value): value is string => typeof value === "string" && value !== "null") : typeof raw === "string" ? [raw] : [];
  if (Array.isArray(raw) && types.length !== 1) return null;
  const type = types[0] ?? (isRecord(schema.properties) ? "object" : schema.items !== undefined ? "array" : null);
  return type && ["object", "array", "string", "number", "integer", "boolean"].includes(type) ? type : null;
}

function pointer(doc: unknown, ref: string): unknown {
  let current: unknown = doc;
  for (const raw of ref.slice(2).split("/")) {
    const key = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return current;
}

export function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
