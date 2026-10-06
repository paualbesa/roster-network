import { compareUsdc, formatUsdc, MIN_PAID_LISTING_USDC, parseUsdc } from "@albesa/core";
import {
  embedSemantic,
  parseSearchQuery,
  type CapabilityListing,
  type CapabilityRegistry,
  type CapabilitySearchHit,
  type ListingKind,
} from "@albesa/registry";
import type { DataCatalog } from "./data/catalog.js";
import type { DemandLog } from "./demand.js";
import type { JobOrchestrator, JobView } from "./jobs.js";
import { ServiceError, type AgentFinanceService } from "./service.js";

export const NEED_MAX_CHARS = 500;
/** Below this combined relevance a need counts as unmet and is logged. */
export const NEED_MATCH_THRESHOLD = 0.36;
/** Matches below this are still logged as weak demand so the admin sees near-misses. */
export const NEED_WEAK_THRESHOLD = 0.45;
const DEFAULT_LIMIT = 6;
const MAX_LIMIT = 20;
const BUY_WAIT_MS = 9000;
/** Agent `POST /v1/need/buy` creates (or reuses) when the caller names none. */
export const NEED_BUYER_AGENT_NAME = "Roster buyer";
const NEED_BUYER_FLOAT_USDC = "5.00";

export interface NeedRequest {
  need: string;
  budgetUsdc: string | null;
  kinds: ListingKind[];
  limit: number;
  buy: boolean;
  input: Record<string, unknown> | null;
}

export interface NeedMatch {
  listingId: string;
  name: string;
  kind: ListingKind;
  summary: string;
  priceUsdc: string;
  relevance: number;
  score: number;
  seller: string | null;
  freshness: {
    lastRefreshedAt: string | null;
    refreshCadence: string | null;
    status: string;
    rowCount: number | null;
  } | null;
  source: { name: string; license: string; url: string } | null;
  sample: Record<string, unknown>[];
  inputExample: Record<string, unknown>;
  p95Ms: number;
  buy: { method: "POST"; path: "/v1/need/buy"; body: { listingId: string; input: Record<string, unknown> } };
}

export interface NeedDeps {
  registry: CapabilityRegistry;
  service: AgentFinanceService;
  orchestrator: JobOrchestrator;
  data: DataCatalog | null;
  demand: DemandLog;
  matchCapabilities?: (query: ArrayLike<number>, limit: number) => Promise<ReadonlyMap<string, number>>;
}

/**
 * Catalan and Spanish phrases rewritten to the English vocabulary listings use,
 * so "tipus de canvi euro dòlar" finds the FX products. Matched on accent-folded text.
 */
