import { compareUsdc, parseUsdc } from "@albesa/core";
import type {
  CapabilityListing,
  CapabilitySearchHit,
  CapabilitySearchQuery,
  ReputationRankInput,
} from "./types.js";
import { cosineSimilarity, embedText, listingDocument, tokenize } from "./text.js";

const KEYWORD_WEIGHT = 0.65;
const EMBEDDING_WEIGHT = 0.35;
/** Mild tie-break on the default ranker. Relevance stays dominant (max extra boost is 25%). */
const PRICE_HINT_WEIGHT = 0.15;
const LATENCY_HINT_WEIGHT = 0.1;
const MIN_RELEVANCE = 0.12;

/**
 * Opt-in blend used only when reputation data is supplied (`withReputation`
 * or `minScore`, or a `ReputationRankInput`). Weights sum to 1:
 *
 * - relevance 0.70 — keyword overlap + hashing-trick embedding
 * - priceLatency 0.15 — cheaper and faster commercial hints
 * - reputation 0.15 — passport score / 100
 *
 * Inside the priceLatency share, price takes 60% and latency 40%
 * (the same 0.15 : 0.10 ratio as the default hint multipliers).
 *
 * An empty query has no relevance term. That 0.70 is folded into the
 * browse score (0.6 price + 0.4 latency), and reputation still takes 0.15:
 *   score = 0.85 * browse + 0.15 * (reputation / 100)
 *
 * Text search:
 *   score = 0.70 * relevance + 0.15 * commercial + 0.15 * (reputation / 100)
 *
 * The default ranker (no reputation input) is unchanged:
 *   score = relevance * (1 + 0.15 * priceHint + 0.10 * latencyHint)
 */
export const RANK_BLEND_WEIGHTS = {
  relevance: 0.7,
  priceLatency: 0.15,
  reputation: 0.15,
} as const;

/**
 * Passport stand-in when a listing has no seller passport or zero events.
 * Ranking must not treat "unknown" as a score of 0.
 */
export const NEUTRAL_REPUTATION_SCORE = 50;

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

export interface BlendRankInput {
  browsing: boolean;
  relevance: number;
  priceHint: number;
  latencyHint: number;
  /** Effective passport score, 0–100. Use `NEUTRAL_REPUTATION_SCORE` when unknown. */
  reputationScore: number;
}

/** Commercial hint in [0, 1]. Price is 60% of this term and latency is 40%. */
export function commercialHint(price: number, latency: number): number {
  const weight = PRICE_HINT_WEIGHT + LATENCY_HINT_WEIGHT;
  return (PRICE_HINT_WEIGHT * price + LATENCY_HINT_WEIGHT * latency) / weight;
}

/**
 * Blended rank score. See `RANK_BLEND_WEIGHTS`.
 * `reputationScore` is clamped to 0–100 before it enters the formula.
 */
export function blendRankScore(input: BlendRankInput): number {
  const reputation = normalizeReputationScore(input.reputationScore) / 100;
  if (input.browsing) {
    const browse = 0.6 * input.priceHint + 0.4 * input.latencyHint;
    const capability = RANK_BLEND_WEIGHTS.relevance + RANK_BLEND_WEIGHTS.priceLatency;
    return capability * browse + RANK_BLEND_WEIGHTS.reputation * reputation;
  }
  return (
    RANK_BLEND_WEIGHTS.relevance * input.relevance +
    RANK_BLEND_WEIGHTS.priceLatency * commercialHint(input.priceHint, input.latencyHint) +
    RANK_BLEND_WEIGHTS.reputation * reputation
  );
}

/** Clamp to 0–100. Null, missing, and non-finite values are neutral (50). */
export function normalizeReputationScore(value: number | null | undefined): number {
  if (value === null || value === undefined || !Number.isFinite(value)) return NEUTRAL_REPUTATION_SCORE;
  if (value < 0) return 0;
  if (value > 100) return 100;
  return value;
}

/**
 * Keyword overlap plus a deterministic hashing-trick embedding.
 * Price and latency hints rescale the relevance score; they do not replace it.
 * An empty query browses active listings by those hints alone.
 *
 * Pass `reputation` (or set `query.withReputation` / `query.minScore`) to blend
 * passport scores. Without that input the score matches the pre-reputation ranker
 * and hits omit `reputationScore`.
 */
export function rankListings(
  listings: readonly CapabilityListing[],
  query: CapabilitySearchQuery,
  reputation: ReputationRankInput | null = null,
): CapabilitySearchHit[] {
  const queryTokens = tokenize(query.q);
  const browsing = queryTokens.length === 0;
  const queryEmbedding = browsing ? null : embedText(query.q);
  const useReputation = reputation !== null || query.withReputation || query.minScore !== null;
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

    if (!useReputation) {
      const score = browsing
        ? 0.6 * price + 0.4 * latency
        : relevance * (1 + PRICE_HINT_WEIGHT * price + LATENCY_HINT_WEIGHT * latency);
      hits.push({ listing, score, relevance, priceHint: price, latencyHint: latency });
      continue;
    }

    const reputationScore = normalizeReputationScore(reputation?.scoresByListingId.get(listing.id));
    if (query.minScore !== null && reputationScore < query.minScore) continue;
    const score = blendRankScore({
      browsing,
      relevance,
      priceHint: price,
      latencyHint: latency,
      reputationScore,
    });
    hits.push({ listing, score, relevance, priceHint: price, latencyHint: latency, reputationScore });
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
