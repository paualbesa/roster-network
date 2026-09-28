import type { ResultSchema, SchemaHookResult, SchemaNode, SchemaNodeType } from "./types.js";

const MAX_DEPTH = 6;
const MAX_PROPERTIES = 40;
const MAX_ERRORS = 20;
const NAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const NODE_TYPES = new Set<SchemaNodeType>(["object", "array", "string", "number", "integer", "boolean"]);
const KEYWORDS = new Set([
  "type",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "enum",
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "minItems",
  "maxItems",
]);

export class EscrowSchemaError extends Error {
  readonly errors: string[];

  constructor(errors: string[]) {
    super(errors[0] ?? "Invalid result schema.");
    this.name = "EscrowSchemaError";
    this.errors = errors;
  }
}

export function parseResultSchema(input: unknown): ResultSchema {
  const node = parseNode(input, "schema", 0);
  if (node.type !== "object") {
    throw new EscrowSchemaError(["schema.type must be object."]);
  }
  const schema: ResultSchema = { type: "object" };
  if (node.properties) schema.properties = node.properties;
  if (node.required) schema.required = node.required;
  if (node.additionalProperties !== undefined) schema.additionalProperties = node.additionalProperties;
  return schema;
}

export function validateResult(schema: ResultSchema, result: unknown): SchemaHookResult {
  const errors: string[] = [];
  checkNode(schema, result, "result", errors);
  if (errors.length === 0) return { ok: true, errors: [] };
  return { ok: false, errors };
}

function parseNode(input: unknown, path: string, depth: number): SchemaNode {
  if (!isRecord(input)) throw new EscrowSchemaError([`${path} must be a schema object.`]);
  if (depth > MAX_DEPTH) throw new EscrowSchemaError([`${path} exceeds the maximum schema depth.`]);
  for (const key of Object.keys(input)) {
    if (!KEYWORDS.has(key)) throw new EscrowSchemaError([`${path}: unknown keyword "${key}".`]);
  }
  const type = input.type;
  if (typeof type !== "string" || !isSchemaType(type)) {
    throw new EscrowSchemaError([`${path}.type must be object, array, string, number, integer, or boolean.`]);
  }
  const node: SchemaNode = { type };
  if (type === "object") parseObjectKeywords(input, node, path, depth);
  else rejectObjectKeywords(input, path);
  if (type === "array") parseArrayKeywords(input, node, path, depth);
  else rejectArrayKeywords(input, path);
  if (type === "string") parseStringKeywords(input, node, path);
  else rejectStringKeywords(input, path);
  if (type === "number" || type === "integer") parseNumberKeywords(input, node, path);
  else rejectNumberKeywords(input, path);
  if ("enum" in input) node.enum = parseEnum(input.enum, type, path);
  return node;
}

function parseObjectKeywords(input: Record<string, unknown>, node: SchemaNode, path: string, depth: number): void {
  if ("properties" in input) {
    if (!isRecord(input.properties)) throw new EscrowSchemaError([`${path}.properties must be an object.`]);
    const names = Object.keys(input.properties);
    if (names.length > MAX_PROPERTIES) {
      throw new EscrowSchemaError([`${path}.properties can include at most ${MAX_PROPERTIES.toString()} fields.`]);
    }
    const properties: Record<string, SchemaNode> = Object.create(null) as Record<string, SchemaNode>;
    for (const name of names) {
      if (!NAME_RE.test(name)) throw new EscrowSchemaError([`${path}.properties.${name} is not a valid field name.`]);
      properties[name] = parseNode(input.properties[name], `${path}.properties.${name}`, depth + 1);
    }
    node.properties = properties;
  }
  if ("required" in input) node.required = parseRequired(input.required, node.properties, path);
  if ("additionalProperties" in input) {
    if (typeof input.additionalProperties !== "boolean") {
      throw new EscrowSchemaError([`${path}.additionalProperties must be a boolean.`]);
    }
    node.additionalProperties = input.additionalProperties;
  }
}

