/**
 * Local embeddings. Deterministic and offline — not a hosted model.
 * `embedText` is the token hashing trick used by the default keyword ranker.
 * `embedSemantic` is the vector stored on the index for `semantic=1`.
 */
export const EMBEDDING_DIMENSIONS = 128;

/**
 * Semantic vector width.
 * The first 38×38 slots are exact character bigrams (boundary, a–z, 0–9).
 * The last 128 slots are a signed hashing trick over canonical tokens,
 * so synonyms such as "receipt" and "invoice" still land on one feature.
 */
const BIGRAM_SYMBOLS = 38;
const SEMANTIC_TOKEN_DIMENSIONS = 128;
export const SEMANTIC_DIMENSIONS = BIGRAM_SYMBOLS * BIGRAM_SYMBOLS + SEMANTIC_TOKEN_DIMENSIONS;

const SEMANTIC_TOKEN_WEIGHT = 2.5;
const SEMANTIC_BIGRAM_WEIGHT = 1;

const STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "at",
  "by",
  "for",
  "from",
  "in",
  "is",
  "it",
  "of",
  "on",
  "or",
  "the",
  "to",
  "with",
]);

/** Small synonym table so "parse receipts" lands near "extract invoices". */
const CANONICAL: Record<string, string> = {
  parse: "extract",
  parser: "extract",
  parsing: "extract",
  extraction: "extract",
  extracting: "extract",
  extracted: "extract",
  extractor: "extract",
  receipt: "invoice",
  receipts: "invoice",
  invoices: "invoice",
  billing: "invoice",
  summarise: "summarize",
  summarising: "summarize",
  summarizing: "summarize",
  summary: "summarize",
  summaries: "summarize",
  translation: "translate",
  translating: "translate",
  translated: "translate",
  lookup: "search",
  find: "search",
  query: "search",
  querying: "search",
  photo: "image",
  photos: "image",
  picture: "image",
  pictures: "image",
  vision: "image",
};

export function listingDocument(listing: { name: string; description: string; tags: readonly string[] }): string {
  return `${listing.name}\n${listing.tags.join(" ")}\n${listing.description}`;
}

/**
 * Text embedded into the stored semantic vector: title, tags, description,
 * and capability names taken from the input and output schemas.
 */
export function capabilityDocument(listing: {
  name: string;
  description: string;
  tags: readonly string[];
  inputSchema?: unknown;
  outputSchema?: unknown;
}): string {
  const capabilities = [schemaCapabilityText(listing.inputSchema), schemaCapabilityText(listing.outputSchema)]
    .filter((part) => part.length > 0)
    .join(" ");
  const head = `${listing.name}\n${listing.tags.join(" ")}\n${listing.description}`;
  return capabilities.length > 0 ? `${head}\n${capabilities}` : head;
}

export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  for (const part of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (part.length < 2 || STOPWORDS.has(part)) continue;
    tokens.push(canonicalize(part));
  }
  return tokens;
}

export function embedText(text: string): Float64Array {
  const vector = new Float64Array(EMBEDDING_DIMENSIONS);
  const tokens = tokenize(text);
  if (tokens.length === 0) return vector;
  for (const token of tokens) {
    const hash = fnv1a(token);
    const index = hash % EMBEDDING_DIMENSIONS;
    const sign = (hash & 1) === 0 ? 1 : -1;
    vector[index] = (vector[index] ?? 0) + sign;
  }
  return l2Normalize(vector);
}

/**
 * Offline semantic embedding. Character bigrams catch near-miss keywords
 * ("invioce" vs "invoice"). Canonical token features keep the synonym table.
 * No network call and no downloaded model.
 */
export function embedSemantic(text: string): Float64Array {
  const vector = new Float64Array(SEMANTIC_DIMENSIONS);
  const seen = new Set<string>();
  const bigramOffset = BIGRAM_SYMBOLS * BIGRAM_SYMBOLS;
  for (const token of surfaceTokens(text)) {
    if (seen.has(token)) continue;
    seen.add(token);
    const hash = fnv1a(`w:${canonicalize(token)}`);
    const tokenIndex = bigramOffset + (hash % SEMANTIC_TOKEN_DIMENSIONS);
    const sign = (hash & 1) === 0 ? 1 : -1;
    vector[tokenIndex] = (vector[tokenIndex] ?? 0) + sign * SEMANTIC_TOKEN_WEIGHT;
    if (token.length < 4) continue;
    const padded = `^${token}$`;
    for (let index = 0; index < padded.length - 1; index += 1) {
      const left = symbolIndex(padded[index] ?? "");
      const right = symbolIndex(padded[index + 1] ?? "");
      if (left < 0 || right < 0) continue;
      const bigram = left * BIGRAM_SYMBOLS + right;
      vector[bigram] = (vector[bigram] ?? 0) + SEMANTIC_BIGRAM_WEIGHT;
    }
  }
  return l2Normalize(vector);
}