const SYNONYMS: [RegExp, string][] = [
  [/\b(tipus|tipos?) de canvi\b|\btipo de cambio\b|\bcanvi de divises\b|\bcambio de divisas?\b/, "exchange rates fx currency"],
  [/\b(divises?|divisas?|monedes?|monedas?)\b/, "currency fx"],
  [/\bconver(tir|teix|sor|ter)\b/, "convert conversion"],
  [/\b(terratremols?|terremotos?|sismes?|sismos?)\b/, "earthquakes seismic"],
  [/\b(temps|tiempo|clima|meteo|previsio|prevision|pronostico)\b/, "weather forecast"],
  [/\b(pluja|lluvia|temperatura)\b/, "weather precipitation temperature forecast"],
  [/\b(vulnerabilitats?|vulnerabilidad(es)?|seguretat|seguridad)\b/, "security vulnerabilities cve"],
  [/\b(inflacio|inflacion|ipc|preus|precios)\b/, "inflation cpi prices"],
  [/\b(atur|paro|desocupacio|desempleo)\b/, "unemployment labour"],
  [/\b(festius?|festivos?|vacances|feriados?|dies festius)\b/, "holidays bank-holidays calendar"],
  [/\b(aeroports?|aeropuertos?)\b/, "airports iata"],
  [/\b(ciutats?|ciudad(es)?|municipis?|municipios?)\b/, "cities geocoding"],
  [/\b(empreses?|empresas?|companyies?|compania|societat|sociedad)\b/, "companies legal-entity"],
  [/\b(articles? cientifics?|articulos? cientificos?|papers?|recerca|investigacion|preprints?)\b/, "arxiv papers research"],
  [/\b(pib)\b/, "gdp economy"],
  [/\b(poblacio|poblacion|habitants|habitantes)\b/, "population"],
  [/\b(tipus d interes|tipos de interes|interessos|intereses|euribor|bce)\b/, "interest rates ecb"],
  [/\b(emissions|emisiones|co2|carboni|carbono)\b/, "co2 emissions climate"],
  [/\b(paisos|paises|pais)\b/, "countries country"],
  [/\b(idiomes?|idiomas?|llenguas?|lenguas?)\b/, "languages iso-639"],
  [/\b(zones? horaries?|zonas? horarias?|fus horari|huso horario)\b/, "timezones utc-offset"],
  [/\b(borsa|bolsa|accions|acciones|cotitzacio|cotizacion)\b/, "stocks equities sec ticker"],
  [/\b(gas|comissions?|comisiones?|tarifes?)\b/, "fees gas"],
  [/\b(dades|datos|dataset|taula|tabla|llista|lista)\b/, "data dataset table"],
  [/\b(tendencies|tendencias|trending|mes llegits|mas leidos)\b/, "trending popularity pageviews"],
  [/\b(incendis?|incendios?|tempestes?|tormentas?|volcans?|volcanes?)\b/, "wildfires storms volcanoes natural-events"],
  [/\b(dependencies|dependencias|paquets?|paquetes?|llibreries?|librerias?)\b/, "dependencies packages open-source"],
  [/\b(dollars?|euros?|pounds?|yen|yuan|usd|eur|gbp|jpy|chf|cny|dolars?|dolares|lliures?|libras?)\b/, "currency fx exchange rates"],
  [/\bconvert\w*\b/, "converter conversion"],
  [/\blei\b|\blegal entity\b/, "lei legal-entity company kyb gleif"],
  [/\b(exploited|exploits?|kev)\b/, "kev exploited cve vulnerabilities"],
  [/\bcve \d{4} \d+\b/, "cve vulnerabilities kev"],
  [/\b(tickers?|cik)\b/, "sec ticker cik lookup"],
  [/\b(edgar|filings?|8 k|10 k|10 q)\b/, "sec edgar filings feed new"],
  [/\b(npm|pypi|pip|maven|cargo|crates?|gem|nuget)\b/, "dependencies package osv"],
  [/\b(traduir|traducir|traduccio|traduccion)\b/, "translate translation"],
  [/\b(resum|resumen|resumir)\b/, "summarize summary"],
  [/\b(factura|rebut|recibo|tiquet)\b/, "invoice receipt"],
];

export function expandNeed(need: string): string {
  const folded = need
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/['’]/g, " ");
  const extra: string[] = [];
  for (const [pattern, words] of SYNONYMS) if (pattern.test(folded)) extra.push(words);
  return extra.length > 0 ? `${need} ${extra.join(" ")}` : need;
}

export function parseNeedBody(body: unknown): NeedRequest {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new ServiceError(400, "invalid_request", "Send a JSON object like {\"need\": \"EUR/USD rate history as CSV\"}.");
  }
  const record = body as Record<string, unknown>;
  const need = typeof record.need === "string" ? record.need.trim() : "";
  if (need.length < 2 || need.length > NEED_MAX_CHARS) {
    throw new ServiceError(400, "invalid_request", `need must be a string of 2-${NEED_MAX_CHARS.toString()} characters.`);
  }
  const rawBudget = record.budgetUsdc ?? record.budget;
  let budgetUsdc: string | null = null;
  if (rawBudget !== undefined && rawBudget !== null && rawBudget !== "") {
    const text = typeof rawBudget === "number" ? rawBudget.toString() : typeof rawBudget === "string" ? rawBudget.trim() : "";
    try {
      budgetUsdc = formatUsdc(parseUsdc(text));
    } catch {
      throw new ServiceError(400, "invalid_request", "budgetUsdc must be a USDC amount such as \"0.05\".");
    }
  }
  const kinds: ListingKind[] = [];
  const rawKind = record.kind ?? record.kinds;
  const kindList = Array.isArray(rawKind) ? rawKind : typeof rawKind === "string" ? rawKind.split(",") : [];
  for (const kind of kindList) {
    const value = typeof kind === "string" ? kind.trim() : "";
    if (value === "data") kinds.push("dataset", "feed", "lookup");
    else if (value === "service" || value === "dataset" || value === "feed" || value === "lookup") kinds.push(value);
    else if (value) throw new ServiceError(400, "invalid_request", 'kind must be service, dataset, feed, lookup, or data.');
  }
  const limitRaw = typeof record.limit === "number" ? record.limit : DEFAULT_LIMIT;
  const limit = Math.min(MAX_LIMIT, Math.max(1, Math.trunc(limitRaw)));
  const input =
    typeof record.input === "object" && record.input !== null && !Array.isArray(record.input)
      ? (record.input as Record<string, unknown>)
      : null;
  return { need, budgetUsdc, kinds: [...new Set(kinds)], limit, buy: record.buy === true, input };
}