function parseArrayKeywords(input: Record<string, unknown>, node: SchemaNode, path: string, depth: number): void {
  if (!("items" in input)) throw new EscrowSchemaError([`${path}.items is required when type is array.`]);
  node.items = parseNode(input.items, `${path}.items`, depth + 1);
  if ("minItems" in input) node.minItems = parseCount(input.minItems, `${path}.minItems`);
  if ("maxItems" in input) node.maxItems = parseCount(input.maxItems, `${path}.maxItems`);
  if (node.minItems !== undefined && node.maxItems !== undefined && node.minItems > node.maxItems) {
    throw new EscrowSchemaError([`${path}.minItems cannot exceed maxItems.`]);
  }
}

function parseStringKeywords(input: Record<string, unknown>, node: SchemaNode, path: string): void {
  if ("minLength" in input) node.minLength = parseCount(input.minLength, `${path}.minLength`);
  if ("maxLength" in input) node.maxLength = parseCount(input.maxLength, `${path}.maxLength`);
  if (node.minLength !== undefined && node.maxLength !== undefined && node.minLength > node.maxLength) {
    throw new EscrowSchemaError([`${path}.minLength cannot exceed maxLength.`]);
  }
}

function parseNumberKeywords(input: Record<string, unknown>, node: SchemaNode, path: string): void {
  if ("minimum" in input) node.minimum = parseBound(input.minimum, `${path}.minimum`);
  if ("maximum" in input) node.maximum = parseBound(input.maximum, `${path}.maximum`);
  if (node.minimum !== undefined && node.maximum !== undefined && node.minimum > node.maximum) {
    throw new EscrowSchemaError([`${path}.minimum cannot exceed maximum.`]);
  }
}

function rejectObjectKeywords(input: Record<string, unknown>, path: string): void {
  for (const key of ["properties", "required", "additionalProperties"]) {
    if (key in input) throw new EscrowSchemaError([`${path}.${key} is only valid when type is object.`]);
  }
}

function rejectArrayKeywords(input: Record<string, unknown>, path: string): void {
  for (const key of ["items", "minItems", "maxItems"]) {
    if (key in input) throw new EscrowSchemaError([`${path}.${key} is only valid when type is array.`]);
  }
}

function rejectStringKeywords(input: Record<string, unknown>, path: string): void {
  for (const key of ["minLength", "maxLength"]) {
    if (key in input) throw new EscrowSchemaError([`${path}.${key} is only valid when type is string.`]);
  }
}

function rejectNumberKeywords(input: Record<string, unknown>, path: string): void {
  for (const key of ["minimum", "maximum"]) {
    if (key in input) throw new EscrowSchemaError([`${path}.${key} is only valid when type is number or integer.`]);
  }
}

function parseRequired(value: unknown, properties: Record<string, SchemaNode> | undefined, path: string): string[] {
  if (!Array.isArray(value)) throw new EscrowSchemaError([`${path}.required must be an array of field names.`]);
  if (value.length > MAX_PROPERTIES) {
    throw new EscrowSchemaError([`${path}.required can include at most ${MAX_PROPERTIES.toString()} fields.`]);
  }
  const required: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || !NAME_RE.test(entry)) {
      throw new EscrowSchemaError([`${path}.required entries must be field names.`]);
    }
    if (properties && !(entry in properties)) {
      throw new EscrowSchemaError([`${path}.required field "${entry}" is missing from properties.`]);
    }
    if (!required.includes(entry)) required.push(entry);
  }
  return required;
}

function parseEnum(value: unknown, type: SchemaNodeType, path: string): (string | number | boolean)[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 20) {
    throw new EscrowSchemaError([`${path}.enum must be a non-empty array of at most 20 values.`]);
  }
  const values: (string | number | boolean)[] = [];
  for (const entry of value) {
    if (!enumMatchesType(entry, type)) {
      throw new EscrowSchemaError([`${path}.enum contains a value that is not a ${type}.`]);
    }
    values.push(entry);
  }
  return values;
}

function enumMatchesType(value: unknown, type: SchemaNodeType): value is string | number | boolean {
  if (type === "string") return typeof value === "string";
  if (type === "boolean") return typeof value === "boolean";
  if (type === "integer") return typeof value === "number" && Number.isInteger(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  return false;
}

function parseCount(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new EscrowSchemaError([`${path} must be a non-negative integer.`]);
  }
  return value;
}

