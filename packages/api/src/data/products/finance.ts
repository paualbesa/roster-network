import { SOURCES } from "../sources.js";
import type { DataProductSpec, Json, Row } from "../types.js";
import { atomEntries, dedupe, fold, intIn, isoDate, numberOrNull, parseCsv, str, xmlAttr, xmlTag } from "../util.js";

const DAY = 86_400;

interface FrankfurterSeries {
  base: string;
  rates: Record<string, Record<string, number>>;
}

async function fxLatestRows(ctx: Parameters<NonNullable<DataProductSpec["ingest"]>>[0]): Promise<Row[]> {
  const latest = await ctx.fetchJson<{ base: string; date: string; rates: Record<string, number> }>(
    "https://api.frankfurter.dev/v1/latest?base=EUR",
  );
  const rows: Row[] = [{ currency: "EUR", rate_per_eur: 1, date: latest.date }];
  for (const [currency, rate] of Object.entries(latest.rates).sort()) {
    if (/^[A-Z]{3}$/.test(currency) && Number.isFinite(rate)) rows.push({ currency, rate_per_eur: rate, date: latest.date });
  }
  return rows;
}

function crossRate(rows: readonly Row[], base: string, quote: string): number | null {
  const find = (code: string): number | null => {
    if (code === "EUR") return 1;
    const row = rows.find((candidate) => candidate.currency === code);
    return typeof row?.rate_per_eur === "number" ? row.rate_per_eur : null;
  };
  const b = find(base);
  const q = find(quote);
  if (b === null || q === null || b === 0) return null;
  return Math.round((q / b) * 1e8) / 1e8;
}

function codes(input: Json, key: string): string[] {
  const value = input[key];
  const list = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  return list
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim().toUpperCase())
    .filter((item) => /^[A-Z]{3}$/.test(item))
    .slice(0, 40);
}