export async function matchNeed(deps: NeedDeps, request: NeedRequest): Promise<{ matches: NeedMatch[]; best: CapabilitySearchHit | null; bestRelevance: number }> {
  const expanded = expandNeed(request.need);
  const base = {
    q: expanded,
    limit: "50",
    ...(request.budgetUsdc ? { maxPriceUsdc: request.budgetUsdc } : {}),
    ...(request.kinds.length > 0 ? { kind: request.kinds.join(",") } : {}),
  };
  const keyword = deps.registry.search(parseSearchQuery({ ...base, semantic: "false" } as never));
  const similarities = deps.matchCapabilities ? await deps.matchCapabilities(embedSemantic(expanded), 200).catch(() => null) : null;
  const semantic = deps.registry.search(parseSearchQuery({ ...base, semantic: "true" } as never), null, similarities);
  const combined = new Map<string, { hit: CapabilitySearchHit; keyword: number; semantic: number }>();
  for (const hit of keyword) combined.set(hit.listing.id, { hit, keyword: hit.relevance, semantic: 0 });
  for (const hit of semantic) {
    const current = combined.get(hit.listing.id);
    if (current) current.semantic = hit.relevance;
    else combined.set(hit.listing.id, { hit, keyword: 0, semantic: hit.relevance });
  }
  const ranked = [...combined.values()]
    .map((entry) => {
      const relevance = Math.min(1, 0.55 * entry.keyword + 0.45 * entry.semantic + 0.1 * Math.min(entry.keyword, entry.semantic));
      const kind = entry.hit.listing.kind ?? "service";
      // Agents should reach for data Roster already collected before paying for compute.
      const dataBoost = kind === "service" ? 1 : 1.06;
      const score = relevance * dataBoost * (1 + 0.08 * entry.hit.priceHint + 0.04 * entry.hit.latencyHint);
      return { ...entry, relevance, score };
    })
    .sort((left, right) => right.score - left.score || left.hit.listing.name.localeCompare(right.hit.listing.name));
  const top = ranked[0];
  const usable = ranked.filter((entry) => entry.relevance >= NEED_MATCH_THRESHOLD * 0.8).slice(0, request.limit);
  const matches = usable.map((entry) => toMatch(deps, entry.hit.listing, entry.relevance, entry.score));
  return { matches, best: top?.hit ?? null, bestRelevance: top?.relevance ?? 0 };
}

function toMatch(deps: NeedDeps, listing: CapabilityListing, relevance: number, score: number): NeedMatch {
  const kind = listing.kind ?? "service";
  const info = listing.data?.slug ? deps.data?.info(listing.data.slug) ?? null : null;
  const source = listing.data?.sources[0] ?? null;
  const examples = (listing.inputSchema as { examples?: unknown[] }).examples;
  const example = Array.isArray(examples) && typeof examples[0] === "object" && examples[0] !== null ? (examples[0] as Record<string, unknown>) : {};
  return {
    listingId: listing.id,
    name: listing.name,
    kind,
    summary: firstSentences(listing.description, 240),
    priceUsdc: listing.pricing.amountUsdc,
    relevance: round(relevance),
    score: round(score),
    seller: null,
    freshness:
      kind === "service"
        ? null
        : {
            lastRefreshedAt: info?.lastRefreshedAt ?? null,
            refreshCadence: info?.refreshCadence ?? listing.data?.refreshCadence ?? null,
            status: info?.status ?? "pending",
            rowCount: info && !info.live ? info.rowCount : null,
          },
    source: source ? { name: source.name, license: source.license, url: source.url } : null,
    sample: (info?.sample ?? []).slice(0, 3),
    inputExample: example,
    p95Ms: listing.latency.p95Ms,
    buy: { method: "POST", path: "/v1/need/buy", body: { listingId: listing.id, input: example } },
  };
}

