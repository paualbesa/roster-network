import { compareUsdc, parseUsdc } from "@albesa/core";
import type { CapabilityListing, CapabilitySearchHit, CapabilitySearchQuery } from "./types.js";
import { cosineSimilarity, embedText, listingDocument, tokenize } from "./text.js";

const KEYWORD_WEIGHT = 0.65;
const EMBEDDING_WEIGHT = 0.35;
/** Mild tie-break. Relevance stays dominant (max extra boost is 25%). */
const PRICE_HINT_WEIGHT = 0.15;
const LATENCY_HINT_WEIGHT = 0.1;
const MIN_RELEVANCE = 0.12;

/** Cheaper listings score closer to 1. Free is 1. */
export function priceHint(amountUsdc: string): number {
  const micros = parseUsdc(amountUsdc);
  const denominator = 1_000_000n + micros;
  return 1_000_000 / Number(denominator);
}

/** Faster p95 scores closer to 1. 0ms would be 1; 1000ms is 0.5. */
export function latencyHint(p95Ms: number): number {
  return 1 / (1 + p95Ms / 1000);
}

/**
 * Keyword overlap plus a deterministic hashing-trick embedding.
 * Price and latency hints rescale the relevance score; they do not replace it.
 * An empty query browses active listings by those hints alone.
 */
export function rankListings(
  listings: readonly CapabilityListing[],
  query: CapabilitySearchQuery,
): CapabilitySearchHit[] {
  const queryTokens = tokenize(query.q);
  const browsing = queryTokens.length === 0;
  const queryEmbedding = browsing ? null : embedText(query.q);
  const hits: CapabilitySearchHit[] = [];

  for (const listing of listings) {
    if (listing.status !== "active") continue;
    if (query.tags.length > 0 && !query.tags.every((tag) => listing.tags.includes(tag))) continue;
    if (query.maxPriceUsdc !== null && compareUsdc(listing.pricing.amountUsdc, query.maxPriceUsdc) > 0) continue;
    if (query.maxP95Ms !== null && listing.latency.p95Ms > query.maxP95Ms) continue;

    const price = priceHint(listing.pricing.amountUsdc);
    const latency = latencyHint(listing.latency.p95Ms);
    const keyword = keywordScore(queryTokens, listing);
    const embedding =
      queryEmbedding === null
        ? 0
        : Math.max(0, cosineSimilarity(queryEmbedding, embedText(listingDocument(listing))));
    const relevance = browsing ? 0 : KEYWORD_WEIGHT * keyword + EMBEDDING_WEIGHT * embedding;
    if (!browsing && relevance < MIN_RELEVANCE) continue;

    const score = browsing
      ? 0.6 * price + 0.4 * latency
      : relevance * (1 + PRICE_HINT_WEIGHT * price + LATENCY_HINT_WEIGHT * latency);

    hits.push({ listing, score, relevance, priceHint: price, latencyHint: latency });
  }

  hits.sort(compareHits);
  return hits.slice(0, query.limit);
}

function keywordScore(queryTokens: readonly string[], listing: CapabilityListing): number {
  const unique = [...new Set(queryTokens)];
  if (unique.length === 0) return 0;
  const name = new Set(tokenize(listing.name));
  const tags = new Set(listing.tags.flatMap((tag) => tokenize(tag)));
  const description = new Set(tokenize(listing.description));
  let total = 0;
  for (const token of unique) {
    if (name.has(token)) total += 1;
    else if (tags.has(token)) total += 0.9;
    else if (description.has(token)) total += 0.6;
  }
  return total / unique.length;
}

function compareHits(left: CapabilitySearchHit, right: CapabilitySearchHit): number {
  if (right.score !== left.score) return right.score - left.score;
  const priceOrder = compareUsdc(left.listing.pricing.amountUsdc, right.listing.pricing.amountUsdc);
  if (priceOrder !== 0) return priceOrder;
  if (left.listing.latency.p95Ms !== right.listing.latency.p95Ms) {
    return left.listing.latency.p95Ms - right.listing.latency.p95Ms;
  }
  if (left.listing.id < right.listing.id) return -1;
  if (left.listing.id > right.listing.id) return 1;
  return 0;
}
