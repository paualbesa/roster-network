import { SOURCES } from "../sources.js";
import type { DataFetchContext, DataProductSpec, Row } from "../types.js";
import { atomEntries, daysAgo, intIn, str, textOrNull, xmlAttr, xmlTag, xmlTags } from "../util.js";


// arXiv asks for at most one request every 3 seconds on a single connection.
let arxivLast = 0;
let arxivChain: Promise<unknown> = Promise.resolve();
async function arxivFetch(ctx: DataFetchContext, url: string): Promise<string> {
  const run = arxivChain.then(async () => {
    const wait = arxivLast + 6000 - Date.now();
    if (wait > 0) await ctx.sleep(wait);
    try {
      return await ctx.fetchText(url, { timeoutMs: 60_000 });
    } catch (error) {
      if (!(error instanceof Error) || !/answered 429/.test(error.message)) throw error;
      // Back off hard once; the next scheduled refresh retries otherwise.
      await ctx.sleep(45_000);
      return await ctx.fetchText(url, { timeoutMs: 60_000 });
    } finally {
      arxivLast = Date.now();
    }
  });
  arxivChain = run.catch(() => undefined);
  return run;
}

const ARXIV_CATEGORIES: { cat: string; label: string; tags: string[] }[] = [
  { cat: "cs.AI", label: "Artificial Intelligence", tags: ["ai", "artificial-intelligence", "agents"] },
  { cat: "cs.LG", label: "Machine Learning", tags: ["machine-learning", "ml", "deep-learning"] },
  { cat: "cs.CL", label: "Computation and Language (NLP/LLMs)", tags: ["nlp", "llm", "language-models"] },
  { cat: "cs.CR", label: "Cryptography and Security", tags: ["security", "cryptography", "privacy"] },
  { cat: "cs.RO", label: "Robotics", tags: ["robotics", "embodied-ai"] },
  { cat: "q-fin.ST", label: "Statistical Finance", tags: ["quant-finance", "finance", "econometrics"] },
];

function arxivDigest(category: (typeof ARXIV_CATEGORIES)[number]): DataProductSpec {
  return {
    slug: `arxiv-${category.cat.toLowerCase().replace(/[^a-z]/g, "-")}`,
    name: `arXiv new papers digest — ${category.cat} ${category.label}`,
    kind: "feed",
    description: `Rolling 30-day digest of new arXiv submissions in ${category.cat} (${category.label}): title, authors, abstract, categories, submission and update times, and PDF/abstract links. Metadata only, refreshed twice a day — skip scraping arXiv yourself.`,
    tags: [...category.tags, "arxiv", "papers", "research", "preprints", "digest", "feed", "science"],
    sources: [SOURCES.arxiv],
    cadence: "every 12 hours",
    intervalS: 12 * 3600,
    priceUsdc: "0.01",
    p95Ms: 4000,
    timeField: "published_at",
    idField: "arxiv_id",
    retainDays: 30,
    maxRows: 6000,
    filterFields: ["primary_category"],
    columns: [
      { name: "arxiv_id", type: "string", description: "arXiv id without version." },
      { name: "title", type: "string", description: "Title." },
      { name: "authors", type: "string", description: "Authors as listed on the paper, semicolon-separated." },
      { name: "abstract", type: "string", description: "Abstract (truncated to 2,000 chars)." },
      { name: "primary_category", type: "string", description: "Primary category." },
      { name: "categories", type: "string", description: "All categories." },
      { name: "published_at", type: "datetime", description: "First version submitted." },
      { name: "updated_at", type: "datetime", description: "Latest version." },
      { name: "abs_url", type: "string", description: "Abstract page." },
      { name: "pdf_url", type: "string", description: "PDF link." },
    ],
    ingest: async (ctx) => {
      const xml = await arxivFetch(
        ctx,
        `https://export.arxiv.org/api/query?search_query=cat:${encodeURIComponent(category.cat)}&sortBy=submittedDate&sortOrder=descending&start=0&max_results=200`,
      );
      return atomEntries(xml).flatMap((entry) => {
        const idUrl = xmlTag(entry, "id") ?? "";
        const id = /abs\/(.+?)(v\d+)?$/.exec(idUrl)?.[1];
        if (!id) return [];
        return [
          {
            arxiv_id: id,
            title: xmlTag(entry, "title"),
            authors: xmlTags(entry, "name").join("; ") || null,
            abstract: textOrNull(xmlTag(entry, "summary"), 2000),
            primary_category: xmlAttr(entry, "arxiv:primary_category", "term") ?? category.cat,
            categories: [...entry.matchAll(/<category[^>]*term="([^"]+)"/g)].map((match) => match[1]).join(";") || null,
            published_at: xmlTag(entry, "published"),
            updated_at: xmlTag(entry, "updated"),
            abs_url: `https://arxiv.org/abs/${id}`,
            pdf_url: `https://arxiv.org/pdf/${id}`,
          },
        ];
      });
    },
  };
}