function firstSentences(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const stop = cut.lastIndexOf(". ");
  return stop > 80 ? cut.slice(0, stop + 1) : `${cut.trimEnd()}…`;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export interface NeedBuyResult {
  job: JobView;
  status: JobView["status"];
  delivered: boolean;
  result: unknown;
  receipt: {
    listingId: string;
    listingName: string;
    amountUsdc: string;
    takeRateUsdc: string;
    sellerNetUsdc: string;
    escrowId: string;
    buyerAgentId: string;
    buyerBalanceUsdc: string;
    settledAt: string | null;
  };
}

/** Lock escrow on one listing for the caller and wait briefly for delivery. */
export async function buyListing(
  deps: NeedDeps,
  organizationId: string,
  input: { listingId: string; input: Record<string, unknown> | null; buyerAgentId: string | null; waitMs?: number },
): Promise<NeedBuyResult> {
  const listing = deps.registry.get(input.listingId);
  if (!listing || listing.status !== "active") throw new ServiceError(404, "not_found", "Listing not found or paused.");
  const price = listing.pricing.amountUsdc;
  if (listing.pricing.model !== "free" && compareUsdc(price, MIN_PAID_LISTING_USDC) < 0) {
    throw new ServiceError(
      400,
      "price_too_low",
      `Listing price must be at least ${MIN_PAID_LISTING_USDC} USDC (Roster fee is 1% + 0.003 USDC).`,
    );
  }
  const examples = (listing.inputSchema as { examples?: unknown[] }).examples;
  const example = Array.isArray(examples) && typeof examples[0] === "object" && examples[0] !== null ? examples[0] : {};
  if (input.input && (listing.kind ?? "service") !== "service") {
    // Catch a wrong field name before money moves: the buyer would only get a refund.
    const required = (listing.inputSchema as { required?: unknown }).required;
    const missing = Array.isArray(required)
      ? required.filter((key): key is string => typeof key === "string" && (input.input?.[key] === undefined || input.input[key] === null))
      : [];
    if (missing.length > 0) {
      throw new ServiceError(
        400,
        "invalid_input",
        `Input is missing ${missing.join(", ")}. Example: ${JSON.stringify(example).slice(0, 300)}`,
      );
    }
  }
  const buyerAgentId = input.buyerAgentId ?? (await ensureBuyerAgent(deps.service, organizationId, price));
  if (input.buyerAgentId) {
    await deps.service.assertOwnedAgent(organizationId, input.buyerAgentId);
    const balance = await deps.service.getAgentBalance(organizationId, input.buyerAgentId);
    if (compareUsdc(balance.balanceUsdc, price) < 0) {
      throw new ServiceError(409, "insufficient_funds", `Agent balance ${balance.balanceUsdc} USDC is below the ${price} USDC price.`);
    }
  }
  const created = await deps.orchestrator.createJob(organizationId, {
    buyerAgentId,
    query: listing.name,
    amountUsdc: price,
    schema: listing.outputSchema,
    tags: [],
    maxP95Ms: null,
    memo: `Roster need: ${listing.name}`.slice(0, 200),
    input: input.input ?? example,
    listingId: listing.id,
  });
  let job = created.job;
  const deadline = Date.now() + (input.waitMs ?? BUY_WAIT_MS);
  while (job.status === "held" && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 150));
    job = (await deps.orchestrator.getJob(organizationId, job.id)).job;
  }
  return {
    job,
    status: job.status,
    delivered: job.status === "released",
    result: job.status === "released" ? job.result : null,
    receipt: {
      listingId: listing.id,
      listingName: listing.name,
      amountUsdc: job.amountUsdc,
      takeRateUsdc: job.takeRateUsdc,
      sellerNetUsdc: job.sellerNetUsdc,
      escrowId: job.escrowId,
      buyerAgentId,
      buyerBalanceUsdc: job.buyerBalanceUsdc,
      settledAt: job.settledAt,
    },
  };
}

/** Reuse the org's "Roster buyer" agent (or create it) and top it up from the treasury. */
async function ensureBuyerAgent(service: AgentFinanceService, organizationId: string, price: string): Promise<string> {
  const agents = await service.listAgents(organizationId);
  let agent = agents
    .filter((candidate) => candidate.name === NEED_BUYER_AGENT_NAME && candidate.status === "active")
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))[0];
  if (!agent) {
    agent = (
      await service.createAgent(organizationId, { name: NEED_BUYER_AGENT_NAME, dailySpendLimitUsdc: "100.00", vendorAllowlist: [] })
    ).agent;
  }
  const balance = await service.getAgentBalance(organizationId, agent.id);
  if (compareUsdc(balance.balanceUsdc, price) < 0) {
    const topUp = compareUsdc(price, NEED_BUYER_FLOAT_USDC) > 0 ? price : NEED_BUYER_FLOAT_USDC;
    await service.ensureSandboxTreasury(organizationId, topUp);
    await service.fundAgent(organizationId, agent.id, topUp);
  }
  return agent.id;
}
