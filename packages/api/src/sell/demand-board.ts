import { cosineSimilarity, embedSemantic, parseSearchQuery, type CapabilityRegistry } from "@albesa/registry";
import { rawQuery } from "./import.js";
import type { UnmetNeed } from "../demand.js";

/** Public, anonymous view of unmet demand. No organization ids, no raw contact data. */
export interface DemandCluster {
  id: string;
  title: string;
  variants: string[];
  requests: number;
  requestsThisWeek: number;
  firstSeenAt: string;
  lastSeenAt: string;
  kind: string | null;
  suggestedPriceUsdc: string;
  /** requests × suggested price. An estimate, not a promise or a past sale. */
  estimatedEarningsUsdc: string;
  publishUrl: string;
}

const REDACTIONS: [RegExp, string][] = [
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "[redacted]"],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[redacted]"],
  [/\b(?:https?:\/\/|www\.)\S+/gi, "[link]"],
  [/\b(?:sk|pk|rk|ghp|gho|xox[abpr]|AKIA|AIza|rst|roster)[-_A-Za-z0-9]{12,}\b/g, "[redacted]"],
  [/\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){2,7}(?:\s?[A-Z0-9]{1,4})?\b/g, "[redacted]"],
  [/\b(?:\d[ -]?){13,19}\b/g, "[redacted]"],
  [/\+?\d[\d ().-]{7,}\d/g, "[redacted]"],
  [/\b0x[a-fA-F0-9]{16,}\b/g, "[redacted]"],
  [/\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g, "[redacted]"],
  [/\b[a-fA-F0-9]{32,}\b/g, "[redacted]"],
  [/\b[A-Za-z0-9_-]{40,}\b/g, "[redacted]"],
  [/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "[redacted]"],
  [/\b(?:[0-9a-fA-F]{1,4}:){3,7}[0-9a-fA-F]{1,4}\b/g, "[redacted]"],
];

export function sanitizeNeed(text: string): string {
  let out = [...text].map((char) => (char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127 ? " " : char)).join("");
  for (const [pattern, replacement] of REDACTIONS) out = out.replace(pattern, replacement);
  out = out.replace(/(?:\[(?:redacted|link)\]\s*){2,}/g, (match) => `${match.trim().split(/\s+/)[0]!} `);
  out = out.replace(/\s+/g, " ").trim();
  return out.length <= 160 ? out : `${out.slice(0, 159).trimEnd()}…`;
}

/** Text that is mostly redactions carries no demand signal. */
function informative(text: string): boolean {
  const words = text.replace(/\[(?:redacted|link)\]/g, " ").match(/[\p{L}]{2,}/gu) ?? [];
  return words.length >= 2;
}

export function buildDemandBoard(
  needs: UnmetNeed[],
  options: { registry: CapabilityRegistry; now?: Date; limit?: number; threshold?: number },
): { clusters: DemandCluster[]; totals: { needs: number; requests: number; requestsThisWeek: number } } {
  const now = options.now ?? new Date();
  const weekAgo = now.getTime() - 7 * 86_400_000;
  const threshold = options.threshold ?? 0.62;
  type Working = { lead: UnmetNeed; vector: Float64Array; members: UnmetNeed[]; texts: string[] };
  const clusters: Working[] = [];
  const sorted = [...needs].sort((left, right) => right.count - left.count || right.lastSeenAt.localeCompare(left.lastSeenAt));
  for (const need of sorted) {
    const text = sanitizeNeed(need.need);
    if (!informative(text)) continue;
    const vector = embedSemantic(need.normalized || text.toLowerCase());
    let home: Working | null = null;
    let best = threshold;
    for (const cluster of clusters) {
      const similarity = cosineSimilarity(cluster.vector, vector);
      if (similarity >= best) {
        best = similarity;
        home = cluster;
      }
    }
    if (home) {
      home.members.push(need);
      if (home.texts.length < 5 && !home.texts.some((existing) => existing.toLowerCase() === text.toLowerCase())) home.texts.push(text);
    } else {
      clusters.push({ lead: need, vector, members: [need], texts: [text] });
    }
  }
  const out: DemandCluster[] = clusters.map((cluster) => {
    const requests = cluster.members.reduce((sum, member) => sum + member.count, 0);
    const thisWeek = cluster.members.reduce((sum, member) => sum + weekCount(member, weekAgo), 0);
    const lastSeenAt = cluster.members.map((member) => member.lastSeenAt).sort().at(-1) ?? cluster.lead.lastSeenAt;
    const firstSeenAt = cluster.members.map((member) => member.firstSeenAt).sort()[0] ?? cluster.lead.firstSeenAt;
    const budgets = cluster.members.map((member) => Number(member.budgetUsdc)).filter((value) => Number.isFinite(value) && value > 0);
    const price = suggestPrice(options.registry, cluster.texts[0]!, budgets);
    const title = cluster.texts[0]!;
    return {
      id: cluster.lead.id.replace(/^need_/, "dem_"),
      title,
      variants: cluster.texts.slice(1),
      requests,
      requestsThisWeek: thisWeek,
      firstSeenAt,
      lastSeenAt,
      kind: cluster.lead.kind,
      suggestedPriceUsdc: price.toFixed(3),
      estimatedEarningsUsdc: (requests * price).toFixed(3),
      publishUrl: `/sell?need=${encodeURIComponent(title.slice(0, 120))}`,
    };
  });
  out.sort((left, right) => right.requestsThisWeek - left.requestsThisWeek || right.requests - left.requests || right.lastSeenAt.localeCompare(left.lastSeenAt));
  return {
    clusters: out.slice(0, options.limit ?? 100),
    totals: {
      needs: out.length,
      requests: out.reduce((sum, cluster) => sum + cluster.requests, 0),
      requestsThisWeek: out.reduce((sum, cluster) => sum + cluster.requestsThisWeek, 0),
    },
  };
}

function weekCount(need: UnmetNeed, weekAgo: number): number {
  const recent = need.recentSeenAt ?? [];
  if (recent.length > 0) return recent.filter((at) => Date.parse(at) >= weekAgo).length;
  // Rows logged before recent timestamps existed: count them only when the last sighting is this week.
  return Date.parse(need.lastSeenAt) >= weekAgo ? 1 : 0;
}

function suggestPrice(registry: CapabilityRegistry, text: string, budgets: number[]): number {
  let prices: number[] = [];
  try {
    prices = registry
      .search(parseSearchQuery(rawQuery(text.slice(0, 200), "5")))
      .filter((hit) => hit.relevance >= 0.18)
      .map((hit) => Number(hit.listing.pricing.amountUsdc))
      .filter((value) => Number.isFinite(value) && value > 0);
  } catch {
    prices = [];
  }
  const pool = prices.length > 0 ? prices : budgets;
  if (pool.length === 0) return 0.01;
  const sorted = [...pool].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)]!;
  return Math.min(5, Math.max(0.001, median));
}