/** Sparse pairs `[index, weight, ...]` for the index file. Zeros are omitted. */
export function serializeSemanticVector(vector: Float64Array): number[] {
  const pairs: number[] = [];
  const width = Math.min(vector.length, SEMANTIC_DIMENSIONS);
  for (let index = 0; index < width; index += 1) {
    const rounded = Math.round((vector[index] ?? 0) * 1e6) / 1e6;
    if (rounded === 0) continue;
    pairs.push(index, rounded);
  }
  return pairs;
}

/** Expand sparse pairs. Returns null when the payload is not a semantic vector. */
export function deserializeSemanticVector(value: unknown): Float64Array | null {
  if (!Array.isArray(value) || value.length % 2 !== 0) return null;
  const vector = new Float64Array(SEMANTIC_DIMENSIONS);
  for (let index = 0; index < value.length; index += 2) {
    const slot = value[index];
    const weight = value[index + 1];
    if (typeof slot !== "number" || !Number.isInteger(slot) || slot < 0 || slot >= SEMANTIC_DIMENSIONS) return null;
    if (typeof weight !== "number" || !Number.isFinite(weight)) return null;
    vector[slot] = weight;
  }
  return vector;
}

export function cosineSimilarity(left: Float64Array, right: Float64Array): number {
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const leftValue = left[index] ?? 0;
    const rightValue = right[index] ?? 0;
    dot += leftValue * rightValue;
    leftNorm += leftValue * leftValue;
    rightNorm += rightValue * rightValue;
  }
  if (leftNorm === 0 || rightNorm === 0) return 0;
  return dot / Math.sqrt(leftNorm * rightNorm);
}

function l2Normalize(vector: Float64Array): Float64Array {
  let norm = 0;
  for (const value of vector) norm += value * value;
  norm = Math.sqrt(norm);
  if (norm === 0) return vector;
  for (let index = 0; index < vector.length; index += 1) {
    vector[index] = (vector[index] ?? 0) / norm;
  }
  return vector;
}

/** Surface forms, not stems. Bigrams need the original spelling. */
function surfaceTokens(text: string): string[] {
  const tokens: string[] = [];
  for (const part of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (part.length < 2 || STOPWORDS.has(part)) continue;
    tokens.push(part);
  }
  return tokens;
}

/** 0 = ^, 1 = $, 2–27 = a–z, 28–37 = 0–9. Anything else is skipped. */
function symbolIndex(symbol: string): number {
  if (symbol === "^") return 0;
  if (symbol === "$") return 1;
  const code = symbol.charCodeAt(0);
  if (code >= 97 && code <= 122) return 2 + code - 97;
  if (code >= 48 && code <= 57) return 28 + code - 48;
  return -1;
}

function schemaCapabilityText(schema: unknown): string {
  const parts: string[] = [];
  collectSchemaText(schema, parts, 0);
  return parts.join(" ");
}

function collectSchemaText(value: unknown, parts: string[], depth: number): void {
  if (depth > 12 || !isPlain(value)) return;
  pushSchemaString(value.title, parts);
  pushSchemaString(value.description, parts);
  if (Array.isArray(value.enum)) {
    for (const entry of value.enum) pushSchemaString(entry, parts);
  }
  const properties = value.properties;
  if (isPlain(properties)) {
    for (const [name, child] of Object.entries(properties)) {
      parts.push(splitIdentifier(name));
      collectSchemaText(child, parts, depth + 1);
    }
  }
  collectSchemaText(value.items, parts, depth + 1);
  collectSchemaMap(value.$defs, parts, depth);
  collectSchemaMap(value.definitions, parts, depth);
}

function collectSchemaMap(value: unknown, parts: string[], depth: number): void {
  if (!isPlain(value)) return;
  for (const child of Object.values(value)) collectSchemaText(child, parts, depth + 1);
}

function pushSchemaString(value: unknown, parts: string[]): void {
  if (typeof value !== "string" || value.trim().length === 0) return;
  parts.push(splitIdentifier(value));
}

function splitIdentifier(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_\-./]+/g, " ");
}

function isPlain(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalize(token: string): string {
  const direct = CANONICAL[token];
  if (direct) return direct;
  const stemmed = stem(token);
  return CANONICAL[stemmed] ?? stemmed;
}

function stem(token: string): string {
  if (token.endsWith("ing") && token.length > 5) return token.slice(0, -3);
  if (token.endsWith("tion") && token.length > 6) return token.slice(0, -4);
  if (token.endsWith("s") && !token.endsWith("ss") && token.length > 3) return token.slice(0, -1);
  return token;
}

function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}
