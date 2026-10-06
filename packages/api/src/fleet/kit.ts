/**
 * Building blocks for the first-party Roster Fleet catalog.
 * Every tool is deterministic and offline: no model, no network, no paid API.
 * Executors never throw on bad input. They return a schema-valid result
 * (often empty lists or zero counts) so escrow can settle either way.
 */

export type Json = Record<string, unknown>;

export interface FleetTool {
  /** Listing name. Stable: the fleet bootstrap matches on it. */
  name: string;
  /** MCP tool name and OpenAPI operation slug (snake_case). */
  slug: string;
  category: FleetCategory;
  description: string;
  tags: string[];
  priceUsdc: string;
  p95Ms: number;
  p50Ms: number;
  /** Input properties. Wrapped in an object schema with `required`. */
  input: Json;
  required: string[];
  /** Example buyer input. Stored as `inputSchema.examples[0]`. */
  example: Json;
  /** Result schema escrow validates. Must stay inside the escrow schema subset. */
  output: Json;
  run: (input: Json) => Json;
}

export type FleetCategory =
  | "text"
  | "extraction"
  | "translation"
  | "data"
  | "finance"
  | "code"
  | "seo"
  | "research"
  | "media"
  | "utility";

/** Hard cap on any text an executor reads. Bounds CPU per job. */
export const MAX_TEXT = 20_000;

export const s = {
  str(maxLength = 2000, minLength = 0): Json {
    return minLength > 0 ? { type: "string", minLength, maxLength } : { type: "string", maxLength };
  },
  int(minimum?: number, maximum?: number): Json {
    return {
      type: "integer",
      ...(minimum !== undefined ? { minimum } : {}),
      ...(maximum !== undefined ? { maximum } : {}),
    };
  },
  num(minimum?: number, maximum?: number): Json {
    return {
      type: "number",
      ...(minimum !== undefined ? { minimum } : {}),
      ...(maximum !== undefined ? { maximum } : {}),
    };
  },
  bool(): Json {
    return { type: "boolean" };
  },
  enm(values: string[]): Json {
    return { type: "string", enum: values };
  },
  arr(items: Json, maxItems = 50, minItems = 0): Json {
    return minItems > 0 ? { type: "array", items, minItems, maxItems } : { type: "array", items, maxItems };
  },
  obj(properties: Json, required: string[] = Object.keys(properties)): Json {
    return { type: "object", additionalProperties: false, required, properties };
  },
};

export function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function text(input: Json, key: string, fallback = ""): string {
  const value = input[key];
  if (typeof value !== "string") return fallback;
  return value.slice(0, MAX_TEXT);
}

export function int(input: Json, key: string, fallback: number, min: number, max: number): number {
  const value = input[key];
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

export function num(input: Json, key: string, fallback: number): number {
  const value = input[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  return fallback;
}

export function bool(input: Json, key: string, fallback: boolean): boolean {
  const value = input[key];
  return typeof value === "boolean" ? value : fallback;
}

export function strings(input: Json, key: string, maxItems = 200, maxLength = 500): string[] {
  const value = input[key];
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === "string")
    .slice(0, maxItems)
    .map((entry) => entry.slice(0, maxLength));
}

export function records(input: Json, key: string, maxItems = 500): Json[] {
  const value = input[key];
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).slice(0, maxItems);
}

export function numbers(input: Json, key: string, maxItems = 10_000): number[] {
  const value = input[key];
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, maxItems)
    .map((entry) => (typeof entry === "string" ? Number(entry) : entry))
    .filter((entry): entry is number => typeof entry === "number" && Number.isFinite(entry));
}

export function oneOf<T extends string>(input: Json, key: string, values: readonly T[], fallback: T): T {
  const value = input[key];
  return typeof value === "string" && (values as readonly string[]).includes(value) ? (value as T) : fallback;
}

export function clip(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}

export function round(value: number, digits = 2): number {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function money(value: number, digits = 2): string {
  if (!Number.isFinite(value)) return (0).toFixed(digits);
  return value.toFixed(digits);
}

/** Parse "1,234.50", "1.234,50", "$12", "12 EUR" into a number. Null when there is no amount. */
export function parseAmount(raw: string): number | null {
  const cleaned = raw.replace(/[^0-9.,-]/g, "");
  if (!/[0-9]/.test(cleaned)) return null;
  let normalized = cleaned;
  const lastComma = cleaned.lastIndexOf(",");
  const lastDot = cleaned.lastIndexOf(".");
  if (lastComma > lastDot) {
    const decimals = cleaned.length - lastComma - 1;
    normalized =
      decimals === 3 && lastDot === -1 && cleaned.indexOf(",") === lastComma
        ? cleaned.replace(/,/g, "")
        : cleaned.replace(/\./g, "").replace(",", ".");
  } else {
    normalized = cleaned.replace(/,/g, "");
  }
  const value = Number(normalized);
  return Number.isFinite(value) ? value : null;
}

/** Deterministic 32-bit FNV-1a hash. Used to pick stable variants, never for security. */
export function fnv(textValue: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < textValue.length; index += 1) {
    hash ^= textValue.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}
