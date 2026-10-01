import { SEMANTIC_DIMENSIONS } from "@albesa/registry";

/** pgvector text literal. Width matches `SEMANTIC_DIMENSIONS` and the SQL column. */
export function toVectorLiteral(vector: ArrayLike<number>, dimensions = SEMANTIC_DIMENSIONS): string {
  const parts: string[] = [];
  for (let index = 0; index < dimensions; index += 1) {
    const value = vector[index] ?? 0;
    if (!Number.isFinite(value)) {
      parts.push("0");
      continue;
    }
    const rounded = Math.round(value * 1e8) / 1e8;
    parts.push(Object.is(rounded, -0) ? "0" : rounded.toString());
  }
  return `[${parts.join(",")}]`;
}