const MAIN_PAGES = new Set(["Main_Page", "Portada", "Wikipedia:Portada", "Pàgina_principal", "-"]);

function wikipediaTop(lang: "en" | "es" | "ca", label: string): DataProductSpec {
  return {
    slug: `wikipedia-top-${lang}`,
    name: `Trending Wikipedia articles — ${label} (daily top 100)`,
    kind: "feed",
    description: `The 100 most-read ${label} Wikipedia articles each day (special pages removed), with view counts, for the last 30 days. A clean signal of what the public is paying attention to — news, culture, search demand.`,
    tags: ["wikipedia", "trending", "pageviews", "attention", "news", "popularity", lang, "feed"],
    sources: [SOURCES.wikimediaPageviews],
    cadence: "daily",
    intervalS: 6 * 3600,
    priceUsdc: "0.01",
    p95Ms: 4000,
    timeField: "date",
    idField: "id",
    retainDays: 30,
    maxRows: 3100,
    filterFields: ["date"],
    columns: [
      { name: "id", type: "string", description: "date:article." },
      { name: "date", type: "date", description: "Day (UTC)." },
      { name: "rank", type: "integer", description: "Rank that day (1 = most read)." },
      { name: "title", type: "string", description: "Article title." },
      { name: "views", type: "integer", description: "Views (all access)." },
      { name: "url", type: "string", description: "Article URL." },
    ],
    ingest: async (ctx, previous) => {
      const rows: Row[] = [];
      const have = new Set(previous.map((row) => String(row.date)));
      for (let back = 1; back <= (previous.length === 0 ? 7 : 3); back += 1) {
        const day = daysAgo(ctx.now(), back);
        const date = day.toISOString().slice(0, 10);
        if (have.has(date)) continue;
        const [yyyy, mm, dd] = date.split("-");
        let data: { items: { articles: { article: string; views: number; rank: number }[] }[] };
        try {
          data = await ctx.fetchJson(
            `https://wikimedia.org/api/rest_v1/metrics/pageviews/top/${lang}.wikipedia/all-access/${yyyy ?? ""}/${mm ?? ""}/${dd ?? ""}`,
          );
        } catch {
          continue; // Not published yet for that day.
        }
        let rank = 0;
        for (const article of data.items[0]?.articles ?? []) {
          if (rank >= 100) break;
          if (MAIN_PAGES.has(article.article)) continue;
          if (/^(Special|Especial|Wikipedia|Viquipèdia|Main_Page|Portada|Portal|File|Archivo|Fitxer|Categoría|Categoria|Category|Ayuda|Help|Ajuda)[:_]/.test(article.article) || article.article === "Main_Page" || article.article === "-") continue;
          rank += 1;
          rows.push({
            id: `${date}:${article.article}`,
            date,
            rank,
            title: article.article.replace(/_/g, " "),
            views: article.views,
            url: `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(article.article)}`,
          });
        }
        await ctx.sleep(200);
      }
      return rows;
    },
  };
}