function parseBound(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new EscrowSchemaError([`${path} must be a finite number.`]);
  }
  return value;
}

function checkNode(schema: SchemaNode, value: unknown, path: string, errors: string[]): void {
  if (errors.length >= MAX_ERRORS) return;
  switch (schema.type) {
    case "object":
      checkObject(schema, value, path, errors);
      return;
    case "array":
      checkArray(schema, value, path, errors);
      return;
    case "string":
      checkString(schema, value, path, errors);
      return;
    case "number":
    case "integer":
      checkNumber(schema, value, path, errors);
      return;
    case "boolean":
      if (typeof value !== "boolean") errors.push(`${path}: expected boolean.`);
      else checkEnum(schema, value, path, errors);
      return;
    default: {
      const unreachable: never = schema.type;
      errors.push(`${path}: unsupported type ${String(unreachable)}.`);
    }
  }
}

function checkObject(schema: SchemaNode, value: unknown, path: string, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push(`${path}: expected object.`);
    return;
  }
  const properties = schema.properties ?? {};
  for (const key of schema.required ?? []) {
    if (!(key in value)) errors.push(`${path}.${key}: is required.`);
  }
  if (schema.additionalProperties === false) {
    for (const key of Object.keys(value)) {
      if (!(key in properties)) errors.push(`${path}.${key}: is not allowed.`);
    }
  }
  for (const key of Object.keys(properties)) {
    if (key in value) {
      const child = properties[key];
      if (child) checkNode(child, value[key], `${path}.${key}`, errors);
    }
  }
}

function checkArray(schema: SchemaNode, value: unknown, path: string, errors: string[]): void {
  if (!Array.isArray(value)) {
    errors.push(`${path}: expected array.`);
    return;
  }
  if (schema.minItems !== undefined && value.length < schema.minItems) {
    errors.push(`${path}: expected at least ${schema.minItems.toString()} items.`);
  }
  if (schema.maxItems !== undefined && value.length > schema.maxItems) {
    errors.push(`${path}: expected at most ${schema.maxItems.toString()} items.`);
  }
  const items = schema.items;
  if (!items) return;
  for (let index = 0; index < value.length; index += 1) {
    if (errors.length >= MAX_ERRORS) return;
    checkNode(items, value[index], `${path}[${index.toString()}]`, errors);
  }
}

function checkString(schema: SchemaNode, value: unknown, path: string, errors: string[]): void {
  if (typeof value !== "string") {
    errors.push(`${path}: expected string.`);
    return;
  }
  if (schema.minLength !== undefined && value.length < schema.minLength) {
    errors.push(`${path}: expected length >= ${schema.minLength.toString()}.`);
  }
  if (schema.maxLength !== undefined && value.length > schema.maxLength) {
    errors.push(`${path}: expected length <= ${schema.maxLength.toString()}.`);
  }
  checkEnum(schema, value, path, errors);
}

function checkNumber(schema: SchemaNode, value: unknown, path: string, errors: string[]): void {
  const integer = schema.type === "integer";
  if (typeof value !== "number" || !Number.isFinite(value) || (integer && !Number.isInteger(value))) {
    errors.push(`${path}: expected ${integer ? "integer" : "number"}.`);
    return;
  }
  if (schema.minimum !== undefined && value < schema.minimum) {
    errors.push(`${path}: expected >= ${schema.minimum.toString()}.`);
  }
  if (schema.maximum !== undefined && value > schema.maximum) {
    errors.push(`${path}: expected <= ${schema.maximum.toString()}.`);
  }
  checkEnum(schema, value, path, errors);
}

function checkEnum(schema: SchemaNode, value: string | number | boolean, path: string, errors: string[]): void {
  if (!schema.enum) return;
  if (!schema.enum.some((entry) => entry === value)) errors.push(`${path}: is not an allowed value.`);
}

function isSchemaType(value: string): value is SchemaNodeType {
  return NODE_TYPES.has(value as SchemaNodeType);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