export const financeProducts: DataProductSpec[] = [
  {
    slug: "fx-latest",
    name: "FX rates — latest ECB reference (lookup)",
    kind: "lookup",
    description:
      "Latest euro foreign-exchange reference rates published by the European Central Bank for ~30 currencies, as cross rates against any base. Ask for USD→EUR, GBP→JPY, or a whole table. Refreshed every few hours; ECB publishes around 16:00 CET on TARGET days.",
    tags: ["fx", "exchange-rates", "currency", "ecb", "finance", "forex", "conversion"],
    sources: [SOURCES.ecbFrankfurter],
    cadence: "every 4 hours",
    intervalS: 4 * 3600,
    priceUsdc: "0.002",
    p95Ms: 4000,
    columns: [
      { name: "base", type: "string", description: "ISO 4217 base currency." },
      { name: "quote", type: "string", description: "ISO 4217 quote currency." },
      { name: "rate", type: "number", description: "Units of quote per 1 base." },
      { name: "date", type: "date", description: "ECB reference date." },
    ],
    input: {
      base: { type: "string", description: "Base currency, default EUR." },
      symbols: { type: "array", items: { type: "string" }, description: "Quote currencies; omit for all." },
    },
    required: [],
    example: { base: "USD", symbols: ["EUR", "GBP", "JPY"] },
    ingest: (ctx) => fxLatestRows(ctx),
    lookup: async (input, ctx) => {
      const rows = await ctx.rows();
      const base = codes(input, "base")[0] ?? "EUR";
      const wanted = codes(input, "symbols");
      const all = ["EUR", ...rows.map((row) => String(row.currency)).filter((code) => code !== "EUR")];
      const quotes = (wanted.length > 0 ? wanted : all).filter((code) => code !== base);
      return quotes.flatMap((quote) => {
        const rate = crossRate(rows, base, quote);
        return rate === null ? [] : [{ base, quote, rate, date: rows[0]?.date ?? null }];
      });
    },
  },
  {
    slug: "fx-history",
    name: "FX rates history 1999–today (ECB, daily, CSV)",
    kind: "dataset",
    description:
      "Every ECB euro reference rate since 4 January 1999: one row per TARGET business day, one column per currency (units per 1 EUR). Cleaned, deduplicated, wide format ready for pandas or Excel. Download as JSON or CSV via a signed URL.",
    tags: ["fx", "exchange-rates", "history", "time-series", "ecb", "currency", "dataset", "csv"],
    sources: [SOURCES.ecbFrankfurter],
    cadence: "daily",
    intervalS: DAY,
    priceUsdc: "0.05",
    p95Ms: 6000,
    columns: [
      { name: "date", type: "date", description: "ECB reference date." },
      { name: "<CCY>", type: "number", description: "One column per ISO 4217 currency: units per 1 EUR (null before the currency was quoted)." },
    ],
    ingest: async (ctx, previous) => {
      const today = isoDate(ctx.now());
      const endYear = Number(today.slice(0, 4));
      // Closed years never change: keep them and refetch only the current (and previous) year.
      const keepBefore = `${(endYear - 1).toString()}-01-01`;
      const rows: Row[] = previous.filter((row) => String(row.date) < keepBefore);
      const cachedYears = new Set(rows.map((row) => String(row.date).slice(0, 4)));
      // Frankfurter returns weekly samples for very long ranges, so fetch year by year.
      for (let year = 1999; year <= endYear; year += 1) {
        if (year < endYear - 1 && cachedYears.has(year.toString())) continue;
        const from = year === 1999 ? "1999-01-04" : `${year.toString()}-01-01`;
        const to = year === endYear ? today : `${year.toString()}-12-31`;
        const series = await ctx.fetchJson<FrankfurterSeries>(`https://api.frankfurter.dev/v1/${from}..${to}?base=EUR`);
        for (const [date, rates] of Object.entries(series.rates)) {
          const row: Row = { date };
          for (const [currency, rate] of Object.entries(rates)) if (Number.isFinite(rate)) row[currency] = rate;
          rows.push(row);
        }
        await ctx.sleep(250);
      }
      const currencies = [...new Set(rows.flatMap((row) => Object.keys(row).filter((key) => key !== "date")))].sort();
      return dedupe(rows, (row) => String(row.date))
        .sort((left, right) => String(left.date).localeCompare(String(right.date)))
        .map((row) => {
          const out: Row = { date: row.date ?? null };
          for (const currency of currencies) out[currency] = row[currency] ?? null;
          return out;
        });
    },
  },
  {
    slug: "fx-convert",
    name: "Currency converter — historical ECB rate on any date (lookup)",
    kind: "lookup",
    description:
      "Convert an amount between ~30 currencies at the ECB reference rate for a given date (or the latest). Uses the last business day on or before the date. Good for invoices, expense reports, and accounting in another currency.",
    tags: ["fx", "currency", "conversion", "historical", "ecb", "accounting", "invoice"],
    sources: [SOURCES.ecbFrankfurter],
    cadence: "daily",
    intervalS: DAY,
    priceUsdc: "0.001",
    p95Ms: 6000,
    columns: [
      { name: "amount", type: "number", description: "Input amount." },
      { name: "from", type: "string", description: "Source currency." },
      { name: "to", type: "string", description: "Target currency." },
      { name: "date", type: "date", description: "Rate date used." },
      { name: "rate", type: "number", description: "Units of `to` per 1 `from`." },
      { name: "converted", type: "number", description: "amount × rate, 4 decimals." },
    ],
    input: {
      amount: { type: "number" },
      from: { type: "string" },
      to: { type: "string" },
      date: { type: "string", description: "YYYY-MM-DD, default latest." },
    },
    required: ["amount", "from", "to"],
    example: { amount: 1250, from: "USD", to: "EUR", date: "2024-03-15" },
    lookup: async (input, ctx) => {
      const history = await ctx.rowsOf("fx-history");
      const from = codes(input, "from")[0];
      const to = codes(input, "to")[0];
      const amount = numberOrNull(input.amount);
      if (!from || !to || amount === null || history.length === 0) return [];
      const wanted = /^\d{4}-\d{2}-\d{2}$/.test(str(input, "date")) ? str(input, "date") : "9999-12-31";
      let row: Row | undefined;
      for (let index = history.length - 1; index >= 0; index -= 1) {
        const candidate = history[index];
        if (candidate && String(candidate.date) <= wanted) {
          row = candidate;
          break;
        }
      }
      if (!row) return [];
      const perEur = (code: string): number | null => (code === "EUR" ? 1 : typeof row[code] === "number" ? (row[code] as number) : null);
      const f = perEur(from);
      const t = perEur(to);
      if (f === null || t === null || f === 0) return [];
      const rate = Math.round((t / f) * 1e8) / 1e8;
      return [{ amount, from, to, date: row.date ?? null, rate, converted: Math.round(amount * rate * 1e4) / 1e4 }];
    },
  },
  {
    slug: "estr",
    name: "€STR euro short-term rate — daily history (ECB)",
    kind: "dataset",
    description:
      "The euro short-term rate (€STR) published by the ECB every TARGET business day since October 2019: the overnight unsecured borrowing benchmark that replaced EONIA. Clean date/rate table.",
    tags: ["estr", "interest-rates", "ecb", "benchmark", "money-market", "euro", "time-series"],
    sources: [SOURCES.ecbDataPortal],
    cadence: "daily",
    intervalS: DAY / 2,
    priceUsdc: "0.01",
    p95Ms: 6000,
    columns: [
      { name: "date", type: "date", description: "Reference date." },
      { name: "rate_pct", type: "number", description: "€STR volume-weighted trimmed mean, percent." },
    ],
    ingest: async (ctx) => {
      const csv = await ctx.fetchText(
        "https://data-api.ecb.europa.eu/service/data/EST/B.EU000A2X2A25.WT?format=csvdata&detail=dataonly",
      );
      return dedupe(
        parseCsv(csv).flatMap((record) => {
          const rate = numberOrNull(record.OBS_VALUE);
          return record.TIME_PERIOD && rate !== null ? [{ date: record.TIME_PERIOD, rate_pct: rate }] : [];
        }),
        (row) => String(row.date),
      ).sort((left, right) => String(left.date).localeCompare(String(right.date)));
    },
  },
  {
    slug: "ecb-policy-rates",
    name: "ECB key policy rates — every change since 1999",
    kind: "dataset",
    description:
      "Every change to the ECB's three key interest rates since 1999: deposit facility, main refinancing operations, and marginal lending facility. One row per effective date with all three levels.",
    tags: ["ecb", "interest-rates", "monetary-policy", "central-bank", "euro", "deposit-rate"],
    sources: [SOURCES.ecbDataPortal],
    cadence: "daily",
    intervalS: DAY,
    priceUsdc: "0.01",
    p95Ms: 6000,
    columns: [
      { name: "effective_date", type: "date", description: "Date the new levels apply." },
      { name: "deposit_facility_pct", type: "number", description: "Deposit facility rate." },
      { name: "main_refinancing_pct", type: "number", description: "MRO fixed/minimum bid rate." },
      { name: "marginal_lending_pct", type: "number", description: "Marginal lending facility rate." },
    ],
    ingest: async (ctx) => {
      const csv = await ctx.fetchText(
        "https://data-api.ecb.europa.eu/service/data/FM/D.U2.EUR.4F.KR.MRR_FR+DFR+MLFR.LEV?format=csvdata&detail=dataonly&startPeriod=1999-01-01",
      );
      const byDate = new Map<string, Row>();
      for (const record of parseCsv(csv)) {
        const value = numberOrNull(record.OBS_VALUE);
        const date = record.TIME_PERIOD;
        if (!date || value === null) continue;
        const column =
          record.PROVIDER_FM_ID === "DFR" ? "deposit_facility_pct" : record.PROVIDER_FM_ID === "MLFR" ? "marginal_lending_pct" : "main_refinancing_pct";
        const row = byDate.get(date) ?? { effective_date: date };
        row[column] = value;
        byDate.set(date, row);
      }
      const ordered = [...byDate.values()].sort((left, right) => String(left.effective_date).localeCompare(String(right.effective_date)));
      const changes: Row[] = [];
      let last = "";
      let carry: Row = {};
      for (const row of ordered) {
        carry = { ...carry, ...row };
        const levels: Row = {
          effective_date: row.effective_date ?? null,
          deposit_facility_pct: carry.deposit_facility_pct ?? null,
          main_refinancing_pct: carry.main_refinancing_pct ?? null,
          marginal_lending_pct: carry.marginal_lending_pct ?? null,
        };
        const signature = `${String(levels.deposit_facility_pct)}|${String(levels.main_refinancing_pct)}|${String(levels.marginal_lending_pct)}`;
        if (signature !== last) changes.push(levels);
        last = signature;
      }
      return changes;
    },
  },
  {
    slug: "us-treasury-yields",
    name: "US Treasury par yield curve — daily since 2015",
    kind: "dataset",
    description:
      "Daily U.S. Treasury par yield curve rates (1-month to 30-year) from the Treasury Department, 2015 to today, merged across yearly files into one clean table with consistent column names.",
    tags: ["treasury", "yield-curve", "bonds", "interest-rates", "usa", "fixed-income", "time-series"],
    sources: [SOURCES.usTreasury],
    cadence: "daily",
    intervalS: DAY / 2,
    priceUsdc: "0.02",
    p95Ms: 6000,
    columns: [
      { name: "date", type: "date", description: "Business day." },
      ...["1m", "2m", "3m", "4m", "6m", "1y", "2y", "3y", "5y", "7y", "10y", "20y", "30y"].map((tenor) => ({
        name: `y_${tenor}`,
        type: "number" as const,
        description: `${tenor} par yield, percent.`,
      })),
    ],
    ingest: async (ctx, previous) => {
      const tenors: Record<string, string> = {
        "1 Mo": "y_1m",
        "2 Mo": "y_2m",
        "3 Mo": "y_3m",
        "4 Mo": "y_4m",
        "6 Mo": "y_6m",
        "1 Yr": "y_1y",
        "2 Yr": "y_2y",
        "3 Yr": "y_3y",
        "5 Yr": "y_5y",
        "7 Yr": "y_7y",
        "10 Yr": "y_10y",
        "20 Yr": "y_20y",
        "30 Yr": "y_30y",
      };
      const endYear = ctx.now().getUTCFullYear();
      // Each yearly file takes ~20 s to generate upstream: reuse closed years from the last refresh.
      const keepBefore = `${(endYear - 1).toString()}-01-01`;
      const rows: Row[] = previous.filter((row) => String(row.date) < keepBefore);
      const cachedYears = new Set(rows.map((row) => String(row.date).slice(0, 4)));
      for (let year = 2015; year <= endYear; year += 1) {
        if (year < endYear - 1 && cachedYears.has(year.toString())) continue;
        const url = `https://home.treasury.gov/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv/${year.toString()}/all?type=daily_treasury_yield_curve&field_tdr_date_value=${year.toString()}&page&_format=csv`;
        const csv = await ctx.fetchText(url);
        for (const record of parseCsv(csv)) {
          const [month, day, yyyy] = (record.Date ?? "").split("/");
          if (!month || !day || !yyyy) continue;
          const row: Row = { date: `${yyyy}-${month.padStart(2, "0")}-${day.padStart(2, "0")}` };
          for (const [label, column] of Object.entries(tenors)) row[column] = numberOrNull(record[label]);
          rows.push(row);
        }
        await ctx.sleep(500);
      }
      return dedupe(rows, (row) => String(row.date)).sort((left, right) => String(left.date).localeCompare(String(right.date)));
    },
  },
  {
    slug: "sec-tickers",
    name: "SEC company ticker → CIK lookup",
    kind: "lookup",
    description:
      "Resolve a US-listed company ticker or name to its SEC CIK (Central Index Key) and official EDGAR name. ~10,000 issuers, refreshed daily from the SEC's company_tickers file. Use it before pulling filings.",
    tags: ["sec", "edgar", "ticker", "cik", "stocks", "companies", "usa", "equities"],
    sources: [SOURCES.secEdgar],
    cadence: "daily",
    intervalS: DAY,
    priceUsdc: "0.001",
    p95Ms: 4000,
    columns: [
      { name: "ticker", type: "string", description: "Exchange ticker." },
      { name: "cik", type: "integer", description: "SEC Central Index Key." },
      { name: "cik10", type: "string", description: "CIK zero-padded to 10 digits (EDGAR URLs)." },
      { name: "name", type: "string", description: "Company name in EDGAR." },
    ],
    input: { query: { type: "string", description: "Ticker (AAPL) or part of a company name." }, limit: { type: "integer" } },
    required: ["query"],
    example: { query: "NVDA" },
    ingest: async (ctx) => {
      const data = await ctx.fetchJson<Record<string, { cik_str: number; ticker: string; title: string }>>(
        "https://www.sec.gov/files/company_tickers.json",
      );
      return dedupe(
        Object.values(data).map((entry) => ({
          ticker: entry.ticker.toUpperCase(),
          cik: entry.cik_str,
          cik10: entry.cik_str.toString().padStart(10, "0"),
          name: entry.title,
        })),
        (row) => String(row.ticker),
      );
    },
    lookup: async (input, ctx) => {
      const rows = await ctx.rows();
      const query = str(input, "query", 120);
      if (!query) return [];
      const limit = intIn(input, "limit", 10, 1, 50);
      const upper = query.toUpperCase();
      const exact = rows.filter((row) => row.ticker === upper || String(row.cik) === query.replace(/^0+/, ""));
      const folded = fold(query);
      const named = rows.filter((row) => !exact.includes(row) && fold(String(row.name)).includes(folded));
      return [...exact, ...named].slice(0, limit);
    },
  },
  {
    slug: "sec-filings-feed",
    name: "SEC EDGAR new filings feed (8-K, 10-K, 10-Q, S-1, 6-K, 20-F)",
    kind: "feed",
    description:
      "Rolling 14-day feed of new SEC EDGAR filings for corporate forms 8-K, 10-K, 10-Q, S-1, 6-K and 20-F: company, CIK, form, filing time, reported 8-K items, and the EDGAR index link. Filter by form, search by company, or ask for everything since a timestamp.",
    tags: ["sec", "edgar", "filings", "8-k", "10-k", "earnings", "corporate-events", "feed", "stocks"],
    sources: [SOURCES.secEdgar],
    cadence: "hourly",
    intervalS: 3600,
    priceUsdc: "0.005",
    p95Ms: 4000,
    timeField: "updated_at",
    idField: "id",
    retainDays: 14,
    maxRows: 8000,
    filterFields: ["form", "cik"],
    columns: [
      { name: "id", type: "string", description: "Accession number + CIK." },
      { name: "form", type: "string", description: "Form type." },
      { name: "company", type: "string", description: "Filer name." },
      { name: "cik", type: "string", description: "Filer CIK." },
      { name: "filed_on", type: "date", description: "Filing date." },
      { name: "updated_at", type: "datetime", description: "Accepted time (ISO 8601)." },
      { name: "items", type: "string", description: "Reported items (8-K), semicolon-separated." },
      { name: "url", type: "string", description: "EDGAR filing index URL." },
    ],
    ingest: async (ctx) => {
      const rows: Row[] = [];
      for (const form of ["8-K", "10-K", "10-Q", "S-1", "6-K", "20-F"]) {
        const xml = await ctx.fetchText(
          `https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=${encodeURIComponent(form)}&count=100&output=atom`,
        );
        for (const entry of atomEntries(xml)) {
          const title = xmlTag(entry, "title") ?? "";
          const match = /^(\S+)\s+-\s+(.+?)\s+\((\d{10})\)/.exec(title);
          if (!match) continue;
          const [, entryForm, company, cik] = match;
          const summary = xmlTag(entry, "summary") ?? "";
          const accession = /AccNo:\s*<\/b>\s*([\d-]+)/.exec(summary)?.[1] ?? /accession-number=([\d-]+)/.exec(entry)?.[1] ?? "";
          const filed = /Filed:\s*<\/b>\s*(\d{4}-\d{2}-\d{2})/.exec(summary)?.[1] ?? null;
          const items = [...summary.matchAll(/Item\s+([\d.]+):\s*([^<]+)/g)].map((item) => `${item[1] ?? ""} ${(item[2] ?? "").trim()}`);
          const updated = xmlTag(entry, "updated");
          rows.push({
            id: `${accession}:${cik ?? ""}`,
            form: entryForm ?? form,
            company: company ?? null,
            cik: cik ?? null,
            filed_on: filed,
            updated_at: updated ? new Date(updated).toISOString() : null,
            items: items.length > 0 ? items.join("; ") : null,
            url: xmlAttr(entry, "link", "href"),
          });
        }
        await ctx.sleep(300);
      }
      return rows;
    },
  },
];
