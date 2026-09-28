/** Hashing-trick embeddings. Deterministic and local — not a real model. */
export const EMBEDDING_DIMENSIONS = 128;

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
  let norm = 0;
  for (const value of vector) norm += value * value;
  norm = Math.sqrt(norm);
  if (norm === 0) return vector;
  for (let index = 0; index < vector.length; index += 1) {
    vector[index] = (vector[index] ?? 0) / norm;
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