export const researchProducts: DataProductSpec[] = [
  ...ARXIV_CATEGORIES.map((category) => arxivDigest(category)),
  wikipediaTop("en", "English"),
  wikipediaTop("es", "Spanish"),
  wikipediaTop("ca", "Catalan"),
  {
    slug: "wikidata-entity",
    name: "Entity lookup — Wikidata ids, descriptions, Wikipedia links (live)",
    kind: "lookup",
    description:
      "Resolve any name (company, person of public note, place, product, concept) to Wikidata entities: QID, label, description, aliases and English Wikipedia URL. Use it to disambiguate and link entities in agent pipelines. Live query, CC0 data.",
    tags: ["wikidata", "entity-linking", "knowledge-graph", "disambiguation", "ner", "lookup"],
    sources: [SOURCES.wikidata],
    cadence: "live",
    intervalS: 3600,
    priceUsdc: "0.01",
    p95Ms: 8000,
    live: true,
    columns: [
      { name: "id", type: "string", description: "Wikidata QID." },
      { name: "label", type: "string", description: "Label in the requested language." },
      { name: "description", type: "string", description: "Short description." },
      { name: "aliases", type: "string", description: "Aliases." },
      { name: "wikipedia_url", type: "string", description: "English Wikipedia article." },
      { name: "wikidata_url", type: "string", description: "Wikidata page." },
    ],
    input: {
      query: { type: "string" },
      language: { type: "string", description: "Label language, default en." },
      limit: { type: "integer" },
    },
    required: ["query"],
    example: { query: "Barcelona Supercomputing Center" },
    lookup: async (input, ctx) => {
      const query = str(input, "query", 200);
      const language = /^[a-z]{2,3}$/.test(str(input, "language")) ? str(input, "language") : "en";
      if (!query) return [];
      const search = await ctx.fetchJson<{ search: { id: string; label?: string; description?: string; aliases?: string[] }[] }>(
        `https://www.wikidata.org/w/api.php?action=wbsearchentities&format=json&type=item&language=${language}&uselang=${language}&limit=${intIn(input, "limit", 5, 1, 10).toString()}&search=${encodeURIComponent(query)}`,
        { timeoutMs: 6000 },
      );
      const ids = search.search.map((hit) => hit.id).filter((id) => /^Q\d+$/.test(id));
      const links: Record<string, string> = {};
      if (ids.length > 0) {
        const entities = await ctx.fetchJson<{ entities: Record<string, { sitelinks?: { enwiki?: { title: string } } }> }>(
          `https://www.wikidata.org/w/api.php?action=wbgetentities&format=json&props=sitelinks&sitefilter=enwiki&ids=${ids.join("|")}`,
          { timeoutMs: 6000 },
        );
        for (const [id, entity] of Object.entries(entities.entities)) {
          const title = entity.sitelinks?.enwiki?.title;
          if (title) links[id] = `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, "_"))}`;
        }
      }
      return search.search.map((hit) => ({
        id: hit.id,
        label: textOrNull(hit.label ?? null),
        description: textOrNull(hit.description ?? null),
        aliases: (hit.aliases ?? []).join("; ") || null,
        wikipedia_url: links[hit.id] ?? null,
        wikidata_url: `https://www.wikidata.org/wiki/${hit.id}`,
      }));
    },
  },
  {
    slug: "gleif-lei",
    name: "Company LEI lookup — legal name, jurisdiction, status (GLEIF, live)",
    kind: "lookup",
    description:
      "Find a legal entity's LEI (Legal Entity Identifier) by name or LEI code: official legal name, jurisdiction, legal-address city and country, entity status, registration status and next renewal date. For KYB, invoicing and counterparty checks. Live GLEIF query, CC0.",
    tags: ["lei", "gleif", "kyb", "companies", "legal-entity", "compliance", "counterparty", "lookup"],
    sources: [SOURCES.gleif],
    cadence: "live",
    intervalS: 3600,
    priceUsdc: "0.01",
    p95Ms: 8000,
    live: true,
    columns: [
      { name: "lei", type: "string", description: "20-character LEI." },
      { name: "legal_name", type: "string", description: "Legal name." },
      { name: "jurisdiction", type: "string", description: "Legal jurisdiction." },
      { name: "city", type: "string", description: "Legal address city." },
      { name: "country", type: "string", description: "Legal address country." },
      { name: "entity_status", type: "string", description: "ACTIVE / INACTIVE." },
      { name: "registration_status", type: "string", description: "ISSUED, LAPSED…" },
      { name: "category", type: "string", description: "Entity category." },
      { name: "next_renewal", type: "datetime", description: "Next renewal date." },
    ],
    input: { query: { type: "string", description: "Company name or LEI." }, limit: { type: "integer" } },
    required: ["query"],
    example: { query: "Telefonica SA" },
    lookup: async (input, ctx) => {
      const query = str(input, "query", 200);
      if (!query) return [];
      type Record = {
        attributes: {
          lei: string;
          entity: {
            legalName: { name: string };
            jurisdiction?: string;
            legalAddress?: { city?: string; country?: string };
            status?: string;
            category?: string;
          };
          registration: { status?: string; nextRenewalDate?: string };
        };
      };
      const isLei = /^[A-Z0-9]{18}[0-9]{2}$/.test(query.toUpperCase());
      const url = isLei
        ? `https://api.gleif.org/api/v1/lei-records/${query.toUpperCase()}`
        : `https://api.gleif.org/api/v1/lei-records?filter%5Bfulltext%5D=${encodeURIComponent(query)}&page%5Bsize%5D=${intIn(input, "limit", 5, 1, 20).toString()}`;
      const data = await ctx.fetchJson<{ data: Record | Record[] }>(url, { timeoutMs: 7000 });
      const records = Array.isArray(data.data) ? data.data : [data.data];
      return records.map(({ attributes }) => ({
        lei: attributes.lei,
        legal_name: textOrNull(attributes.entity.legalName.name),
        jurisdiction: textOrNull(attributes.entity.jurisdiction ?? null),
        city: textOrNull(attributes.entity.legalAddress?.city ?? null),
        country: textOrNull(attributes.entity.legalAddress?.country ?? null),
        entity_status: textOrNull(attributes.entity.status ?? null),
        registration_status: textOrNull(attributes.registration.status ?? null),
        category: textOrNull(attributes.entity.category ?? null),
        next_renewal: attributes.registration.nextRenewalDate ?? null,
      }));
    },
  },
];
